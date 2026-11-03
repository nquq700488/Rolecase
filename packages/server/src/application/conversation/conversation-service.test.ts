import { describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@rolecast/contract'

import type {
  AgentRuntimeConnection,
  AgentRuntimePort,
  AgentRuntimeSession,
} from '../ports/agent-runtime-port.js'
import { systemClock } from '../ports/clock-port.js'
import { PermissionScheduler } from '../permission/permission-scheduler.js'
import { ConversationService } from './conversation-service.js'
import { InProcessEventBus } from '../../infrastructure/events/in-process-event-bus.js'
import { SecretRedactor } from '../../infrastructure/credentials/file-credential-store.js'
import { SqliteDatabase } from '../../infrastructure/persistence/sqlite-database.js'
import { SqliteRepository } from '../../infrastructure/persistence/sqlite-repository.js'

class TestIds {
  private sequence = 0

  next(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }
}

class PermissionRuntime implements AgentRuntimePort {
  sendTurns = 0
  readonly responses: Array<{ requestId: string | number; optionId?: string; cancelled?: boolean }> = []
  readonly permissionReady: Promise<void>
  failRespondPermission = false
  private resolvePermissionReady!: () => void
  private resolvePermission!: () => void

  /** 放行被权限应答阻塞的 turn（失败场景清理用）。 */
  releaseTurn(): void {
    this.resolvePermission()
  }

  private readonly connection: AgentRuntimeConnection = {
    connectionId: 'connection-001',
    providerKind: 'claude',
    adapterVersion: 'test',
    capabilities: {
      provider_kind: 'claude',
      adapter_version: 'test',
      source: 'manual',
      observed_at: '2026-10-14T10:00:00.000Z',
      capabilities: {},
    },
  }

  constructor() {
    this.permissionReady = new Promise<void>((resolve) => {
      this.resolvePermissionReady = resolve
    })
  }

  get session(): AgentRuntimeSession {
    return {
      sessionId: 'acp-session-001',
      connection: this.connection,
      configOptions: [],
    }
  }

  async connect(): Promise<AgentRuntimeConnection> { return this.connection }
  async createSession(): Promise<AgentRuntimeSession> { return this.session }
  async *sendTurn(): AsyncIterable<RuntimeEvent> {
    this.sendTurns += 1
    yield {
      session_id: 'acp-session-001',
      kind: 'permission_requested',
      payload: {
        request_id: 900,
        capability: 'execute',
        description: '执行命令',
        options: [{ optionId: 'allow_once', name: '允许一次', kind: 'allow_once' }],
      },
    }
    this.resolvePermissionReady()
    await new Promise<void>((resolve) => {
      this.resolvePermission = resolve
    })
    const cancelled = this.responses.at(-1)?.cancelled === true
    if (cancelled) {
      yield { session_id: 'acp-session-001', kind: 'turn_cancelled', payload: {} }
      return
    }
    yield {
      session_id: 'acp-session-001',
      kind: 'agent_message_chunk',
      payload: { content: { type: 'text', text: '已完成' } },
    }
    yield { session_id: 'acp-session-001', kind: 'turn_completed', payload: {} }
  }

  async respondPermission(input: { requestId: string | number; optionId?: string; cancelled?: boolean }): Promise<void> {
    if (this.failRespondPermission) {
      throw new Error('adapter permission unavailable')
    }
    this.responses.push({
      requestId: input.requestId,
      ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
      ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
    })
    this.resolvePermission()
  }

  async cancelTurn(): Promise<void> {}
  async resumeSession(): Promise<AgentRuntimeSession> { return this.session }
  async closeSession(): Promise<void> {}
  async closeConnection(): Promise<void> {}
}

async function setup(): Promise<{
  repository: SqliteRepository
  runtime: PermissionRuntime
  scheduler: PermissionScheduler
  conversation: ConversationService
}> {
  const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
  await repository.createWorkspace({
    id: 'workspace-001', name: '测试',
    created_at: '2026-10-14T10:00:00.000Z', updated_at: '2026-10-14T10:00:00.000Z',
  })
  await repository.createSession({
    id: 'session-001', workspace_id: 'workspace-001', name: '会话', status: 'active',
    created_at: '2026-10-14T10:00:00.000Z', updated_at: '2026-10-14T10:00:00.000Z',
  })
  await repository.createAgentSlot({
    id: 'slot-001', session_id: 'session-001', model_id: 'model-001', status: 'idle',
    created_at: '2026-10-14T10:00:00.000Z',
  })
  const runtime = new PermissionRuntime()
  const scheduler = new PermissionScheduler(repository, runtime, systemClock)
  const eventBus = new InProcessEventBus()
  const conversation = new ConversationService(
    repository,
    runtime,
    { getRuntimeSession: () => runtime.session },
    new TestIds(),
    systemClock,
    eventBus,
    scheduler,
    new SecretRedactor(),
  )
  return { repository, runtime, scheduler, conversation }
}

describe('ConversationService 权限主链路', () => {
  it('省略 agent_slot_id 时始终选择原始 Slot 而非按排序在前的新 Slot', async () => {
    const { repository, runtime, scheduler, conversation } = await setup()
    const earlierRoleSlot = {
      id: 'slot-earlier',
      session_id: 'session-001',
      role_binding_id: 'binding-002',
      model_id: 'model-002',
      status: 'idle' as const,
      created_at: '2026-10-13T10:00:00.000Z',
    }
    await repository.addAgentSlotWithAttachmentAndRoleSnapshot(earlierRoleSlot, {
      slot_id: earlierRoleSlot.id,
      session_id: earlierRoleSlot.session_id,
      provider_connection_id: 'provider-002',
      provider_kind: 'claude',
      config_revision: 1,
      adapter_version: 'test',
      adapter_fingerprint: 'fp-002',
      cwd: '/tmp/work',
      runtime_directory: '/tmp/provider-002',
      acp_session_id: 'acp-session-002',
      updated_at: '2026-10-13T10:00:00.000Z',
    }, {
      slot_id: earlierRoleSlot.id,
      workspace_id: 'workspace-001',
      role_binding_id: 'binding-002',
      role_binding_version: 1,
      role_id: 'role-002',
      role_version: 1,
      role_name: '审查者',
      system_prompt: '审查',
      required_guidelines: [],
      output_contract: '',
      created_at: '2026-10-13T10:00:00.000Z',
    })

    const turn = await conversation.sendMessage('session-001', { content: '继续工作' })
    expect(turn.task.slot_id).toBe('slot-001')
    await runtime.permissionReady
    runtime.releaseTurn()
    await conversation.waitForTurn(turn.run.id)
    scheduler.stop()
    await repository.close()
  })

  it('尚未创建 Run 的同键失败同样拒绝不同输入复用 request_id', async () => {
    const { repository, runtime, scheduler, conversation } = await setup()
    const turn = await conversation.sendMessage('session-001', { content: '第一件事' })

    await expect(conversation.sendMessage('session-001', {
      content: '第二件事',
      request_id: 'busy-key',
    })).rejects.toMatchObject({ code: 'slot_busy' })
    // 回执当时没有 Run/Message 可比较，也必须靠摘要判定输入已变化。
    await expect(conversation.sendMessage('session-001', {
      content: '第三件事',
      request_id: 'busy-key',
    })).rejects.toMatchObject({ code: 'state_conflict' })

    await runtime.permissionReady
    runtime.releaseTurn()
    await conversation.waitForTurn(turn.run.id)
    scheduler.stop()
    await repository.close()
  })

  it('保留数字 ACP request ID，并在用户回答后完成 Run', async () => {
    const { repository, runtime, scheduler, conversation } = await setup()
    const turn = await conversation.sendMessage('session-001', { content: '执行任务' })
    await runtime.permissionReady
    const permission = (await repository.getSessionSnapshot('session-001'))?.permissions[0]
    if (permission === undefined) {
      throw new Error('权限请求未持久化')
    }
    await conversation.answerPermission(permission.id, 'allow_once')
    await conversation.waitForTurn(turn.run.id)
    // Adapter 发来的是数字 ID，应答必须保持 number 身份。
    expect(runtime.responses).toEqual([{ requestId: 900, optionId: 'allow_once' }])
    expect((await repository.getRun(turn.run.id))?.status).toBe('completed')
    scheduler.stop()
    await repository.close()
  })

  it('数字 ACP request ID 经过 SQLite 持久化后仍保持 number 身份', async () => {
    const { repository, runtime, scheduler, conversation } = await setup()
    const turn = await conversation.sendMessage('session-001', { content: '执行任务' })
    await runtime.permissionReady
    const permission = (await repository.getSessionSnapshot('session-001'))?.permissions[0]
    if (permission === undefined) {
      throw new Error('权限请求未持久化')
    }

    // 重新从 SQLite 读取（模拟服务重启 / 重新挂接前的读取路径）。
    const persisted = await repository.getPermissionRequest(permission.id)
    expect(persisted?.adapter_request_id).toBe(900)
    expect(typeof persisted?.adapter_request_id).toBe('number')

    // 用重新读取的记录回答，Runtime 收到的仍是 number。
    await conversation.answerPermission(permission.id, 'allow_once')
    await conversation.waitForTurn(turn.run.id)
    expect(runtime.responses).toEqual([{ requestId: 900, optionId: 'allow_once' }])
    expect(typeof runtime.responses[0]?.requestId).toBe('number')
    scheduler.stop()
    await repository.close()
  })

  it('旧的 NULL Slot receipt 只映射到 Session 原始 Slot', async () => {
    const { repository, runtime, scheduler, conversation } = await setup()
    await repository.createAgentSlot({
      id: 'slot-002',
      session_id: 'session-001',
      role_binding_id: 'binding-002',
      model_id: 'model-002',
      status: 'idle',
      created_at: '2026-10-14T10:01:00.000Z',
    })
    await repository.createTurn(
      {
        id: 'run-legacy', workspace_id: 'workspace-001', session_id: 'session-001',
        status: 'completed', attempt: 1, created_at: '2026-10-14T10:00:00.000Z', updated_at: '2026-10-14T10:00:00.000Z',
      },
      {
        id: 'task-legacy', workspace_id: 'workspace-001', session_id: 'session-001',
        run_id: 'run-legacy', slot_id: 'slot-001', title: '历史任务', status: 'completed',
        created_at: '2026-10-14T10:00:00.000Z', updated_at: '2026-10-14T10:00:00.000Z',
      },
      {
        id: 'message-legacy', session_id: 'session-001', run_id: 'run-legacy',
        sender_kind: 'user', sender_id: null, content: 'hello', created_at: '2026-10-14T10:00:00.000Z',
      },
    )
    await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'legacy-request', command: 'start',
      target_id: 'session-001', status: 'completed', dispatch_state: 'accepted',
      run_id: 'run-legacy', task_id: 'task-legacy', message_id: 'message-legacy',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    await expect(conversation.sendMessage('session-001', { content: 'hello', request_id: 'legacy-request' }))
      .resolves.toMatchObject({ run: { id: 'run-legacy' }, task: { id: 'task-legacy', slot_id: 'slot-001' } })
    await expect(conversation.sendMessage('session-001', {
      content: 'hello', request_id: 'legacy-request', agent_slot_id: 'slot-002',
    })).rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
    expect(runtime.responses).toEqual([])
    scheduler.stop()
    await repository.close()
  })

  it('ContextSource 缺失时在 Runtime dispatch 前 fail-closed，同键修复后可重派', async () => {
    const { repository, runtime, scheduler, conversation } = await setup()
    const sources = vi.spyOn(repository, 'getTaskContextSources').mockResolvedValue([])

    await expect(conversation.sendMessage('session-001', {
      content: '必须有可审计上下文',
      request_id: 'missing-context-source',
    })).rejects.toMatchObject({ code: 'context_source_missing', statusCode: 409 })

    expect(runtime.sendTurns).toBe(0)
    const failedSnapshot = await repository.getSessionSnapshot('session-001')
    const failedRun = failedSnapshot?.runs[0]
    const failedTask = failedSnapshot?.tasks[0]
    // 未越过 dispatch：Run/Task 不落终态，否则同键重放只能拿到一个已失败的 Run。
    expect(failedRun).toMatchObject({ status: 'running' })
    expect(failedTask?.status).not.toBe('completed')
    await expect(repository.getTaskContextSources(failedTask?.id ?? '')).resolves.toEqual([])
    await expect(repository.getCommandReceipt('workspace-001', 'missing-context-source', 'start'))
      .resolves.toMatchObject({ status: 'failed', dispatch_state: 'not_started' })

    sources.mockRestore()
    const retried = await conversation.sendMessage('session-001', {
      content: '必须有可审计上下文',
      request_id: 'missing-context-source',
    })
    expect(retried.run.id).toBe(failedRun?.id)
    expect(runtime.sendTurns).toBe(1)
    await runtime.permissionReady
    runtime.releaseTurn()
    await conversation.waitForTurn(retried.run.id)
    scheduler.stop()
    await repository.close()
  })

  it('cancel 取消 pending 权限，迟到回答返回 409', async () => {
    const { repository, runtime, scheduler, conversation } = await setup()
    const turn = await conversation.sendMessage('session-001', { content: '执行任务' })
    await runtime.permissionReady
    const permission = (await repository.getSessionSnapshot('session-001'))?.permissions[0]
    if (permission === undefined) {
      throw new Error('权限请求未持久化')
    }

    const receipt = await conversation.cancelRun(turn.run.id, { request_id: 'cancel-1' })
    expect(receipt.status).toBe('completed')
    await conversation.waitForTurn(turn.run.id)

    await expect(repository.getRun(turn.run.id)).resolves.toMatchObject({ status: 'cancelled' })
    await expect(repository.getPermissionRequest(permission.id))
      .resolves.toMatchObject({ status: 'expired', expiration_reason: 'cancelled' })
    // 已取消 Run 的迟到回答必须 409，不能把旧权限再发给 Adapter。
    await expect(conversation.answerPermission(permission.id, 'allow_once'))
      .rejects.toMatchObject({ code: 'permission_timeout' })
    expect(runtime.responses).toEqual([{ requestId: 900, cancelled: true }])
    scheduler.stop()
    await repository.close()
  })

  it('pending 权限取消失败不吞：Run 收敛 interrupted 并返回稳定错误', async () => {
    const { repository, runtime, scheduler, conversation } = await setup()
    const turn = await conversation.sendMessage('session-001', { content: '执行任务' })
    await runtime.permissionReady
    const permission = (await repository.getSessionSnapshot('session-001'))?.permissions[0]
    if (permission === undefined) {
      throw new Error('权限请求未持久化')
    }

    runtime.failRespondPermission = true
    await expect(conversation.cancelRun(turn.run.id, { request_id: 'cancel-1' }))
      .rejects.toMatchObject({ code: 'adapter_start_failed', statusCode: 502 })

    await expect(repository.getRun(turn.run.id)).resolves.toMatchObject({
      status: 'interrupted',
      error_code: 'permission_cancel_failed',
    })
    // 失败没有被伪装成 cancelled：权限仍 pending，等待用户/超时处理。
    await expect(repository.getPermissionRequest(permission.id)).resolves.toMatchObject({ status: 'pending' })
    runtime.releaseTurn()
    await conversation.waitForTurn(turn.run.id)
    scheduler.stop()
    await repository.close()
  })

  it('硬超时后 Adapter cancelled 不会把 Run 覆盖为 completed', async () => {
    const { repository, runtime, scheduler, conversation } = await setup()
    const turn = await conversation.sendMessage('session-001', { content: '执行任务' })
    await runtime.permissionReady
    const permission = (await repository.getPermissionRequest((await repository.getSessionSnapshot('session-001'))?.permissions[0]?.id ?? ''))
    if (permission === null) {
      throw new Error('权限请求未持久化')
    }
    const hardTimeout = new Date(new Date(permission.requested_at).getTime() + 31 * 60 * 1000)
    await scheduler.tickNow(hardTimeout)
    await conversation.waitForTurn(turn.run.id)
    expect(runtime.responses).toEqual([{ requestId: 900, cancelled: true }])
    expect((await repository.getRun(turn.run.id))?.status).toBe('interrupted')
    expect((await repository.getSessionSnapshot('session-001'))?.tasks[0]?.status).toBe('paused')
    scheduler.stop()
    await repository.close()
  })
})
