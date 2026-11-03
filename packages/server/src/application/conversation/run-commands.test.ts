import { describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@rolecast/contract'

import type {
  AgentRuntimeConnection,
  AgentRuntimeConnectionInput,
  AgentRuntimePort,
  AgentRuntimeSession,
  AgentTurnDispatchSignal,
} from '../ports/agent-runtime-port.js'
import type { ProviderDefinitionPort } from '../ports/id-generator-port.js'
import { systemClock } from '../ports/clock-port.js'
import { InProcessEventBus } from '../../infrastructure/events/in-process-event-bus.js'
import { SqliteDatabase } from '../../infrastructure/persistence/sqlite-database.js'
import { SqliteRepository } from '../../infrastructure/persistence/sqlite-repository.js'
import { SecretRedactor } from '../../infrastructure/credentials/file-credential-store.js'
import { PermissionScheduler } from '../permission/permission-scheduler.js'
import { SessionService } from '../sessions/session-service.js'
import { ConversationService } from './conversation-service.js'
import { ConversationTurnRunner } from './conversation-turn-runner.js'

const timestamp = '2026-10-14T10:00:00.000Z'

class TestIds {
  private sequence = 0
  next(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }
}

/** 可控 Runtime：记录 dispatch 次数，可让 sendTurn 立即失败或阻塞。 */
class FakeRuntime implements AgentRuntimePort {
  sendTurns = 0
  cancelTurns = 0
  resumes = 0
  createdSessions = 0
  connections = 0
  closedSessions = 0
  closedConnections = 0
  failNextDispatch = false
  /** true 时下一个 turn 在发出 dispatch 信号前失败（迭代器启动失败）。 */
  failBeforeDispatchNext = false
  /** true 时 turn 在 dispatch 信号前阻塞，便于观察回执边界。 */
  blockBeforeDispatch = false
  /** true 时 turn 阻塞到 cancelTurn，再发出 turn_cancelled。 */
  blockTurns = false
  /** true 时迭代器正常结束，但既不触发 dispatch 信号也不产生事件。 */
  emptyTurns = false
  /** false 时 cancelTurn 只做通知，不结束 turn。 */
  cancelEndsTurn = true
  private readonly pendingTurns: Array<() => void> = []
  private resolveTurnStarted: (() => void) | null = null
  private readonly turnStartedPromise = new Promise<void>((resolve) => {
    this.resolveTurnStarted = resolve
  })
  private resolveBeforeDispatchEntered: (() => void) | null = null
  private readonly beforeDispatchEnteredPromise = new Promise<void>((resolve) => {
    this.resolveBeforeDispatchEntered = resolve
  })
  private releaseBeforeDispatchGate: (() => void) | null = null

  /** 等待阻塞的 turn 真正开始。 */
  turnStarted(): Promise<void> {
    return this.turnStartedPromise
  }

  /** 等待 turn 进入 dispatch 前的阻塞点。 */
  beforeDispatchStarted(): Promise<void> {
    return this.beforeDispatchEnteredPromise
  }

  /** 放行 dispatch 前的阻塞。 */
  releaseBeforeDispatch(): void {
    this.releaseBeforeDispatchGate?.()
    this.releaseBeforeDispatchGate = null
  }

  /** 放行所有阻塞中的 turn。 */
  releaseTurns(): void {
    for (const resolve of this.pendingTurns.splice(0)) {
      resolve()
    }
  }
  private readonly connection: AgentRuntimeConnection = {
    connectionId: 'connection-001',
    providerKind: 'claude',
    adapterVersion: '0.90.0',
    capabilities: {
      provider_kind: 'claude',
      adapter_version: '0.90.0',
      source: 'manual',
      observed_at: timestamp,
      capabilities: {},
    },
  }

  async connect(_input: AgentRuntimeConnectionInput): Promise<AgentRuntimeConnection> {
    this.connections += 1
    return { ...this.connection, connectionId: `connection-${this.connections}` }
  }

  async createSession(): Promise<AgentRuntimeSession> {
    this.createdSessions += 1
    return {
      sessionId: `acp-session-${this.createdSessions}`,
      connection: { ...this.connection, connectionId: `connection-${this.connections}` },
      configOptions: [{ id: 'model', category: 'model', currentValue: 'model-a', options: [{ value: 'model-a' }] }],
    }
  }

  async resumeSession(_connection: AgentRuntimeConnection, sessionId: string): Promise<AgentRuntimeSession> {
    this.resumes += 1
    return {
      sessionId,
      connection: this.connection,
      configOptions: [{ id: 'model', category: 'model', currentValue: 'model-a', options: [{ value: 'model-a' }] }],
    }
  }

  sendTurn(_input: unknown, dispatch?: AgentTurnDispatchSignal): AsyncIterable<RuntimeEvent> {
    this.sendTurns += 1
    if (this.failNextDispatch) {
      this.failNextDispatch = false
      throw new Error('adapter failed before dispatch')
    }
    const failBeforeDispatch = this.failBeforeDispatchNext
    this.failBeforeDispatchNext = false
    const blockBeforeDispatch = this.blockBeforeDispatch
    const empty = this.emptyTurns
    const block = this.blockTurns
    const pendingTurns = this.pendingTurns
    const onDispatched = dispatch?.onDispatched
    const markStarted = (): void => {
      this.resolveTurnStarted?.()
      this.resolveTurnStarted = null
    }
    const markBeforeDispatchEntered = (): void => {
      this.resolveBeforeDispatchEntered?.()
      this.resolveBeforeDispatchEntered = null
    }
    const holdBeforeDispatch = (): Promise<void> => new Promise<void>((resolve) => {
      this.releaseBeforeDispatchGate = resolve
    })
    return (async function* (): AsyncIterable<RuntimeEvent> {
      if (failBeforeDispatch) {
        // 尚未越过 dispatch 边界：Runtime 没有写出 session/prompt。
        throw new Error('adapter failed before dispatch')
      }
      if (blockBeforeDispatch) {
        markBeforeDispatchEntered()
        await holdBeforeDispatch()
      }
      if (empty) {
        // 正常结束，但没有 dispatch 信号，也没有任何 Runtime 事件。
        return
      }
      onDispatched?.()
      if (block) {
        markStarted()
        await new Promise<void>((resolve) => {
          pendingTurns.push(resolve)
        })
        yield {
          session_id: 'acp-session-001',
          kind: 'turn_cancelled',
          payload: {},
        }
        return
      }
      yield {
        session_id: 'acp-session-001',
        kind: 'turn_completed',
        payload: {},
      }
    })()
  }

  async respondPermission(): Promise<void> {}
  async cancelTurn(): Promise<void> {
    this.cancelTurns += 1
    if (this.cancelEndsTurn) {
      this.releaseTurns()
    }
  }
  async closeSession(): Promise<void> {
    this.closedSessions += 1
  }
  async closeConnection(): Promise<void> {
    this.closedConnections += 1
  }
}

const definitions: ProviderDefinitionPort = {
  get: () => ({
    adapterCommand: '/fake/adapter',
    adapterArgs: ['entry.js'],
    adapterVersion: '0.90.0',
    credentialEnvironmentKey: 'ANTHROPIC_API_KEY',
  }),
  fingerprint: async () => 'fp-test',
}

const environment = {
  cwd: '/tmp/rolecast-work',
  environment: {},
  runtimeDirectory: (connectionId: string) => `/tmp/rolecast-runtime/${connectionId}`,
}

const setup = async () => {
  const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
  await repository.createWorkspace({
    id: 'workspace-001', name: '命令工作区', created_at: timestamp, updated_at: timestamp,
  })
  await repository.createProviderConnection({
    id: 'provider-001',
    workspace_id: 'workspace-001',
    provider_kind: 'claude',
    connection_kind: 'local',
    environment_mode: 'inherited',
    config_revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
  })
  const runtime = new FakeRuntime()
  const ids = new TestIds()
  const sessions = new SessionService(repository, runtime, ids, systemClock, definitions, environment)
  const scheduler = new PermissionScheduler(repository, runtime, systemClock)
  const conversation = new ConversationService(
    repository,
    runtime,
    sessions,
    ids,
    systemClock,
    new InProcessEventBus(),
    scheduler,
    new SecretRedactor(),
    500,
  )
  const { session } = await sessions.create('workspace-001', {
    name: '会话',
    provider_connection_id: 'provider-001',
    model_id: 'model-a',
  })
  return { repository, runtime, conversation, session, sessions, ids, scheduler }
}

describe('Run 命令闭环', () => {
  it('同 request_id 同输入重放不重复创建或 dispatch', async () => {
    const { repository, runtime, conversation, session } = await setup()

    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(first.run.id)
    const second = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })

    expect(second.run.id).toBe(first.run.id)
    expect(runtime.sendTurns).toBe(1)
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(snapshot?.runs).toHaveLength(1)
    expect(snapshot?.messages.filter((message) => message.sender_kind === 'user')).toHaveLength(1)
    await repository.close()
  })

  it('未注入容量额度时单 Agent 消息仍正常创建并派发', async () => {
    const { repository, runtime, conversation, session } = await setup()

    const { run } = await conversation.sendMessage(session.id, { content: 'legacy', request_id: 'req-legacy' })
    await conversation.waitForTurn(run.id)

    expect(runtime.sendTurns).toBe(1)
    await expect(repository.getRun(run.id)).resolves.toMatchObject({ status: 'completed' })
    await repository.close()
  })

  it('Run 进入终态后释放 Slot claim，下一条消息可以创建新 Run', async () => {
    const { repository, conversation, session } = await setup()
    const first = await conversation.sendMessage(session.id, { content: 'first', request_id: 'req-1' })
    await conversation.waitForTurn(first.run.id)

    await expect(repository.getSlotActivityClaim(await slotIdOf(repository, session.id)))
      .resolves.toBeNull()

    const second = await conversation.sendMessage(session.id, { content: 'second', request_id: 'req-2' })
    expect(second.run.id).not.toBe(first.run.id)
    await conversation.waitForTurn(second.run.id)
    await repository.close()
  })

  it('同 key 不同输入返回 409', async () => {
    const { repository, conversation, session } = await setup()
    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(first.run.id)

    await expect(conversation.sendMessage(session.id, { content: 'different', request_id: 'req-1' }))
      .rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
    await repository.close()
  })

  it('不同 request_id 并发 start 同 Slot：只有一个成功且只 dispatch 一次', async () => {
    const { repository, runtime, conversation, session } = await setup()

    const results = await Promise.allSettled([
      conversation.sendMessage(session.id, { content: 'a', request_id: 'req-a' }),
      conversation.sendMessage(session.id, { content: 'b', request_id: 'req-b' }),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'slot_busy', statusCode: 409 })
    expect(runtime.sendTurns).toBe(1)

    // 被拒绝的命令不得留下 Run/Task/Message。
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(snapshot?.runs).toHaveLength(1)
    expect(snapshot?.tasks).toHaveLength(1)
    await repository.close()
  })

  it('resume 复用同一 Run 与原输入，不创建新 Run', async () => {
    const { repository, runtime, conversation, session } = await setup()
    const { run } = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(run.id)

    const completed = await repository.getRun(run.id)
    const revision = await repository.getRunStateRevision(run.id)
    await repository.updateRunIfRevision({ ...completed!, status: 'paused', updated_at: timestamp }, revision!)

    const receipt = await conversation.resumeRun(run.id, { request_id: 'resume-1' })
    expect(receipt).toMatchObject({ status: 'completed', run_id: run.id })
    await conversation.waitForTurn(run.id)

    expect(runtime.sendTurns).toBe(2)
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(snapshot?.runs).toHaveLength(1)
    await repository.close()
  })

  it('retry 创建 attempt+1 并复用原输入；祖先已有后代时拒绝', async () => {
    const { repository, runtime, conversation, session } = await setup()
    const { run } = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(run.id)
    const returned = await repository.getRun(run.id)
    await repository.updateRunIfRevision(
      { ...returned!, status: 'failed', updated_at: timestamp },
      await repository.getRunStateRevision(run.id) ?? 1,
    )

    const receipt = await conversation.retryRun(run.id, { request_id: 'retry-1' })
    expect(receipt.run_id).not.toBe(run.id)
    const child = await repository.getRun(receipt.run_id ?? '')
    expect(child).toMatchObject({ attempt: 2, retry_of_run_id: run.id })

    // 祖先已有后代：再次 retry 根 Run 必须 409，且不新增 attempt。
    await expect(conversation.retryRun(run.id, { request_id: 'retry-2' }))
      .rejects.toMatchObject({ statusCode: 409 })
    // 新 ACP Session 已建立但无法创建 attempt：必须回收，不留孤儿。
    expect(runtime.closedSessions).toBeGreaterThan(0)
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(snapshot?.runs).toHaveLength(2)
    expect(runtime.sendTurns).toBe(2)
    await repository.close()
  })

  it('cancel 等待 turn_cancelled 证据后把 Run/Task/claim 一致收敛为 cancelled', async () => {
    const { repository, runtime, conversation, session } = await setup()
    runtime.blockTurns = true
    const turn = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await runtime.turnStarted()

    const receipt = await conversation.cancelRun(turn.run.id, { request_id: 'cancel-1' })
    expect(receipt.status).toBe('completed')
    expect(runtime.cancelTurns).toBe(1)
    await conversation.waitForTurn(turn.run.id)

    await expect(repository.getRun(turn.run.id)).resolves.toMatchObject({ status: 'cancelled' })
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(snapshot?.tasks[0]).toMatchObject({ status: 'cancelled' })
    await expect(repository.getSlotActivityClaim(await slotIdOf(repository, session.id))).resolves.toBeNull()
    await repository.close()
  })

  it('cancelTurn 通知成功但 turn 未结束时收敛为 interrupted，迟到完成不能覆盖', async () => {
    const { repository, runtime, conversation, session } = await setup()
    runtime.blockTurns = true
    // cancelTurn 只做通知，不结束 turn：无法确认停止。
    runtime.cancelEndsTurn = false
    const turn = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await runtime.turnStarted()

    const receipt = await conversation.cancelRun(turn.run.id, { request_id: 'cancel-1' })
    expect(receipt.status).toBe('completed')
    await expect(repository.getRun(turn.run.id)).resolves.toMatchObject({
      status: 'interrupted',
      error_code: 'cancel_unconfirmed',
    })

    // 迟到的 turn 完成事件不得覆盖 interrupted。
    runtime.releaseTurns()
    await conversation.waitForTurn(turn.run.id)
    await expect(repository.getRun(turn.run.id)).resolves.toMatchObject({ status: 'interrupted' })
    await repository.close()
  })

  it('dispatch 信号前回执保持 running/started，确认派发后才 accepted', async () => {
    const { repository, runtime, conversation, session } = await setup()
    runtime.blockBeforeDispatch = true

    const turn = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await runtime.beforeDispatchStarted()

    // Runtime 尚未写出 session/prompt：回执不得提前完成。
    await expect(repository.getCommandReceipt('workspace-001', 'req-1', 'start'))
      .resolves.toMatchObject({ status: 'running', dispatch_state: 'started' })

    runtime.releaseBeforeDispatch()
    await conversation.waitForTurn(turn.run.id)
    await expect(repository.getCommandReceipt('workspace-001', 'req-1', 'start'))
      .resolves.toMatchObject({ status: 'completed', dispatch_state: 'accepted' })
    await expect(repository.getRun(turn.run.id)).resolves.toMatchObject({ status: 'completed' })
    await repository.close()
  })

  it('空迭代器且无 dispatch 信号：回执 ambiguous，Run 不得 completed，同 key 不重派', async () => {
    const { repository, runtime, conversation, session } = await setup()
    runtime.emptyTurns = true

    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(first.run.id)

    // 没有 dispatch 信号也没有事件：不能声称已 accepted，更不能把 Run 报成 completed。
    await expect(repository.getCommandReceipt('workspace-001', 'req-1', 'start'))
      .resolves.toMatchObject({ status: 'ambiguous', dispatch_state: 'started', error_code: 'command_outcome_ambiguous' })
    await expect(repository.getRun(first.run.id)).resolves.toMatchObject({
      status: 'interrupted',
      error_code: 'dispatch_unconfirmed',
    })

    // 同 key 只能得到稳定的 409，不得错误报告成功，也不得隐式重复派发。
    await expect(conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' }))
      .rejects.toMatchObject({ code: 'command_outcome_ambiguous', statusCode: 409 })
    expect(runtime.sendTurns).toBe(1)

    // 无法证明未派发：claim 必须保留，避免新消息在同一 ACP Session 上并发。
    const slotId = await slotIdOf(repository, session.id)
    await expect(repository.getSlotActivityClaim(slotId)).resolves.toMatchObject({ run_id: first.run.id })
    await repository.close()
  })

  it.each([
    ['抛错', 'throw'],
    ['CAS 返回 null', 'null'],
  ] as const)('ambiguous 回执写回失败（%s）：保持 running/started 与 claim，不降级为可重试', async (_label, mode) => {
    const { repository, runtime, conversation, session } = await setup()
    runtime.emptyTurns = true

    // 只让 ambiguous 那一次 CAS 失败；若实现错误地回退为 failed/not_started，
    // 后续普通写入会成功，从而暴露可重派漏洞。
    const updateReceipt = repository.updateCommandReceipt.bind(repository)
    let ambiguousWriteAttempts = 0
    let signalAmbiguousWrite!: () => void
    const ambiguousWriteStarted = new Promise<void>((resolve) => {
      signalAmbiguousWrite = resolve
    })
    let releaseAmbiguousWrite!: () => void
    const ambiguousWriteGate = new Promise<void>((resolve) => {
      releaseAmbiguousWrite = resolve
    })
    repository.updateCommandReceipt = async (receipt, expectedStatus, expectedDispatchState) => {
      if (receipt.status === 'ambiguous') {
        ambiguousWriteAttempts += 1
        signalAmbiguousWrite()
        await ambiguousWriteGate
        if (mode === 'null') {
          return null
        }
        throw new Error('sqlite temporarily unavailable')
      }
      return updateReceipt(receipt, expectedStatus, expectedDispatchState)
    }

    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await ambiguousWriteStarted
    const waiting = conversation.waitForTurn(first.run.id)
    releaseAmbiguousWrite()
    await expect(waiting).rejects.toThrow(
      mode === 'null' ? 'ambiguous command receipt was not persisted' : 'sqlite temporarily unavailable',
    )
    expect(ambiguousWriteAttempts).toBe(1)

    // 回执必须留在启动恢复可判为 ambiguous 的边界，而不是可安全重试的失败边界。
    await expect(repository.getCommandReceipt('workspace-001', 'req-1', 'start'))
      .resolves.toMatchObject({ status: 'running', dispatch_state: 'started' })
    await expect(repository.getRun(first.run.id)).resolves.toMatchObject({ status: 'running' })
    const slotId = await slotIdOf(repository, session.id)
    await expect(repository.getSlotActivityClaim(slotId)).resolves.toMatchObject({ run_id: first.run.id })

    // 同 key 重放不得隐式重派，也不得把既有 Run 当作成功回执返回。
    await expect(conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' }))
      .rejects.toMatchObject({ code: 'command_outcome_ambiguous', statusCode: 409 })
    expect(runtime.sendTurns).toBe(1)
    await repository.close()
  })

  it('迭代器启动即失败：回执 failed/not_started，同 key 重试复用同一 Run', async () => {
    const { repository, runtime, conversation, session } = await setup()
    runtime.failBeforeDispatchNext = true

    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(first.run.id)

    // 可证明未派发：不得写成 completed/accepted，必须允许同 key 安全重试。
    await expect(repository.getCommandReceipt('workspace-001', 'req-1', 'start'))
      .resolves.toMatchObject({ status: 'failed', dispatch_state: 'not_started' })
    await expect(repository.getRun(first.run.id)).resolves.toMatchObject({ status: 'interrupted' })

    const retried = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(retried.run.id)
    expect(retried.run.id).toBe(first.run.id)
    expect(runtime.sendTurns).toBe(2)
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(snapshot?.runs).toHaveLength(1)
    expect(snapshot?.messages.filter((message) => message.sender_kind === 'user')).toHaveLength(1)
    await expect(repository.getRun(first.run.id)).resolves.toMatchObject({ status: 'completed' })
    await repository.close()
  })

  it('cancel 超时后旧 turn 未结束：新消息不得 dispatch，旧 turn 结束后 claim 才释放', async () => {
    const { repository, runtime, conversation, session } = await setup()
    runtime.blockTurns = true
    runtime.cancelEndsTurn = false
    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await runtime.turnStarted()

    const receipt = await conversation.cancelRun(first.run.id, { request_id: 'cancel-1' })
    expect(receipt.status).toBe('completed')
    await expect(repository.getRun(first.run.id)).resolves.toMatchObject({
      status: 'interrupted',
      error_code: 'cancel_unconfirmed',
    })
    const slotId = await slotIdOf(repository, session.id)
    // 旧 turn 仍活动：claim 必须保留，不能把 Slot 让给新消息。
    await expect(repository.getSlotActivityClaim(slotId))
      .resolves.toMatchObject({ run_id: first.run.id })

    // 新消息被 claim 挡住；resume 也不能在同一 ACP Session 上叠加 turn。
    await expect(conversation.sendMessage(session.id, { content: 'next', request_id: 'req-2' }))
      .rejects.toMatchObject({ code: 'slot_busy', statusCode: 409 })
    await expect(conversation.resumeRun(first.run.id, { request_id: 'resume-1' }))
      .rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
    expect(runtime.sendTurns).toBe(1)

    // 旧 turn 结束：保持 interrupted（不误报 cancelled），事件全部归属旧 Run。
    runtime.releaseTurns()
    await conversation.waitForTurn(first.run.id)
    await expect(repository.getRun(first.run.id)).resolves.toMatchObject({ status: 'interrupted' })
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(snapshot?.runs).toHaveLength(1)
    expect(await repository.replayEvents(first.run.id, 0)).not.toHaveLength(0)
    await expect(repository.getSlotActivityClaim(slotId)).resolves.toBeNull()

    // claim 释放后新消息可以继续，不会与旧 turn 并发。
    runtime.blockTurns = false
    const second = await conversation.sendMessage(session.id, { content: 'next', request_id: 'req-3' })
    await conversation.waitForTurn(second.run.id)
    expect(second.run.id).not.toBe(first.run.id)
    expect(runtime.sendTurns).toBe(2)
    await repository.close()
  })

  it('cancel 超时后旧 turn 未结束：retry 返回 409，不建 Session/Run 且 claim 不变', async () => {
    const { repository, runtime, conversation, session } = await setup()
    runtime.blockTurns = true
    runtime.cancelEndsTurn = false
    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await runtime.turnStarted()

    await conversation.cancelRun(first.run.id, { request_id: 'cancel-1' })
    await expect(repository.getRun(first.run.id)).resolves.toMatchObject({
      status: 'interrupted',
      error_code: 'cancel_unconfirmed',
    })
    const slotId = await slotIdOf(repository, session.id)
    const createdSessionsBefore = runtime.createdSessions
    const connectionsBefore = runtime.connections

    // 旧 turn 仍活动：retry 不得打开新 Session、创建 attempt 或迁移 claim。
    await expect(conversation.retryRun(first.run.id, { request_id: 'retry-1' }))
      .rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
    expect(runtime.createdSessions).toBe(createdSessionsBefore)
    expect(runtime.connections).toBe(connectionsBefore)
    const blocked = await repository.getSessionSnapshot(session.id)
    expect(blocked?.runs).toHaveLength(1)
    expect(blocked?.tasks).toHaveLength(1)
    await expect(repository.getSlotActivityClaim(slotId))
      .resolves.toMatchObject({ run_id: first.run.id })
    expect(runtime.sendTurns).toBe(1)
    // 回执留在可安全重试的失败边界。
    await expect(repository.getCommandReceipt('workspace-001', 'retry-1', 'retry'))
      .resolves.toMatchObject({ status: 'failed', dispatch_state: 'not_started' })

    // 旧 turn 结束、claim 释放后才允许 retry 建立新 attempt。
    runtime.releaseTurns()
    await conversation.waitForTurn(first.run.id)
    await expect(repository.getSlotActivityClaim(slotId)).resolves.toBeNull()
    runtime.blockTurns = false
    const receipt = await conversation.retryRun(first.run.id, { request_id: 'retry-1' })
    expect(receipt.status).toBe('completed')
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(snapshot?.runs).toHaveLength(2)
    expect(snapshot?.runs.find((run) => run.id === receipt.run_id)).toMatchObject({
      attempt: 2,
      retry_of_run_id: first.run.id,
    })
    await conversation.waitForTurn(receipt.run_id ?? '')
    expect(runtime.sendTurns).toBe(2)
    await repository.close()
  })

  it('旧 turn 结束后 claim 已释放，但新 Run 占用 Slot 时旧 Run 不能 resume', async () => {
    const { repository, runtime, conversation, session } = await setup()
    runtime.blockTurns = true
    runtime.cancelEndsTurn = false
    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await runtime.turnStarted()
    await conversation.cancelRun(first.run.id, { request_id: 'cancel-1' })
    // 旧 turn 结束：claim 释放，Run 保持 interrupted。
    runtime.releaseTurns()
    await conversation.waitForTurn(first.run.id)
    await expect(repository.getRun(first.run.id)).resolves.toMatchObject({ status: 'interrupted' })

    // 新 Run 重新占用 Slot 并保持活动。
    const second = await conversation.sendMessage(session.id, { content: 'next', request_id: 'req-2' })
    expect(second.run.id).not.toBe(first.run.id)
    expect(runtime.sendTurns).toBe(2)

    // 同一 ACP Session 已被新 Run 占用：旧 Run 不得 resume 并发新 turn。
    await expect(conversation.resumeRun(first.run.id, { request_id: 'resume-1' }))
      .rejects.toMatchObject({ code: 'slot_busy', statusCode: 409 })
    expect(runtime.sendTurns).toBe(2)

    runtime.releaseTurns()
    await conversation.waitForTurn(second.run.id)
    await repository.close()
  })

  it('确定性未派发失败记为 failed/not_dispatched，同 key 可安全重试', async () => {
    const { repository, runtime, conversation, session } = await setup()
    runtime.failNextDispatch = true

    await expect(conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' }))
      .rejects.toMatchObject({ code: 'adapter_start_failed', statusCode: 502 })

    const receipt = await repository.getCommandReceipt('workspace-001', 'req-1', 'start')
    expect(receipt).toMatchObject({ status: 'failed', dispatch_state: 'not_started' })

    // 同 key 重试：复用既有 Run/Task/Message，只重新 dispatch。
    const retried = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(retried.run.id)
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(snapshot?.runs).toHaveLength(1)
    expect(snapshot?.messages.filter((message) => message.sender_kind === 'user')).toHaveLength(1)
    expect(runtime.sendTurns).toBe(2)
    await repository.close()
  })

  it('start 回执重放先于 Runtime 检查', async () => {
    const { repository, runtime, conversation, session, ids, scheduler } = await setup()
    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(first.run.id)

    // 模拟 Runtime 丢失的同一服务：已完成命令仍必须返回既有结果。
    const offline = new ConversationService(
      repository,
      runtime,
      { getRuntimeSession: () => null },
      ids,
      systemClock,
      new InProcessEventBus(),
      scheduler,
      new SecretRedactor(),
      500,
    )
    const replay = await offline.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    expect(replay.run.id).toBe(first.run.id)
    expect(runtime.sendTurns).toBe(1)
    // 新命令仍需 Runtime。
    await expect(offline.sendMessage(session.id, { content: 'next', request_id: 'req-2' }))
      .rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
    await repository.close()
  })

  it('slot_busy 的 failed/not_dispatched 回执可用同 key 安全重试', async () => {
    const { repository, runtime, conversation, session } = await setup()
    runtime.blockTurns = true
    const first = await conversation.sendMessage(session.id, { content: 'a', request_id: 'req-a' })
    await runtime.turnStarted()

    await expect(conversation.sendMessage(session.id, { content: 'b', request_id: 'req-b' }))
      .rejects.toMatchObject({ code: 'slot_busy', statusCode: 409 })
    await expect(repository.getCommandReceipt('workspace-001', 'req-b', 'start'))
      .resolves.toMatchObject({ status: 'failed', dispatch_state: 'not_started', error_code: 'slot_busy' })

    await conversation.cancelRun(first.run.id, { request_id: 'cancel-1' })
    await conversation.waitForTurn(first.run.id)
    runtime.blockTurns = false

    const second = await conversation.sendMessage(session.id, { content: 'b', request_id: 'req-b' })
    await conversation.waitForTurn(second.run.id)
    expect(second.run.id).not.toBe(first.run.id)
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(snapshot?.runs).toHaveLength(2)
    expect(snapshot?.messages.filter((message) => message.sender_kind === 'user')).toHaveLength(2)
    expect(runtime.sendTurns).toBe(2)
    await repository.close()
  })

  it('resume / cancel 已完成回执同 key 重放不重复副作用', async () => {
    const { repository, runtime, conversation, session } = await setup()
    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(first.run.id)
    const completed = await repository.getRun(first.run.id)
    await repository.updateRunIfRevision(
      { ...completed!, status: 'paused', updated_at: timestamp },
      await repository.getRunStateRevision(first.run.id) ?? 1,
    )
    await conversation.resumeRun(first.run.id, { request_id: 'resume-1' })
    await conversation.waitForTurn(first.run.id)
    const sendsAfterResume = runtime.sendTurns

    // Run 已回到 running/completed，重放仍返回原回执而不看状态。
    await expect(conversation.resumeRun(first.run.id, { request_id: 'resume-1' }))
      .resolves.toMatchObject({ status: 'completed', run_id: first.run.id })
    expect(runtime.sendTurns).toBe(sendsAfterResume)

    runtime.blockTurns = true
    const cancellable = await conversation.sendMessage(session.id, { content: 'cancel me', request_id: 'req-2' })
    await runtime.turnStarted()
    await conversation.cancelRun(cancellable.run.id, { request_id: 'cancel-1' })
    await conversation.waitForTurn(cancellable.run.id)
    const cancelsAfter = runtime.cancelTurns
    await expect(conversation.cancelRun(cancellable.run.id, { request_id: 'cancel-1' }))
      .resolves.toMatchObject({ status: 'completed', run_id: cancellable.run.id })
    expect(runtime.cancelTurns).toBe(cancelsAfter)
    await repository.close()
  })

  it('同 request_id 指向不同 Run 时返回 409，不执行第二次命令', async () => {
    const { repository, runtime, conversation, session } = await setup()
    const first = await conversation.sendMessage(session.id, { content: 'a', request_id: 'req-a' })
    await conversation.waitForTurn(first.run.id)
    const second = await conversation.sendMessage(session.id, { content: 'b', request_id: 'req-b' })
    await conversation.waitForTurn(second.run.id)
    for (const runId of [first.run.id, second.run.id]) {
      const current = await repository.getRun(runId)
      await repository.updateRunIfRevision(
        { ...current!, status: 'paused', updated_at: timestamp },
        await repository.getRunStateRevision(runId) ?? 1,
      )
    }

    await conversation.resumeRun(first.run.id, { request_id: 'shared-request' })
    await conversation.waitForTurn(first.run.id)
    const sendsAfter = runtime.sendTurns
    await expect(conversation.resumeRun(second.run.id, { request_id: 'shared-request' }))
      .rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
    expect(runtime.sendTurns).toBe(sendsAfter)
    await repository.close()
  })

  it('retry 持久化新 attachment 并安全关闭旧 Runtime Session/连接', async () => {
    const { repository, runtime, conversation, session } = await setup()
    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(first.run.id)
    const slotId = await slotIdOf(repository, session.id)
    const before = await repository.getRuntimeAttachment(slotId)

    const current = await repository.getRun(first.run.id)
    await repository.updateRunIfRevision(
      { ...current!, status: 'failed', updated_at: timestamp },
      await repository.getRunStateRevision(first.run.id) ?? 1,
    )
    const receipt = await conversation.retryRun(first.run.id, { request_id: 'retry-1' })
    await conversation.waitForTurn(receipt.run_id ?? '')

    const after = await repository.getRuntimeAttachment(slotId)
    expect(after).not.toBeNull()
    expect(after?.acp_session_id).not.toBe(before?.acp_session_id)
    expect(after?.acp_session_id).toBe('acp-session-2')
    // 旧 ACP Session 与旧连接都被回收。
    expect(runtime.closedSessions).toBe(1)
    expect(runtime.closedConnections).toBe(1)
    await repository.close()
  })

  it('attachment 保存失败时 CAS 回滚 receipt refs，随后同 key 可创建新 attempt', async () => {
    const { repository, runtime, conversation, session } = await setup()
    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(first.run.id)
    const current = await repository.getRun(first.run.id)
    await repository.updateRunIfRevision(
      { ...current!, status: 'failed', updated_at: timestamp },
      await repository.getRunStateRevision(first.run.id) ?? 1,
    )
    const saveAttachment = vi.spyOn(repository, 'saveRuntimeAttachment').mockRejectedValueOnce(new Error('disk full'))

    await expect(conversation.retryRun(first.run.id, { request_id: 'retry-rollback' }))
      .rejects.toMatchObject({ code: 'db_unavailable', statusCode: 503 })
    const failedReceipt = await repository.getCommandReceipt('workspace-001', 'retry-rollback', 'retry')
    expect(failedReceipt).toMatchObject({ status: 'failed', dispatch_state: 'not_started' })
    expect(failedReceipt?.run_id).toBeUndefined()
    expect(failedReceipt?.task_id).toBeUndefined()
    expect(failedReceipt?.message_id).toBeUndefined()
    await expect(repository.getSessionSnapshot(session.id)).resolves.toMatchObject({ runs: [{ id: first.run.id }] })
    expect(runtime.closedSessions).toBe(1)
    expect(runtime.closedConnections).toBe(1)
    saveAttachment.mockRestore()

    const retried = await conversation.retryRun(first.run.id, { request_id: 'retry-rollback' })
    await conversation.waitForTurn(retried.run_id ?? '')
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(snapshot?.runs.filter((run) => run.attempt === 2)).toHaveLength(1)
    await repository.close()
  })

  it('rollback 先赢时 stale retry dispatcher 不派发也不返回旧 child 成功', async () => {
    const { repository, runtime, conversation, session, sessions, ids, scheduler } = await setup()
    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(first.run.id)
    const parent = await repository.getRun(first.run.id)
    await repository.updateRunIfRevision(
      { ...parent!, status: 'failed', updated_at: timestamp },
      await repository.getRunStateRevision(first.run.id) ?? 1,
    )
    const parentTask = (await repository.getSessionSnapshot(session.id))?.tasks
      .find((task) => task.run_id === first.run.id)
    const input = await repository.getRunInputMessage(first.run.id)
    const receipt = await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'retry-race', command: 'retry',
      target_id: first.run.id, status: 'failed', dispatch_state: 'not_started', updated_at: timestamp,
    })
    const child = {
      ...parent!, id: 'run-stale-child', status: 'running' as const, attempt: 2,
      retry_of_run_id: first.run.id, started_at: timestamp, updated_at: timestamp,
    }
    const childTask = {
      ...parentTask!, id: 'task-stale-child', run_id: child.id, status: 'running' as const,
      created_at: timestamp, updated_at: timestamp,
    }
    const childReceipt = await repository.createRetryTurn(
      first.run.id,
      child,
      childTask,
      receipt,
      { status: 'failed', dispatch_state: 'not_started', run_id: null, task_id: null, message_id: null },
      timestamp,
    )
    if (childReceipt === null || input === null) {
      throw new Error('retry child fixture was not created')
    }
    await expect(repository.rollbackRetryTurn(childReceipt, child.id, first.run.id, childTask.slot_id))
      .resolves.toBe(true)
    vi.spyOn(repository, 'getTaskContextSources').mockResolvedValue([{
      task_id: childTask.id,
      source_type: 'message',
      source_id: input.id,
      source_version: 1,
      created_at: timestamp,
    }])
    vi.spyOn(repository, 'getRunInputMessage').mockResolvedValue(input)
    const runner = new ConversationTurnRunner({
      repository,
      runtime,
      sessions,
      ids,
      clock: systemClock,
      eventBus: new InProcessEventBus(),
      redaction: new SecretRedactor(),
      permissionScheduler: scheduler,
      cancelConfirmTimeoutMs: 500,
    })

    await expect(runner.dispatchTurn({
      receipt: childReceipt,
      runtimeSession: sessions.getRuntimeSession(childTask.slot_id)!,
      run: child,
      task: childTask,
      promptText: input.content,
      runId: child.id,
      taskId: childTask.id,
      messageId: input.id,
    })).resolves.toBe(false)
    expect(runtime.sendTurns).toBe(1)
    await expect(repository.getRun(child.id)).resolves.toBeNull()
    await repository.close()
  })

  it('retry dispatch 未派发失败后同 key 复用同一 attempt，不新建 Session', async () => {
    const { repository, runtime, conversation, session } = await setup()
    const first = await conversation.sendMessage(session.id, { content: 'hello', request_id: 'req-1' })
    await conversation.waitForTurn(first.run.id)
    const current = await repository.getRun(first.run.id)
    await repository.updateRunIfRevision(
      { ...current!, status: 'failed', updated_at: timestamp },
      await repository.getRunStateRevision(first.run.id) ?? 1,
    )

    runtime.failNextDispatch = true
    await expect(conversation.retryRun(first.run.id, { request_id: 'retry-1' }))
      .rejects.toMatchObject({ code: 'adapter_start_failed', statusCode: 502 })
    await expect(repository.getCommandReceipt('workspace-001', 'retry-1', 'retry'))
      .resolves.toMatchObject({ status: 'failed', dispatch_state: 'not_started' })
    const sessionsAfterFirstAttempt = runtime.createdSessions

    const replay = await conversation.retryRun(first.run.id, { request_id: 'retry-1' })
    await conversation.waitForTurn(replay.run_id ?? '')

    // 同一个子 attempt，没有第三次尝试，也没有新 ACP Session。
    expect(runtime.createdSessions).toBe(sessionsAfterFirstAttempt)
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(snapshot?.runs).toHaveLength(2)
    expect(snapshot?.runs.filter((run) => run.attempt === 2)).toHaveLength(1)
    expect(runtime.sendTurns).toBe(3)
    await repository.close()
  })
})

/** 读取 Session 首个 Slot 的 id。 */
const slotIdOf = async (
  repository: Awaited<ReturnType<typeof setup>>['repository'],
  sessionId: string,
): Promise<string> => {
  const slots = await repository.listAgentSlots(sessionId)
  return slots[0]?.id ?? ''
}
