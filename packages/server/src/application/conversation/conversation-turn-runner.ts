import type {
  EventEnvelope,
  PermissionOption,
  PermissionRequestDto,
  RuntimeEvent,
  RunDto,
  TaskDto,
} from '@rolecast/contract'

import type {
  AgentRuntimePort,
  AgentRuntimeSession,
  AgentTurnDispatchSignal,
} from '../ports/agent-runtime-port.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { EventBusPort } from '../ports/event-bus-port.js'
import type { SecretRedactionPort } from '../ports/credential-store-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import type { RepositoryPort } from '../ports/repository-port.js'
import type { PermissionScheduler } from '../permission/permission-scheduler.js'
import type { RuntimeSessionRegistryPort } from '../sessions/session-service.js'
import type { CommandReceiptRecord } from '../ports/repository-port.js'
import { ApplicationError } from '../errors.js'
import { buildContextBundle as constructContextBundle, type ContextBundle } from '../context/context-builder.js'
import {
  errorCodeOf,
  eventType,
  payloadRequestId,
  payloadString,
  payloadText,
} from './conversation-payload.js'
import { isTerminalRunStatus } from './run-command-policy.js'

/** 终态收敛允许写入的 Run 状态。 */
export type FinalRunStatus = Extract<RunDto['status'], 'completed' | 'failed' | 'cancelled' | 'interrupted'>

/**
 * 单轮 turn 的可证明 dispatch 边界。
 *
 * `markDispatched` 只能由 Runtime 在请求真正发出后调用（或由已收到的
 * Runtime Event 反证）；在此之前回执不得写成 `completed/accepted`。
 */
interface DispatchBoundary {
  readonly dispatched: boolean
  markDispatched(): void
  /** 等待回执 accepted 的持久化完成；失败已被吞掉，由启动恢复兜底。 */
  settle(): Promise<void>
}

/** turn 执行、事件入库与终态 CAS 的依赖。 */
export interface TurnRunnerDependencies {
  readonly repository: RepositoryPort
  readonly runtime: AgentRuntimePort
  readonly sessions: RuntimeSessionRegistryPort
  readonly ids: IdGeneratorPort
  readonly clock: ClockPort
  readonly eventBus: EventBusPort
  readonly redaction: SecretRedactionPort
  readonly permissionScheduler: PermissionScheduler
  readonly cancelConfirmTimeoutMs?: number
}

/**
 * 执行单轮 ACP turn 并收敛状态。
 *
 * 所有 Run/Task 终态都通过 `state_revision` CAS 在单个 SQLite 事务内提交；
 * 迟到事件无法覆盖终态。取消通知本身不是停止证据，必须等待 turn 结束。
 */
export class ConversationTurnRunner {
  private readonly activeTurns = new Map<string, Promise<unknown>>()
  private readonly cancelConfirmTimeoutMs: number

  constructor(private readonly dependencies: TurnRunnerDependencies) {
    this.cancelConfirmTimeoutMs = dependencies.cancelConfirmTimeoutMs ?? 5_000
  }

  /** 等待指定 Run 的活动 turn 结束。 */
  async waitForTurn(runId: string): Promise<void> {
    await this.activeTurns.get(runId)
  }

  /** 该 Run 是否仍有未结束的 turn（取消未确认期间禁止叠加新 dispatch）。 */
  hasActiveTurn(runId: string): boolean {
    return this.activeTurns.has(runId)
  }

  /**
   * 释放仍属于该 Run 的 Slot claim。
   *
   * 只能在确认没有活动 turn 时调用；用于取消超时后旧 turn 已不存在、
   * 不会再有 finally 释放的路径。
   */
  async releaseClaim(runId: string): Promise<void> {
    const { repository } = this.dependencies
    const run = await repository.getRun(runId)
    if (run === null) {
      return
    }
    const snapshot = await repository.getSessionSnapshot(run.session_id)
    const task = snapshot?.tasks.find((candidate) => candidate.run_id === run.id)
    if (task === undefined) {
      return
    }
    await repository.releaseSlotActivity(task.slot_id, run.id)
  }

  /** 登记并异步消费 turn；返回 false 表示外部调用未发生。 */
  async dispatchTurn(input: {
    receipt: CommandReceiptRecord
    runtimeSession: AgentRuntimeSession
    run: RunDto
    task: TaskDto
    promptText: string
    runId: string
    taskId: string
    messageId: string
  }): Promise<boolean> {
    const { repository, runtime, clock } = this.dependencies
    // 旧 turn 仍在执行时叠加新 turn 会让同一 session 的事件归属错乱。
    if (this.activeTurns.has(input.run.id)) {
      return false
    }
    let contextBundle: ContextBundle
    try {
      contextBundle = await this.buildContextBundle(input)
    } catch (error: unknown) {
      // 未越过 dispatch：只把回执转成可安全重试的失败边界，Run 不落终态，
      // 否则同 key 重放会拿到一个不会再派发的已失败 Run。
      await this.failUndispatched({
        ...input.receipt,
        run_id: input.runId,
        task_id: input.taskId,
        message_id: input.messageId,
      }, 'context_source_missing')
      if (error instanceof ApplicationError) {
        throw error
      }
      throw new ApplicationError('无法重建 Agent 上下文来源', 'context_source_missing', 409)
    }
    let iterator: AsyncIterable<RuntimeEvent>
    const now = clock.now().toISOString()
    const expectedReceiptReferences = input.receipt.command === 'start' || input.receipt.command === 'retry'
      ? { run_id: input.runId, task_id: input.taskId, message_id: input.messageId }
      : {
          run_id: input.receipt.run_id ?? null,
          task_id: input.receipt.task_id ?? null,
          message_id: input.receipt.message_id ?? null,
        }
    const running = await repository.updateCommandReceipt({
      ...input.receipt,
      status: 'running',
      dispatch_state: 'started',
      run_id: input.runId,
      task_id: input.taskId,
      message_id: input.messageId,
      updated_at: now,
    }, input.receipt.status, input.receipt.dispatch_state, expectedReceiptReferences)
    if (running === null) {
      // 同键已被另一请求推进：绝不重复外部调用。
      const current = await repository.getCommandReceipt(
        input.receipt.workspace_id,
        input.receipt.request_id,
        input.receipt.command,
      )
      const sameTurn = current?.run_id === input.runId
        && current.task_id === input.taskId
        && current.message_id === input.messageId
      return sameTurn && current !== null && (current.status === 'completed' || current.status === 'running')
    }
    const boundary = this.createDispatchBoundary(running)
    const dispatch: AgentTurnDispatchSignal = { onDispatched: () => boundary.markDispatched() }
    try {
      iterator = runtime.sendTurn({
        session: input.runtimeSession,
        contextBundle,
      }, dispatch)
    } catch {
      await this.failUndispatched(running, 'adapter_start_failed')
      return false
    }
    // accepted 只能由 Runtime 的 dispatch 信号或已收到的 Runtime Event 触发；
    // 崩溃窗口内回执保持 running/started，启动恢复会按 ambiguous 收敛。
    const turn = this.consumeTurn(iterator, input.run, input.task, running, boundary)
    this.activeTurns.set(input.run.id, turn)
    void turn.then(
      () => this.activeTurns.delete(input.run.id),
      () => this.activeTurns.delete(input.run.id),
    )
    return true
  }

  private async buildContextBundle(input: {
    run: RunDto
    task: TaskDto
    promptText: string
    messageId: string
  }): Promise<ContextBundle> {
    const { repository } = this.dependencies
    const [slot, roleSnapshot, sources, message] = await Promise.all([
      repository.getAgentSlot(input.task.slot_id),
      repository.getAgentSlotRoleSnapshot(input.task.slot_id),
      repository.getTaskContextSources(input.task.id),
      repository.getRunInputMessage(input.run.id),
    ])
    if (
      slot === null
      || slot.session_id !== input.run.session_id
      || message === null
      || message.id !== input.messageId
      || message.content !== input.promptText
      || (slot.role_binding_id === undefined) !== (roleSnapshot === null)
      || (roleSnapshot !== null && (
        roleSnapshot.slot_id !== slot.id
        || roleSnapshot.workspace_id !== input.run.workspace_id
        || roleSnapshot.role_binding_id !== slot.role_binding_id
      ))
    ) {
      throw new ApplicationError('Task 的 Role 或 Message source 无效', 'context_source_missing', 409)
    }
    return constructContextBundle({
      taskId: input.task.id,
      messageId: input.messageId,
      taskInput: input.promptText,
      roleSnapshot,
      sources,
    })
  }

  /** 构造只写一次 accepted 的 dispatch 边界。 */
  private createDispatchBoundary(running: CommandReceiptRecord): DispatchBoundary {
    const { repository, clock } = this.dependencies
    let dispatched = false
    let accepted: Promise<void> = Promise.resolve()
    return {
      get dispatched() {
        return dispatched
      },
      markDispatched: () => {
        if (dispatched) {
          return
        }
        dispatched = true
        accepted = repository.updateCommandReceipt({
          ...running,
          status: 'completed',
          dispatch_state: 'accepted',
          updated_at: clock.now().toISOString(),
        }, 'running', 'started').then(
          () => undefined,
          () => undefined,
        )
      },
      settle: () => accepted,
    }
  }

  /**
   * 无法证明 dispatch 结果：保留 `started` 边界并转 ambiguous。
   *
   * CAS 未命中说明回执已不在预期边界，不能假设写入成功；抛错由调用方
   * fail-closed 保留现场，交由启动恢复处理。
   */
  private async markAmbiguous(receipt: CommandReceiptRecord): Promise<void> {
    const updated = await this.dependencies.repository.updateCommandReceipt({
      ...receipt,
      status: 'ambiguous',
      error_code: 'command_outcome_ambiguous',
      updated_at: this.dependencies.clock.now().toISOString(),
    }, receipt.status, receipt.dispatch_state)
    if (updated === null) {
      throw new Error('ambiguous command receipt was not persisted')
    }
  }

  /** 未越过 dispatch 的确定性失败：转 failed/not_dispatched 并保留引用。 */
  async failUndispatched(receipt: CommandReceiptRecord, errorCode: string): Promise<void> {
    await this.dependencies.repository.updateCommandReceipt({
      ...receipt,
      status: 'failed',
      dispatch_state: 'not_started',
      error_code: errorCode,
      updated_at: this.dependencies.clock.now().toISOString(),
    }, receipt.status, receipt.dispatch_state)
  }

  /**
   * 等待活动 turn 给出结束/取消证据。
   *
   * ACP `session/cancel` 只是 notification；超时后调用方必须按 interrupted 收敛。
   */
  async waitForActiveTurn(runId: string): Promise<void> {
    const turn = this.activeTurns.get(runId)
    if (turn === undefined) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        turn.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.cancelConfirmTimeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }

  /** 以最新 revision 原子收敛 Run/Task/claim。 */
  async finalizeRunToStatus(
    runId: string,
    status: FinalRunStatus,
    taskStatus: TaskDto['status'],
    errorCode?: string,
    eventTypeValue?: EventEnvelope['type'],
  ): Promise<RunDto | null> {
    const { repository, clock } = this.dependencies
    const current = await repository.getRun(runId)
    if (current === null || isTerminalRunStatus(current.status)) {
      return null
    }
    const revision = await repository.getRunStateRevision(runId)
    if (revision === null) {
      return null
    }
    const now = clock.now().toISOString()
    const snapshot = await repository.getSessionSnapshot(current.session_id)
    const task = snapshot?.tasks.find((candidate) => candidate.run_id === current.id) ?? null
    const nextRun: RunDto = {
      ...current,
      status,
      ended_at: now,
      updated_at: now,
      ...(errorCode === undefined ? {} : { error_code: errorCode }),
    }
    if (task === null) {
      return repository.updateRunIfRevision(nextRun, revision)
    }
    const event = eventTypeValue === undefined
      ? undefined
      : this.lifecycleEvent(current, eventTypeValue, now)
    const result = await repository.finalizeRun({
      run: nextRun,
      expectedStateRevision: revision,
      taskId: task.id,
      taskStatus,
      slotId: task.slot_id,
      releaseClaim: isTerminalRunStatus(status),
      ...(event === undefined ? {} : { event }),
    })
    return result?.run ?? null
  }

  /** 构造同一事务内追加的 Run 生命周期事件。 */
  lifecycleEvent(
    run: RunDto,
    type: EventEnvelope['type'],
    occurredAt: string,
  ): Omit<EventEnvelope, 'sequence'> {
    return {
      event_id: this.dependencies.ids.next('event'),
      schema_version: 1,
      workspace_id: run.workspace_id,
      session_id: run.session_id,
      run_id: run.id,
      type,
      source: 'conversation-service',
      occurred_at: occurredAt,
      payload: { run_id: run.id },
    }
  }

  /** 取消 Run 的 pending 权限；返回非空表示无法确定取消结果。 */
  async cancelPendingPermissions(run: RunDto): Promise<unknown | null> {
    const { repository, permissionScheduler } = this.dependencies
    const snapshot = await repository.getSessionSnapshot(run.session_id)
    for (const permission of snapshot?.permissions ?? []) {
      if (permission.status !== 'pending' || permission.run_id !== run.id) {
        continue
      }
      try {
        const cancelled = await permissionScheduler.cancel(permission.id)
        if (!cancelled) {
          const current = await repository.getPermissionRequest(permission.id)
          if (current !== null && current.status === 'pending') {
            throw new Error('permission has no active runtime')
          }
        }
      } catch (error: unknown) {
        return error
      }
    }
    return null
  }

  /** 消费已 dispatch 的 turn：事件入库、终态 CAS、失败收敛。 */
  private async consumeTurn(
    iterator: AsyncIterable<RuntimeEvent>,
    run: RunDto,
    task: TaskDto,
    running: CommandReceiptRecord,
    boundary: DispatchBoundary,
  ): Promise<void> {
    let cancelledEvidence = false
    // ambiguous 收敛一旦开始，写回失败必须原样传播，不能被下面的 catch
    // 当作「可证明未派发」降级为 failed/not_started。
    let ambiguousConvergence = false
    try {
      for await (const event of iterator) {
        // 收到事件本身即证明 Runtime 已开始执行该 turn。
        boundary.markDispatched()
        // 回执 accepted 必须先于事件入库/终态 CAS 落盘，避免终态 Run 配未完成回执。
        await boundary.settle()
        if (event.kind === 'turn_cancelled') {
          cancelledEvidence = true
        }
        await this.handleRuntimeEvent(event, run, task)
      }
      if (!boundary.dispatched) {
        // 正常结束但既无 dispatch 信号也无 Runtime Event：无法证明 Prompt 已写出。
        // 不能声称 accepted/completed；按结果未知 fail-closed 为 ambiguous。
        ambiguousConvergence = true
        await this.markAmbiguous(running)
        await this.finalizeRunToStatus(run.id, 'interrupted', 'paused', 'dispatch_unconfirmed')
        return
      }
      await boundary.settle()
      await this.completeRun(run, cancelledEvidence)
    } catch (error: unknown) {
      if (ambiguousConvergence) {
        // 回执仍可能停在 running/started：保留 claim 与现场，由启动恢复转 ambiguous。
        throw error
      }
      if (boundary.dispatched) {
        await boundary.settle()
        await this.failRun(run, error)
      } else {
        // 可证明未派发：回执回到可安全重试的失败边界，Run 收敛为可 resume 状态。
        const errorCode = errorCodeOf(error)
        await this.failUndispatched(running, errorCode)
        await this.finalizeRunToStatus(run.id, 'interrupted', 'paused', errorCode)
      }
    } finally {
      await boundary.settle()
      await this.releaseClaimAfterInterrupted(run, task, boundary.dispatched)
    }
  }

  /**
   * 取消未确认后旧 turn 才结束：此时 claim 不再需要保留，释放给后续命令。
   *
   * 未派发的失败保留 claim：同 key 重试需要复用该 Run，且不能让新的 start
   * 与即将 resume 的同一 ACP Session 并发。
   */
  private async releaseClaimAfterInterrupted(
    run: RunDto,
    task: TaskDto,
    dispatched: boolean,
  ): Promise<void> {
    if (!dispatched) {
      return
    }
    const { repository } = this.dependencies
    const current = await repository.getRun(run.id)
    if (current === null || current.status !== 'interrupted') {
      return
    }
    await repository.releaseSlotActivity(task.slot_id, run.id)
  }

  /** 正常结束：取消中的 turn 只有 turn_cancelled 才算确认停止。 */
  private async completeRun(run: RunDto, cancelledEvidence: boolean): Promise<void> {
    const current = await this.dependencies.repository.getRun(run.id)
    if (current === null || isTerminalRunStatus(current.status)) {
      return
    }
    if (current.status !== 'running' && current.status !== 'cancelling') {
      return
    }
    let status: FinalRunStatus
    if (current.status === 'cancelling') {
      status = cancelledEvidence ? 'cancelled' : 'interrupted'
    } else {
      status = cancelledEvidence ? 'cancelled' : 'completed'
    }
    await this.finalizeRunToStatus(run.id, status, taskStatusFor(status))
  }

  /** 异常结束：同样走 CAS 事务，迟到完成事件不能覆盖。 */
  private async failRun(run: RunDto, error: unknown): Promise<void> {
    const current = await this.dependencies.repository.getRun(run.id)
    if (current === null || isTerminalRunStatus(current.status)) {
      return
    }
    if (current.status !== 'running' && current.status !== 'cancelling') {
      return
    }
    const status: FinalRunStatus = current.status === 'cancelling' ? 'interrupted' : 'failed'
    await this.finalizeRunToStatus(run.id, status, taskStatusFor(status), errorCodeOf(error))
  }

  /** 只追加事件，不改 Run/Task 状态；终态收敛统一走 CAS 事务。 */
  private async handleRuntimeEvent(
    event: RuntimeEvent,
    run: RunDto,
    task: TaskDto,
  ): Promise<void> {
    const { repository, clock, eventBus, redaction, sessions, permissionScheduler } = this.dependencies
    const safeEvent: RuntimeEvent = {
      ...event,
      payload: redaction.redactRecord(event.payload),
    }
    const envelope = await repository.appendEvent({
      event_id: this.dependencies.ids.next('event'),
      schema_version: 1,
      workspace_id: run.workspace_id,
      session_id: run.session_id,
      run_id: run.id,
      type: eventType(safeEvent),
      source: 'acp-runtime',
      occurred_at: clock.now().toISOString(),
      payload: safeEvent.payload,
    })
    await eventBus.publish(envelope)
    if (safeEvent.kind === 'agent_message_chunk') {
      const text = payloadText(safeEvent.payload)
      if (text !== null) {
        await repository.saveMessage({
          id: this.dependencies.ids.next('message'),
          session_id: run.session_id,
          run_id: run.id,
          sender_kind: 'agent',
          sender_id: task.slot_id,
          content: text,
          created_at: envelope.occurred_at,
        })
      }
      return
    }
    if (safeEvent.kind !== 'permission_requested') {
      return
    }
    // 只有仍在执行的 Run 才接受新的 pending 权限；终态、取消中、interrupted 都不登记。
    const current = await repository.getRun(run.id)
    if (current === null || (current.status !== 'running' && current.status !== 'waiting_user')) {
      return
    }
    const runtimeSession = sessions.getRuntimeSession(task.slot_id)
    if (runtimeSession === null) {
      return
    }
    await permissionScheduler.register(
      this.toPermission(safeEvent, run, task, envelope.occurred_at),
      runtimeSession,
    )
  }

  private toPermission(
    event: RuntimeEvent,
    run: RunDto,
    task: TaskDto,
    requestedAt: string,
  ): PermissionRequestDto {
    const payload = event.payload
    const adapterRequestId = payloadRequestId(payload)
    const rawOptions = Array.isArray(payload.options) ? payload.options : []
    const adapterOptions = rawOptions.flatMap((option, index) => {
      if (typeof option !== 'object' || option === null || Array.isArray(option)) {
        return []
      }
      const record = option as Record<string, unknown>
      const optionId = typeof record.optionId === 'string' ? record.optionId : typeof record.option_id === 'string' ? record.option_id : `option-${index + 1}`
      const name = typeof record.name === 'string' ? record.name : optionId
      const kind: PermissionOption['kind'] = record.kind === 'allow_always' || record.kind === 'reject_once' ? record.kind : 'allow_once'
      return [{ option_id: optionId, name, kind }]
    })
    const expiresAt = new Date(new Date(requestedAt).getTime() + 30 * 60 * 1000).toISOString()
    return {
      id: this.dependencies.ids.next('permission'),
      run_id: run.id,
      task_id: task.id,
      slot_id: task.slot_id,
      capability: payloadString(payload, ['capability']) ?? 'unknown',
      description: payloadString(payload, ['description', 'title']) ?? 'Agent 请求执行权限',
      adapter_options: adapterOptions,
      status: 'pending',
      requested_at: requestedAt,
      soft_timeout_at: new Date(new Date(requestedAt).getTime() + 5 * 60 * 1000).toISOString(),
      expires_at: expiresAt,
      ...(adapterRequestId === null ? {} : { adapter_request_id: adapterRequestId }),
    }
  }
}

/** 终态 Run 对应的 Task 状态。 */
const taskStatusFor = (status: FinalRunStatus): TaskDto['status'] => {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'interrupted':
      return 'paused'
  }
}
