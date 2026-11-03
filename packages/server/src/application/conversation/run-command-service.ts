import type { RunCommandReceipt, RunCommandRequest, RunDto, TaskDto } from '@rolecast/contract'

import { ApplicationError } from '../errors.js'
import type { AgentRuntimePort } from '../ports/agent-runtime-port.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import type { RepositoryPort } from '../ports/repository-port.js'
import type { RuntimeSessionRegistryPort } from '../sessions/session-service.js'
import {
  canCancelRun,
  canResumeRun,
  canRetryRun,
  isTerminalRunStatus,
} from './run-command-policy.js'
import { errorCodeOf, toReceiptDto } from './conversation-payload.js'
import type { ConversationTurnRunner } from './conversation-turn-runner.js'
import {
  assertNoPendingPermission,
  discardRuntimeSession,
  ensureRuntimeSession,
  ensureSlotClaim,
  requireAttachment,
  requireRevision,
  requireRun,
  requireTask,
} from './conversation-access.js'

type Receipt = Awaited<ReturnType<RepositoryPort['insertCommandReceipt']>>

/** Run 命令（resume / retry / cancel）用例。 */
export class RunCommandService {
  constructor(
    private readonly repository: RepositoryPort,
    private readonly runtime: AgentRuntimePort,
    private readonly sessions: RuntimeSessionRegistryPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly turns: ConversationTurnRunner,
  ) {}

  /** resume：在同一 Run/attempt 上重放原用户输入。 */
  async resumeRun(runId: string, input: RunCommandRequest): Promise<RunCommandReceipt> {
    const run = await requireRun(this.repository, runId)
    // 回执重放先于状态检查：已完成的命令即使 Run 已推进也返回原结果。
    const receipt = await this.reserveCommand(run, 'resume', input.request_id)
    if (receipt.status === 'completed') {
      return toReceiptDto(receipt)
    }
    if (receipt.status === 'ambiguous') {
      throw new ApplicationError('该命令结果不确定，请使用新的 request_id', 'command_outcome_ambiguous', 409)
    }
    if (receipt.status === 'failed' && receipt.dispatch_state !== 'not_started') {
      throw new ApplicationError('该命令结果不确定，请使用新的 request_id', 'command_outcome_ambiguous', 409)
    }
    // 取消超时后旧 turn 可能仍在同一 ACP Session 上执行；必须先确认它已结束。
    if (this.turns.hasActiveTurn(run.id)) {
      await this.turns.failUndispatched(receipt, 'state_conflict')
      throw new ApplicationError('该 Run 仍有未结束的 turn，请稍后重试', 'state_conflict', 409)
    }
    const message = await this.repository.getRunInputMessage(run.id)
    if (message === null) {
      await this.turns.failUndispatched(receipt, 'input_message_missing')
      throw new ApplicationError('无法恢复原始输入', 'state_conflict', 409)
    }
    const task = await requireTask(this.repository, run)
    // claim 被其他 Run 占用时 resume 会与同一 ACP Session 上的活动 turn 并发。
    try {
      await ensureSlotClaim(this.repository, task, run, this.clock.now().toISOString())
    } catch (error: unknown) {
      await this.turns.failUndispatched(receipt, errorCodeOf(error))
      throw error
    }
    let activeRun = run
    // failed/not_started 且 Run 已由上次尝试激活：直接重新 dispatch。
    const alreadyActivated = receipt.status === 'failed' && run.status === 'running'
    if (!alreadyActivated) {
      if (!canResumeRun(run.status)) {
        await this.turns.failUndispatched(receipt, 'state_conflict')
        throw new ApplicationError('该 Run 当前不可 resume', 'state_conflict', 409)
      }
      await assertNoPendingPermission(this.repository, run)
      const now = this.clock.now().toISOString()
      const revision = await requireRevision(this.repository, run.id)
      const activated = await this.repository.finalizeRun({
        run: { ...run, status: 'running', ended_at: undefined, error_code: undefined, updated_at: now },
        expectedStateRevision: revision,
        taskId: task.id,
        taskStatus: 'running',
        slotId: task.slot_id,
        releaseClaim: false,
        event: this.turns.lifecycleEvent(run, 'run.resumed', now),
      })
      if (activated === null) {
        await this.turns.failUndispatched(receipt, 'state_conflict')
        throw new ApplicationError('Run 状态已变化', 'state_conflict', 409)
      }
      activeRun = activated.run
    }
    const runtimeSession = await ensureRuntimeSession(this.sessions, task.slot_id)
    const dispatched = await this.turns.dispatchTurn({
      receipt,
      runtimeSession,
      run: activeRun,
      task,
      promptText: message.content,
      runId: run.id,
      taskId: task.id,
      messageId: message.id,
    })
    if (!dispatched) {
      // 未派发成功：Run 不能留在没有 turn 的 running。
      await this.turns.finalizeRunToStatus(run.id, 'interrupted', 'paused', 'adapter_start_failed')
      throw new ApplicationError('Agent Runtime 暂时不可用，请重试', 'adapter_start_failed', 502)
    }
    return { request_id: input.request_id, status: 'completed', run_id: run.id, task_id: task.id }
  }

  /** retry：建立新 ACP Session、持久化 attachment，并创建 attempt+1 的新 Run。 */
  async retryRun(runId: string, input: RunCommandRequest): Promise<RunCommandReceipt> {
    const run = await requireRun(this.repository, runId)
    const receipt = await this.reserveCommand(run, 'retry', input.request_id)
    if (receipt.status === 'completed') {
      return toReceiptDto(receipt)
    }
    if (receipt.status === 'ambiguous') {
      throw new ApplicationError('该命令结果不确定，请使用新的 request_id', 'command_outcome_ambiguous', 409)
    }
    if (receipt.status === 'failed' && receipt.dispatch_state !== 'not_started') {
      throw new ApplicationError('该命令结果不确定，请使用新的 request_id', 'command_outcome_ambiguous', 409)
    }
    // 取消超时后父 Run 可能仍有未结束的 turn；此时打开新 Session、迁移 claim
    // 并派发新 turn 会绕过 start/resume 防护，与旧 turn 并发。
    if (this.turns.hasActiveTurn(run.id)) {
      await this.turns.failUndispatched(receipt, 'state_conflict')
      throw new ApplicationError('该 Run 仍有未结束的 turn，请稍后重试', 'state_conflict', 409)
    }
    // 上次尝试已创建子 Run 但未 dispatch：同 key 复用该 attempt。
    if (receipt.status === 'failed' && receipt.run_id !== undefined) {
      return this.redispatchRetry(receipt, input.request_id)
    }
    if (!canRetryRun(run.status)) {
      await this.turns.failUndispatched(receipt, 'state_conflict')
      throw new ApplicationError('该 Run 当前不可 retry', 'state_conflict', 409)
    }
    await assertNoPendingPermission(this.repository, run)
    const message = await this.repository.getRunInputMessage(run.id)
    if (message === null) {
      await this.turns.failUndispatched(receipt, 'input_message_missing')
      throw new ApplicationError('无法恢复原始输入', 'state_conflict', 409)
    }
    const task = await requireTask(this.repository, run)
    const attachment = await requireAttachment(this.repository, run)
    if (this.sessions.openRuntimeSession === undefined) {
      await this.turns.failUndispatched(receipt, 'runtime_unavailable')
      throw new ApplicationError('Runtime 不支持 retry', 'state_conflict', 409)
    }
    const slot = await this.repository.getAgentSlot(task.slot_id)
    if (slot === null) {
      await this.turns.failUndispatched(receipt, 'slot_missing')
      throw new ApplicationError('Run 的 Slot 不存在', 'state_conflict', 409)
    }
    let opened: Awaited<ReturnType<NonNullable<RuntimeSessionRegistryPort['openRuntimeSession']>>>
    try {
      opened = await this.sessions.openRuntimeSession({
        sessionId: run.session_id,
        slotId: task.slot_id,
        providerConnectionId: attachment.provider_connection_id,
        modelId: slot.model_id,
      })
    } catch (error: unknown) {
      // 未建立新 attempt：不写 Run/Task。
      await this.turns.failUndispatched(receipt, errorCodeOf(error))
      throw new ApplicationError('Provider 暂时无法建立新 Session', 'adapter_start_failed', 502)
    }
    const now = this.clock.now().toISOString()
    const nextRun = this.newRetryRun(run, now)
    const nextTask: TaskDto = {
      ...task,
      id: this.ids.next('task'),
      run_id: nextRun.id,
      status: 'running',
      created_at: now,
      updated_at: now,
    }
    let retryReceipt: Receipt | null
    try {
      retryReceipt = await this.repository.createRetryTurn(
        run.id,
        nextRun,
        nextTask,
        receipt,
        {
          status: receipt.status,
          dispatch_state: receipt.dispatch_state,
          run_id: receipt.run_id ?? null,
          task_id: receipt.task_id ?? null,
          message_id: receipt.message_id ?? null,
        },
        now,
      )
    } catch {
      await discardRuntimeSession(this.runtime, opened)
      await this.turns.failUndispatched(receipt, 'db_unavailable')
      throw new ApplicationError('无法创建新的 retry attempt', 'db_unavailable', 503)
    }
    if (retryReceipt === null) {
      // 新 ACP Session 已建立但没有可追踪的 Run：必须立即回收。
      await discardRuntimeSession(this.runtime, opened)
      await this.turns.failUndispatched(receipt, 'state_conflict')
      throw new ApplicationError('该 Run 已有后续 attempt 或 Slot 忙碌', 'state_conflict', 409)
    }
    // attachment 与内存 Runtime 必须指向新 Session；持久化失败时 CAS 回滚子 Run。
    try {
      await this.repository.saveRuntimeAttachment(opened.attachment)
    } catch {
      const rolledBack = await this.repository.rollbackRetryTurn(
        retryReceipt,
        nextRun.id,
        run.id,
        task.slot_id,
      )
      if (!rolledBack) {
        throw new ApplicationError('retry 派发状态已变化，保留现场供恢复', 'state_conflict', 409)
      }
      await discardRuntimeSession(this.runtime, opened)
      throw new ApplicationError('无法持久化新的 Runtime attachment', 'db_unavailable', 503)
    }
    await this.sessions.replaceRuntimeSession?.(task.slot_id, opened)
    const dispatched = await this.turns.dispatchTurn({
      receipt: retryReceipt,
      runtimeSession: opened.session,
      run: nextRun,
      task: nextTask,
      promptText: message.content,
      runId: nextRun.id,
      taskId: nextTask.id,
      messageId: message.id,
    })
    if (!dispatched) {
      throw new ApplicationError('Agent Runtime 暂时不可用，请重试', 'adapter_start_failed', 502)
    }
    return { request_id: input.request_id, status: 'completed', run_id: nextRun.id, task_id: nextTask.id }
  }

  /** 同 key 重试已有子 Run：不新建 attempt/Session，只重新 dispatch。 */
  private async redispatchRetry(receipt: Receipt, requestId: string): Promise<RunCommandReceipt> {
    const child = await this.repository.getRun(receipt.run_id ?? '')
    if (child === null) {
      throw new ApplicationError('retry 结果引用已失效', 'state_conflict', 409)
    }
    const task = await requireTask(this.repository, child)
    const message = await this.repository.getRunInputMessage(child.id)
    if (message === null) {
      await this.turns.failUndispatched(receipt, 'input_message_missing')
      throw new ApplicationError('无法恢复原始输入', 'state_conflict', 409)
    }
    // 结果已产生时直接幂等返回，不再重放输入。
    if (isTerminalRunStatus(child.status)) {
      return { request_id: requestId, status: 'completed', run_id: child.id, task_id: task.id }
    }
    if (this.turns.hasActiveTurn(child.id)) {
      throw new ApplicationError('该 Run 仍有未结束的 turn，请稍后重试', 'state_conflict', 409)
    }
    await ensureSlotClaim(this.repository, task, child, this.clock.now().toISOString())
    let activeRun = child
    if (child.status === 'paused' || child.status === 'interrupted') {
      const revision = await requireRevision(this.repository, child.id)
      const activated = await this.repository.finalizeRun({
        run: {
          ...child,
          status: 'running',
          ended_at: undefined,
          error_code: undefined,
          updated_at: this.clock.now().toISOString(),
        },
        expectedStateRevision: revision,
        taskId: task.id,
        taskStatus: 'running',
        slotId: task.slot_id,
        releaseClaim: false,
      })
      if (activated === null) {
        await this.turns.failUndispatched(receipt, 'state_conflict')
        throw new ApplicationError('retry 状态已变化', 'state_conflict', 409)
      }
      activeRun = activated.run
    } else if (activeRun.status !== 'running') {
      await this.turns.failUndispatched(receipt, 'state_conflict')
      throw new ApplicationError('retry 状态已变化', 'state_conflict', 409)
    }
    const runtimeSession = await ensureRuntimeSession(this.sessions, task.slot_id)
    const dispatched = await this.turns.dispatchTurn({
      receipt,
      runtimeSession,
      run: activeRun,
      task,
      promptText: message.content,
      runId: child.id,
      taskId: task.id,
      messageId: message.id,
    })
    if (!dispatched) {
      throw new ApplicationError('Agent Runtime 暂时不可用，请重试', 'adapter_start_failed', 502)
    }
    return { request_id: requestId, status: 'completed', run_id: child.id, task_id: task.id }
  }

  /**
   * cancel：先 CAS 到 cancelling，再取消活动 turn。
   *
   * ACP `session/cancel` 只是 notification，调用成功不代表已停止。必须等待活动
   * turn 结束或 `turn_cancelled` 证据；无法确认时收敛 `interrupted`。
   */
  async cancelRun(runId: string, input: RunCommandRequest): Promise<RunCommandReceipt> {
    const run = await requireRun(this.repository, runId)
    const receipt = await this.reserveCommand(run, 'cancel', input.request_id)
    if (receipt.status === 'completed') {
      return toReceiptDto(receipt)
    }
    if (receipt.status === 'ambiguous') {
      throw new ApplicationError('该命令结果不确定，请使用新的 request_id', 'command_outcome_ambiguous', 409)
    }
    if (!canCancelRun(run.status)) {
      await this.turns.failUndispatched(receipt, 'state_conflict')
      throw new ApplicationError('该 Run 当前不可 cancel', 'state_conflict', 409)
    }
    const task = await requireTask(this.repository, run)
    const now = this.clock.now().toISOString()
    const revision = await requireRevision(this.repository, run.id)
    const cancelling = await this.repository.updateRunIfRevision(
      { ...run, status: 'cancelling', updated_at: now },
      revision,
    )
    if (cancelling === null) {
      await this.turns.failUndispatched(receipt, 'state_conflict')
      throw new ApplicationError('Run 状态已变化', 'state_conflict', 409)
    }
    // pending Permission 必须先按 claim/complete 路径记录 cancelled；失败不得吞。
    const permissionFailure = await this.turns.cancelPendingPermissions(run)
    if (permissionFailure !== null) {
      await this.turns.finalizeRunToStatus(
        run.id,
        'interrupted',
        'paused',
        'permission_cancel_failed',
        'run.interrupted',
      )
      if (!this.turns.hasActiveTurn(run.id)) {
        await this.turns.releaseClaim(run.id)
      }
      await this.completeCommandReceipt(receipt, run.id)
      throw new ApplicationError('无法取消待处理的权限请求', 'adapter_start_failed', 502)
    }
    // cancelTurn 只是 notification：成功 ≠ 已停止。
    const runtimeSession = this.sessions.getRuntimeSession(task.slot_id)
    let notified = true
    if (runtimeSession === null) {
      notified = false
    } else {
      try {
        await this.runtime.cancelTurn(runtimeSession)
      } catch {
        notified = false
      }
    }
    if (notified) {
      await this.turns.waitForActiveTurn(run.id)
    }
    const current = await this.repository.getRun(run.id)
    if (current !== null && !isTerminalRunStatus(current.status)) {
      // 没有 turn 结束/取消证据：不能声称 cancelled。
      await this.turns.finalizeRunToStatus(
        run.id,
        'interrupted',
        'paused',
        'cancel_unconfirmed',
        'run.interrupted',
      )
      // 旧 turn 仍活动时保留 claim；确认没有活动 turn 才释放，避免 Slot 永久卡死。
      if (!this.turns.hasActiveTurn(run.id)) {
        await this.turns.releaseClaim(run.id)
      }
    }
    await this.completeCommandReceipt(receipt, run.id)
    return { request_id: input.request_id, status: 'completed', run_id: run.id }
  }

  /** 把已确定结果的 cancel 回执标记完成。 */
  private async completeCommandReceipt(receipt: Receipt, runId: string): Promise<void> {
    await this.repository.updateCommandReceipt({
      ...receipt,
      status: 'completed',
      dispatch_state: 'accepted',
      run_id: runId,
      updated_at: this.clock.now().toISOString(),
    }, receipt.status, receipt.dispatch_state, {
      run_id: receipt.run_id ?? null,
      task_id: receipt.task_id ?? null,
      message_id: receipt.message_id ?? null,
    })
  }

  /** 取得或创建命令回执；reserved/running 视为并发进行中。 */
  private async reserveCommand(
    run: RunDto,
    command: 'resume' | 'retry' | 'cancel',
    requestId: string,
  ): Promise<Receipt> {
    const existing = await this.repository.getCommandReceipt(run.workspace_id, requestId, command)
    if (existing !== null) {
      this.assertReceiptTarget(existing.target_id, run.id)
      if (existing.status === 'reserved' || existing.status === 'running') {
        throw new ApplicationError('同 request_id 的命令仍在进行中', 'state_conflict', 409)
      }
      return existing
    }
    const created = await this.repository.insertCommandReceipt({
      workspace_id: run.workspace_id,
      request_id: requestId,
      command,
      target_id: run.id,
      status: 'reserved',
      dispatch_state: 'not_started',
      updated_at: this.clock.now().toISOString(),
    })
    // insert 是 insert-or-get：并发下可能拿到其他目标的回执；同目标时由后续
    // Run/Task 的 state_revision CAS 保证只有一个执行者真正推进。
    this.assertReceiptTarget(created.target_id, run.id)
    return created
  }

  /** 同 key 不得指向另一个 Run。 */
  private assertReceiptTarget(targetId: string, runId: string): void {
    if (targetId !== runId) {
      throw new ApplicationError('同 request_id 指向不同目标', 'state_conflict', 409)
    }
  }

  private newRetryRun(parent: RunDto, now: string): RunDto {
    return {
      id: this.ids.next('run'),
      workspace_id: parent.workspace_id,
      session_id: parent.session_id,
      status: 'running',
      attempt: parent.attempt + 1,
      started_at: now,
      created_at: now,
      updated_at: now,
    }
  }
}
