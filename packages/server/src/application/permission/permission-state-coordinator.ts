import type { PermissionRequestDto } from '@rolecast/contract'

import { systemClock, type ClockPort } from '../ports/clock-port.js'

/** 权限状态协调器可持久化的状态与审计操作。 */
export interface PermissionStateStore {
  /** 读取权限请求。 */
  getPermissionRequest(id: string): Promise<PermissionRequestDto | null>
  /** 保存不可变的权限请求快照。 */
  savePermissionRequest(request: PermissionRequestDto): Promise<void>
  /** 以条件状态更新权限请求，必须由持久化实现提供原子语义。 */
  updatePermissionIfCurrent(
    requestId: string,
    expectedStatus: PermissionRequestDto['status'],
    request: PermissionRequestDto,
  ): Promise<boolean>
  /** 原子领取一次 Adapter 决定，跨协调器实例只允许一个领取者。 */
  beginPermissionDecision(
    requestId: string,
    expectedStatus: 'pending',
    decisionId: string,
    leaseUntil: Date,
  ): Promise<PermissionRequestDto | null>
  /**
   * 原子完成决定并同步 PermissionRequest、Run 和 Task 状态。
   *
   * `unchanged` 表示该操作不得改动 Run/Task（用户取消 Run 时 Run 已进入
   * `cancelling`，不能被权限完成反向覆盖）。
   */
  completePermissionDecision(
    decisionId: string,
    request: PermissionRequestDto,
    runStatus: 'running' | 'interrupted' | 'unchanged',
    taskStatus: 'paused' | 'running' | 'unchanged',
  ): Promise<boolean>
  /** Adapter 应答失败时释放领取。 */
  releasePermissionDecision(decisionId: string): Promise<void>
  /** 服务重启时释放已过期的决定领取。 */
  recoverPermissionDecisions(now: Date): Promise<number>
  /** 推进关联 Run 状态；只允许从非终态来源推进。 */
  transitionRun(runId: string, status: 'waiting_user' | 'running' | 'interrupted'): Promise<void>
  /** 推进关联 Task 状态；只允许从非终态来源推进。 */
  transitionTask(taskId: string, status: 'paused' | 'running'): Promise<void>
  /** 发布并持久化权限生命周期事件。 */
  publish(type: PermissionEventType | 'run.interrupted', request?: PermissionRequestDto): Promise<void>
  /** 创建脱敏系统消息。 */
  createSystemMessage(kind: 'permission_expired'): Promise<void>
}

/** ACP Runtime 能力的最小权限应答边界。 */
export interface PermissionRuntimePort {
  /**
   * 向 Adapter 回传一次权限决定。
   *
   * requestId 保留 Adapter JSON-RPC 的 number / string 类型；超时取消时若
   * 请求没有 Adapter ID，则使用 Rolecast 的 PermissionRequest ID（string）。
   */
  respondPermission(input: {
    requestId: string | number
    optionId?: string
    cancelled?: boolean
  }): Promise<void>
}

/** 权限请求生命周期事件。 */
export type PermissionEventType =
  | 'agent.permission_requested'
  | 'agent.permission_overdue'
  | 'agent.permission_answered'
  | 'agent.permission_expired'

/** 权限请求已过期错误。 */
export class PermissionExpiredError extends Error {
  readonly code = 'permission_timeout'

  constructor(requestId: string) {
    super(`Permission request expired: ${requestId}`)
    this.name = 'PermissionExpiredError'
  }
}

/** 权限请求不存在错误。 */
export class PermissionNotFoundError extends Error {
  readonly code = 'permission_not_found'

  constructor(requestId: string) {
    super(`Permission request not found: ${requestId}`)
    this.name = 'PermissionNotFoundError'
  }
}

/** 权限选项无效错误。 */
export class PermissionOptionError extends Error {
  readonly code = 'permission_option_invalid'

  constructor(optionId: string) {
    super(`Permission option is not available: ${optionId}`)
    this.name = 'PermissionOptionError'
  }
}

/** 权限请求已被另一个状态转换抢先处理。 */
export class PermissionStateConflictError extends Error {
  readonly code = 'state_conflict'

  constructor(requestId: string) {
    super(`Permission request state changed concurrently: ${requestId}`)
    this.name = 'PermissionStateConflictError'
  }
}

/**
 * 处理 PermissionRequest 的持久化状态、超时提醒和 Adapter 应答。
 *
 * 该类只负责 Phase 0 的最小状态协调，不负责完整 Workflow 调度。
 */
export class PermissionStateCoordinator {
  private readonly requestLocks = new Map<string, Promise<void>>()
  private nextDecisionId = 1

  constructor(
    private readonly store: PermissionStateStore,
    private readonly runtime: PermissionRuntimePort,
    private readonly clock: ClockPort = systemClock,
    private readonly decisionLeaseMs = 30_000,
  ) {}

  /** 注册一个等待用户处理的权限请求。 */
  async register(request: PermissionRequestDto): Promise<void> {
    return this.withRequestLock(request.id, async () => {
      if (request.status !== 'pending') {
        throw new Error('Only pending permission requests can be registered')
      }

      await this.store.savePermissionRequest(request)
      await this.store.transitionRun(request.run_id, 'waiting_user')
      await this.store.transitionTask(request.task_id, 'paused')
      await this.store.publish('agent.permission_requested', request)
    })
  }

  /** 服务启动时释放上次进程中断留下的决定领取。 */
  recoverStaleDecisions(at: Date = this.clock.now()): Promise<number> {
    return this.store.recoverPermissionDecisions(at)
  }

  /** 根据服务端时间戳推进一次软提醒或硬超时。 */
  async tick(requestId: string, at: Date = this.clock.now()): Promise<void> {
    return this.withRequestLock(requestId, async () => {
      const request = await this.requireRequest(requestId)
      if (request.status !== 'pending') {
        return
      }

      const current = await this.markOverdueIfNeeded(request, at)
      if (current.expires_at === undefined || at < new Date(current.expires_at)) {
        return
      }

      const decisionId = this.createDecisionId(requestId)
      const claimed = await this.store.beginPermissionDecision(
        requestId,
        'pending',
        decisionId,
        new Date(this.clock.now().getTime() + this.decisionLeaseMs),
      )
      if (claimed === null) {
        throw new PermissionStateConflictError(requestId)
      }
      try {
        await this.runtime.respondPermission({
          requestId: claimed.adapter_request_id ?? requestId,
          cancelled: true,
        })
      } catch (error: unknown) {
        await this.store.releasePermissionDecision(decisionId)
        throw error
      }
      const expired: PermissionRequestDto = {
        ...claimed,
        status: 'expired',
        expired_at: at.toISOString(),
      }
      const updated = await this.store.completePermissionDecision(
        decisionId,
        expired,
        'interrupted',
        'paused',
      )
      if (!updated) {
        throw new PermissionStateConflictError(requestId)
      }
      await this.store.publish('agent.permission_expired', expired)
      await this.store.publish('run.interrupted', expired)
      await this.store.createSystemMessage('permission_expired')
    })
  }

  /**
   * 用户取消 Run 时取消仍 pending 的权限请求。
   *
   * 沿用 claim → complete 路径，不直接改库；迟到回答会因状态非 pending 返回 409。
   */
  async cancel(requestId: string): Promise<void> {
    return this.withRequestLock(requestId, async () => {
      const request = await this.requireRequest(requestId)
      if (request.status !== 'pending') {
        return
      }
      const decisionId = this.createDecisionId(requestId)
      const claimed = await this.store.beginPermissionDecision(
        requestId,
        'pending',
        decisionId,
        new Date(this.clock.now().getTime() + this.decisionLeaseMs),
      )
      if (claimed === null) {
        throw new PermissionStateConflictError(requestId)
      }
      try {
        await this.runtime.respondPermission({
          requestId: claimed.adapter_request_id ?? requestId,
          cancelled: true,
        })
      } catch (error: unknown) {
        await this.store.releasePermissionDecision(decisionId)
        throw error
      }
      const cancelled: PermissionRequestDto = {
        ...claimed,
        status: 'expired',
        expired_at: this.clock.now().toISOString(),
        expiration_reason: 'cancelled',
      }
      // Run 已由 ConversationService CAS 到 cancelling；权限取消不得反向覆盖。
      const updated = await this.store.completePermissionDecision(
        decisionId,
        cancelled,
        'unchanged',
        'unchanged',
      )
      if (!updated) {
        throw new PermissionStateConflictError(requestId)
      }
      await this.store.publish('agent.permission_expired', cancelled)
    })
  }

  /** 回传用户选择的 Adapter 权限选项。 */
  async answer(requestId: string, optionId: string): Promise<void> {
    return this.withRequestLock(requestId, async () => {
      const request = await this.requireRequest(requestId)
      if (request.status === 'expired') {
        throw new PermissionExpiredError(requestId)
      }
      if (request.status !== 'pending') {
        throw new Error(`Permission request cannot be answered: ${request.status}`)
      }
      if (!request.adapter_options.some((option) => option.option_id === optionId)) {
        throw new PermissionOptionError(optionId)
      }

      const decisionId = this.createDecisionId(requestId)
      const claimed = await this.store.beginPermissionDecision(
        requestId,
        'pending',
        decisionId,
        new Date(this.clock.now().getTime() + this.decisionLeaseMs),
      )
      if (claimed === null) {
        throw new PermissionStateConflictError(requestId)
      }
      try {
        await this.runtime.respondPermission({
          requestId: claimed.adapter_request_id ?? requestId,
          optionId,
        })
      } catch (error: unknown) {
        await this.store.releasePermissionDecision(decisionId)
        throw error
      }
      const answered: PermissionRequestDto = {
        ...claimed,
        status: 'answered',
        answered_at: this.clock.now().toISOString(),
        selected_option_id: optionId,
      }
      const updated = await this.store.completePermissionDecision(
        decisionId,
        answered,
        'running',
        'running',
      )
      if (!updated) {
        throw new PermissionStateConflictError(requestId)
      }
      await this.store.publish('agent.permission_answered', answered)
    })
  }

  private async requireRequest(requestId: string): Promise<PermissionRequestDto> {
    const request = await this.store.getPermissionRequest(requestId)
    if (request === null) {
      throw new PermissionNotFoundError(requestId)
    }
    return request
  }

  private async markOverdueIfNeeded(
    request: PermissionRequestDto,
    at: Date,
  ): Promise<PermissionRequestDto> {
    if (request.overdue_at !== undefined || at < new Date(request.soft_timeout_at)) {
      return request
    }

    const overdue: PermissionRequestDto = {
      ...request,
      overdue_at: at.toISOString(),
    }
    const updated = await this.store.updatePermissionIfCurrent(request.id, 'pending', overdue)
    if (!updated) {
      return this.requireRequest(request.id)
    }
    await this.store.publish('agent.permission_overdue', overdue)
    return overdue
  }

  private createDecisionId(requestId: string): string {
    const decisionId = `${requestId}:${this.nextDecisionId}`
    this.nextDecisionId += 1
    return decisionId
  }

  private async withRequestLock<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.requestLocks.get(requestId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.requestLocks.set(requestId, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.requestLocks.get(requestId) === current) {
        this.requestLocks.delete(requestId)
      }
    }
  }
}
