import type {
  AgentSlotDto,
  HandoffRequest,
  MessageDto,
  RunCommandReceipt,
  RunCommandRequest,
  RunDto,
  SendMessageRequest,
  TaskDto,
} from '@rolecast/contract'

import { PermissionExpiredError } from '../permission/permission-state-coordinator.js'
import type { PermissionScheduler } from '../permission/permission-scheduler.js'
import { ApplicationError } from '../errors.js'
import type { AgentRuntimePort } from '../ports/agent-runtime-port.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { EventBusPort } from '../ports/event-bus-port.js'
import type { SecretRedactionPort } from '../ports/credential-store-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import type { RepositoryPort } from '../ports/repository-port.js'
import type { RuntimeSessionRegistryPort } from '../sessions/session-service.js'
import { isTerminalRunStatus } from './run-command-policy.js'
import { ensureSlotClaim, requireRevision } from './conversation-access.js'
import { ConversationTurnRunner } from './conversation-turn-runner.js'
import { HandoffService } from './handoff-service.js'
import { RunCommandService } from './run-command-service.js'
import { findTask } from './conversation-access.js'
import { digestMessageContent } from './input-digest.js'

type StartTurnRefs = { run: RunDto; task: TaskDto }
type Receipt = Awaited<ReturnType<RepositoryPort['insertCommandReceipt']>>
type ReceiptBoundary = {
  status: Receipt['status']
  dispatch_state: Receipt['dispatch_state']
  target_id: string
  target_slot_id: string | null
}

/** 单 Agent 对话用例服务。 */
export class ConversationService {
  private readonly turns: ConversationTurnRunner
  private readonly commands: RunCommandService
  private readonly handoffs: HandoffService

  constructor(
    private readonly repository: RepositoryPort,
    private readonly runtime: AgentRuntimePort,
    private readonly sessions: RuntimeSessionRegistryPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    eventBus: EventBusPort,
    private readonly permissionScheduler: PermissionScheduler,
    redaction: SecretRedactionPort,
    cancelConfirmTimeoutMs?: number,
  ) {
    this.turns = new ConversationTurnRunner({
      repository,
      runtime,
      sessions,
      ids,
      clock,
      eventBus,
      redaction,
      permissionScheduler,
      ...(cancelConfirmTimeoutMs === undefined ? {} : { cancelConfirmTimeoutMs }),
    })
    this.commands = new RunCommandService(repository, runtime, sessions, ids, clock, this.turns)
    this.handoffs = new HandoffService(repository, ids, clock, eventBus)
  }

  /**
   * 创建用户消息、Run 和 Task，并异步开始 ACP 流。
   *
   * `request_id` 是幂等键：同键同输入重放返回既有 Run/Task，不重复写 Message
   * 或调用 sendTurn。回执重放先于 Runtime 检查，已完成的命令即使 Runtime 已
   * 不可用也能返回既有结果。
   */
  async sendMessage(sessionId: string, input: SendMessageRequest): Promise<StartTurnRefs> {
    const snapshot = await this.repository.getSessionSnapshot(sessionId)
    if (snapshot === null) {
      throw new ApplicationError('Session 不存在', 'not_found', 404, { resource: 'session' })
    }
    const defaultSlot = this.requireSlot(snapshot.agent_slots)
    const slot = this.requireSlot(snapshot.agent_slots, input.agent_slot_id)
    const workspaceId = snapshot.session.workspace_id
    const requestId = input.request_id ?? this.ids.next('request')

    const existing = await this.repository.getCommandReceipt(workspaceId, requestId, 'start')
    if (existing !== null) {
      return this.replayStart(existing, sessionId, slot, input.content, defaultSlot.id)
    }
    // 新命令才需要活动 Runtime；回执重放不依赖它。
    const runtimeSession = this.sessions.getRuntimeSession(slot.id)
    if (runtimeSession === null) {
      throw new ApplicationError('Agent Runtime 已不可用，请重新创建 Session', 'state_conflict', 409)
    }
    const now = this.clock.now().toISOString()
    const run = this.newStartRun(workspaceId, sessionId, now)
    const task = this.newStartTask(run, slot, now)
    const message = this.newUserMessage(sessionId, run.id, input.content, now)
    const reserved = await this.repository.insertCommandReceipt({
      workspace_id: workspaceId,
      request_id: requestId,
      command: 'start',
      target_id: sessionId,
      target_slot_id: slot.id,
      status: 'reserved',
      dispatch_state: 'not_started',
      input_digest: digestMessageContent(input.content),
      updated_at: now,
    })
    if (
      reserved.target_id !== sessionId
      || (reserved.target_slot_id ?? defaultSlot.id) !== slot.id
    ) {
      throw new ApplicationError('同 request_id 指向不同目标', 'state_conflict', 409)
    }
    if (reserved.status !== 'reserved') {
      return this.replayStart(reserved, sessionId, slot, input.content, defaultSlot.id)
    }
    const created = await this.createTurnOrReplay(
      reserved,
      run,
      task,
      message,
      {
        status: 'reserved',
        dispatch_state: 'not_started',
        target_id: sessionId,
        target_slot_id: reserved.target_slot_id ?? null,
      },
      sessionId,
      slot,
      defaultSlot.id,
      input.content,
      now,
    )
    if (created.kind === 'replay') {
      return created.refs
    }
    const dispatched = await this.turns.dispatchTurn({
      receipt: reserved,
      runtimeSession,
      run,
      task,
      promptText: input.content,
      runId: run.id,
      taskId: task.id,
      messageId: message.id,
    })
    if (!dispatched) {
      // 未越过 dispatch：Run/Task/Message 保留，同 key 可安全重试。
      throw new ApplicationError('Agent Runtime 暂时不可用，请重试', 'adapter_start_failed', 502)
    }
    return { run, task }
  }

  /** 原子创建 start 的 Run/Task/Message 并取得 claim。 */
  private async createTurnOrReplay(
    receipt: Receipt,
    run: RunDto,
    task: TaskDto,
    message: MessageDto,
    expected: ReceiptBoundary,
    sessionId: string,
    slot: AgentSlotDto,
    defaultSlotId: string,
    content: string,
    now: string,
  ): Promise<{ kind: 'created' } | { kind: 'replay'; refs: StartTurnRefs }> {
    let outcome: Awaited<ReturnType<RepositoryPort['createTurnWithReceipt']>>
    try {
      outcome = await this.repository.createTurnWithReceipt(run, task, message, receipt, expected, now)
    } catch {
      await this.turns.failUndispatched(receipt, 'db_unavailable')
      throw new ApplicationError('无法创建 Run', 'db_unavailable', 503)
    }
    if (outcome === 'created') {
      return { kind: 'created' }
    }
    if (outcome === 'slot_busy') {
      throw new ApplicationError('该 Slot 已有活动 Run', 'slot_busy', 409)
    }
    if (outcome === 'slot_unavailable') {
      throw new ApplicationError('Agent Slot 不存在', 'not_found', 404, { resource: 'agent_slot' })
    }
    const current = await this.repository.getCommandReceipt(
      receipt.workspace_id,
      receipt.request_id,
      receipt.command,
    )
    if (current === null) {
      throw new ApplicationError('命令回执已丢失', 'state_conflict', 409)
    }
    return { kind: 'replay', refs: await this.replayStart(current, sessionId, slot, content, defaultSlotId) }
  }

  /** 同 key 重放：返回既有 Run/Task，不重复副作用。 */
  private async replayStart(
    receipt: Receipt,
    sessionId: string,
    slot: AgentSlotDto,
    content: string,
    defaultSlotId: string,
  ): Promise<StartTurnRefs> {
    if (
      receipt.target_id !== sessionId
      || (receipt.target_slot_id ?? defaultSlotId) !== slot.id
    ) {
      throw new ApplicationError('同 request_id 指向不同目标', 'state_conflict', 409)
    }
    // 摘要覆盖「失败发生在创建 Run 之前」的回执；旧回执没有摘要时退化为比较 Message。
    if (receipt.input_digest !== undefined && receipt.input_digest !== digestMessageContent(content)) {
      throw new ApplicationError('同 request_id 的输入不一致', 'state_conflict', 409)
    }
    if (receipt.input_digest === undefined && receipt.message_id !== undefined) {
      const original = await this.repository.getRunInputMessage(receipt.run_id ?? '')
      if (original !== null && original.content !== content) {
        throw new ApplicationError('同 request_id 的输入不一致', 'state_conflict', 409)
      }
    }
    if (receipt.status === 'ambiguous') {
      throw new ApplicationError('该命令结果不确定，请使用新的 request_id', 'command_outcome_ambiguous', 409)
    }
    if (receipt.status === 'completed' || receipt.status === 'running' || receipt.status === 'reserved') {
      // running/started 但已无活动 turn：结果未知（例如 ambiguous 写回失败），
      // 不能把既有 Run 当作成功回执返回。
      if (
        receipt.status === 'running'
        && receipt.dispatch_state === 'started'
        && !this.turns.hasActiveTurn(receipt.run_id ?? '')
      ) {
        throw new ApplicationError('该命令结果不确定，请使用新的 request_id', 'command_outcome_ambiguous', 409)
      }
      const refs = await this.readTurnRefs(receipt, sessionId)
      if (refs !== null) {
        if (refs.task.slot_id !== slot.id) {
          throw new ApplicationError('同 request_id 指向不同 Slot', 'state_conflict', 409)
        }
        return refs
      }
      throw new ApplicationError('同 request_id 的命令仍在进行中', 'state_conflict', 409)
    }
    // failed：只有可证明未派发的失败才允许同 key 重试。
    if (receipt.dispatch_state !== 'not_started') {
      throw new ApplicationError('该命令结果不确定，请使用新的 request_id', 'command_outcome_ambiguous', 409)
    }
    const existing = await this.readTurnRefs(receipt, sessionId)
    if (existing !== null) {
      if (existing.task.slot_id !== slot.id) {
        throw new ApplicationError('同 request_id 指向不同 Slot', 'state_conflict', 409)
      }
      return this.redispatchStart(receipt, existing, sessionId)
    }
    // 失败发生在创建 Run 之前（例如 slot_busy）：用同 key 重新原子创建。
    const runtimeSession = this.sessions.getRuntimeSession(slot.id)
    if (runtimeSession === null) {
      throw new ApplicationError('Agent Runtime 已不可用，请重新创建 Session', 'state_conflict', 409)
    }
    const now = this.clock.now().toISOString()
    const run = this.newStartRun(receipt.workspace_id, sessionId, now)
    const task = this.newStartTask(run, slot, now)
    const message = this.newUserMessage(sessionId, run.id, content, now)
    const created = await this.createTurnOrReplay(
      receipt,
      run,
      task,
      message,
      {
        status: 'failed',
        dispatch_state: 'not_started',
        target_id: sessionId,
        target_slot_id: receipt.target_slot_id ?? null,
      },
      sessionId,
      slot,
      defaultSlotId,
      content,
      now,
    )
    if (created.kind === 'replay') {
      return created.refs
    }
    const dispatched = await this.turns.dispatchTurn({
      receipt,
      runtimeSession,
      run,
      task,
      promptText: content,
      runId: run.id,
      taskId: task.id,
      messageId: message.id,
    })
    if (!dispatched) {
      throw new ApplicationError('Agent Runtime 暂时不可用，请重试', 'adapter_start_failed', 502)
    }
    return { run, task }
  }

  /** 复用已创建但未 dispatch 的 start Run 重新派发。 */
  private async redispatchStart(
    receipt: Receipt,
    refs: StartTurnRefs,
    sessionId: string,
  ): Promise<StartTurnRefs> {
    // Run 已终态说明结果已产生，直接幂等返回，不再重放输入。
    if (isTerminalRunStatus(refs.run.status)) {
      return refs
    }
    // 取消超时后旧 turn 可能仍在同一 ACP Session 上执行；禁止叠加新 turn。
    if (this.turns.hasActiveTurn(refs.run.id)) {
      throw new ApplicationError('该 Run 仍有未结束的 turn，请稍后重试', 'state_conflict', 409)
    }
    await ensureSlotClaim(this.repository, refs.task, refs.run, this.clock.now().toISOString())
    // 重启恢复可能把它收敛为 paused/interrupted；派发前必须重新激活。
    let activeRun = refs.run
    if (refs.run.status === 'paused' || refs.run.status === 'interrupted') {
      const revision = await requireRevision(this.repository, refs.run.id)
      const activated = await this.repository.finalizeRun({
        run: {
          ...refs.run,
          status: 'running',
          ended_at: undefined,
          error_code: undefined,
          updated_at: this.clock.now().toISOString(),
        },
        expectedStateRevision: revision,
        taskId: refs.task.id,
        taskStatus: 'running',
        slotId: refs.task.slot_id,
        releaseClaim: false,
      })
      if (activated === null) {
        throw new ApplicationError('Run 状态已变化', 'state_conflict', 409)
      }
      activeRun = activated.run
    } else if (activeRun.status !== 'running') {
      throw new ApplicationError('Run 状态已变化', 'state_conflict', 409)
    }
    const input = await this.repository.getRunInputMessage(activeRun.id)
    const runtimeSession = this.sessions.getRuntimeSession(refs.task.slot_id)
    if (input === null || runtimeSession === null) {
      throw new ApplicationError('Agent Runtime 已不可用，请重新创建 Session', 'state_conflict', 409)
    }
    const dispatched = await this.turns.dispatchTurn({
      receipt,
      runtimeSession,
      run: activeRun,
      task: refs.task,
      promptText: input.content,
      runId: activeRun.id,
      taskId: refs.task.id,
      messageId: input.id,
    })
    if (!dispatched) {
      throw new ApplicationError('Agent Runtime 暂时不可用，请重试', 'adapter_start_failed', 502)
    }
    return { run: activeRun, task: refs.task }
  }

  /** 读取回执引用的 Run/Task；引用不完整或已失效时返回 null。 */
  private async readTurnRefs(receipt: Receipt, sessionId: string): Promise<StartTurnRefs | null> {
    if (receipt.run_id === undefined || receipt.task_id === undefined) {
      return null
    }
    const run = await this.repository.getRun(receipt.run_id)
    const task = await findTask(this.repository, sessionId, receipt.task_id)
    if (run === null || task === null) {
      return null
    }
    return { run, task }
  }

  /** resume：在同一 Run/attempt 上重放原用户输入。 */
  resumeRun(runId: string, input: RunCommandRequest): Promise<RunCommandReceipt> {
    return this.commands.resumeRun(runId, input)
  }

  /** retry：建立新 ACP Session、持久化 attachment，并创建 attempt+1 的新 Run。 */
  retryRun(runId: string, input: RunCommandRequest): Promise<RunCommandReceipt> {
    return this.commands.retryRun(runId, input)
  }

  /** cancel：CAS 到 cancelling 后等待活动 turn 的取消证据。 */
  cancelRun(runId: string, input: RunCommandRequest): Promise<RunCommandReceipt> {
    return this.commands.cancelRun(runId, input)
  }

  /** 从已完成 Run 创建定向 handoff Message；不自动 dispatch 或注入上下文。 */
  createHandoff(sessionId: string, input: HandoffRequest): Promise<MessageDto> {
    return this.handoffs.create(sessionId, input)
  }

  /** 等待某一轮对话完成，供集成测试和优雅关闭使用。 */
  waitForTurn(runId: string): Promise<void> {
    return this.turns.waitForTurn(runId)
  }

  /** 获取会话消息和运行快照。 */
  async getActivity(sessionId: string) {
    const snapshot = await this.repository.getSessionSnapshot(sessionId)
    if (snapshot === null) {
      throw new ApplicationError('Session 不存在', 'not_found', 404, { resource: 'session' })
    }
    return snapshot
  }

  /** 回答仍处于 pending 的权限请求。 */
  async answerPermission(requestId: string, optionId: string): Promise<void> {
    const request = await this.repository.getPermissionRequest(requestId)
    if (request === null) {
      throw new ApplicationError('权限请求不存在', 'permission_not_found', 404)
    }
    if (request.status === 'expired') {
      throw new PermissionExpiredError(requestId)
    }
    if (request.status !== 'pending') {
      throw new ApplicationError('权限请求已处理', 'state_conflict', 409)
    }
    // Run 已终态（例如取消）时，迟到的回答必须 409，不能复活 pending。
    const run = await this.repository.getRun(request.run_id)
    if (run === null) {
      throw new ApplicationError('Run 不存在', 'not_found', 404, { resource: 'run' })
    }
    if (run.status !== 'running' && run.status !== 'waiting_user') {
      throw new ApplicationError('Run 已结束，权限请求不可再回答', 'state_conflict', 409)
    }
    const runtimeSession = this.sessions.getRuntimeSession(request.slot_id)
    if (runtimeSession === null) {
      throw new ApplicationError('权限请求所属 Runtime 已不可用', 'state_conflict', 409)
    }
    await this.permissionScheduler.answer(requestId, optionId)
  }

  private newStartRun(workspaceId: string, sessionId: string, now: string): RunDto {
    return {
      id: this.ids.next('run'),
      workspace_id: workspaceId,
      session_id: sessionId,
      status: 'running',
      attempt: 1,
      started_at: now,
      created_at: now,
      updated_at: now,
    }
  }

  private newStartTask(run: RunDto, slot: AgentSlotDto, now: string): TaskDto {
    return {
      id: this.ids.next('task'),
      workspace_id: run.workspace_id,
      session_id: run.session_id,
      run_id: run.id,
      slot_id: slot.id,
      title: '处理用户消息',
      status: 'running',
      created_at: now,
      updated_at: now,
    }
  }

  private newUserMessage(sessionId: string, runId: string, content: string, now: string): MessageDto {
    return {
      id: this.ids.next('message'),
      session_id: sessionId,
      run_id: runId,
      sender_kind: 'user',
      sender_id: null,
      content,
      created_at: now,
    }
  }

  private requireSlot(slots: readonly AgentSlotDto[], slotId?: string): AgentSlotDto {
    // Phase 1A 的原始 Slot 未绑定 Role；Phase 2 新增 Slot 必须绑定 RoleBinding。
    // 因此旧客户端的默认目标按原始 Slot 选择，不依赖 created_at/id 的排序偶然性。
    const slot = slotId === undefined
      ? slots.find((candidate) => candidate.role_binding_id === undefined) ?? slots[0]
      : slots.find((candidate) => candidate.id === slotId)
    if (slot === undefined) {
      if (slotId !== undefined) {
        throw new ApplicationError('AgentSlot 不属于当前 Session', 'not_found', 404, { resource: 'agent_slot' })
      }
      throw new ApplicationError('Session 没有可执行的 AgentSlot', 'state_conflict', 409)
    }
    return slot
  }
}
