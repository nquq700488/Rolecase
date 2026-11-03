/** 一次清理的结论输入。 */
export interface CleanupEvidence {
  /** Adapter 进程是否已确认退出。 */
  readonly exited: boolean
  /** 清理过程是否报错（强制回收、超时等）。 */
  readonly error: Error | null
}

/** 清理决策：是否保留诊断目录，以及失败原因。 */
export interface CleanupDecision {
  /** true 时必须保留目录且让测试失败。 */
  readonly keepDirectory: boolean
  readonly reason: 'adapter_did_not_exit' | 'cleanup_reported_error' | null
}

/**
 * @name decideCleanup
 * @description 只有进程确认退出且清理无错时才允许删除目录
 *
 * 强制回收或超时都属于「清理报错」：进程可能刚被 SIGKILL，磁盘上的配置目录
 * 仍是诊断材料，不能删。
 * @param {CleanupEvidence} evidence 清理证据
 * @return {CleanupDecision} 是否保留目录
 * @example
 * decideCleanup({ exited: true, error: null }) // { keepDirectory: false, reason: null }
 */
export function decideCleanup(evidence: CleanupEvidence): CleanupDecision {
  if (!evidence.exited) {
    return { keepDirectory: true, reason: 'adapter_did_not_exit' }
  }
  if (evidence.error !== null) {
    return { keepDirectory: true, reason: 'cleanup_reported_error' }
  }
  return { keepDirectory: false, reason: null }
}

/** 有界等待的依赖注入点，便于测试延迟与超时。 */
export interface StatusWindowOptions {
  readonly deadlineMs: number
  readonly pollMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** 有界等待的结果。 */
export interface StatusWindowResult {
  /** 是否在窗口内观察到至少一条通知。 */
  readonly observed: boolean
  /** 窗口是否耗尽（observed=false 时才可能为 true）。 */
  readonly timedOut: boolean
}

/**
 * @name waitForStatusNotification
 * @description 在有限时间窗内等待至少一条认证状态通知
 *
 * 超时表示「未观察到」，绝不推断 Adapter 没有状态。
 * @param {() => number} count 已收到的通知数量
 * @param {StatusWindowOptions} options 窗口参数
 * @return {Promise<StatusWindowResult>} 观察结果
 * @example
 * await waitForStatusNotification(() => 0, { deadlineMs: 50 }) // { observed: false, timedOut: true }
 */
export async function waitForStatusNotification(
  count: () => number,
  options: StatusWindowOptions,
): Promise<StatusWindowResult> {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = options.pollMs ?? 50
  const startedAt = now()

  if (count() > 0) {
    return { observed: true, timedOut: false }
  }
  while (now() - startedAt < options.deadlineMs) {
    await sleep(pollMs)
    if (count() > 0) {
      return { observed: true, timedOut: false }
    }
  }
  return { observed: false, timedOut: true }
}
