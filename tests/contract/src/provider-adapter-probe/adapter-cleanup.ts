/** Adapter 进程回收所需的最小接口（与 AcpProcess 兼容）。 */
export interface ClosableAdapter {
  readonly pid: number
  readonly exited: Promise<unknown>
  close(): Promise<void>
}

/** 回收结果：是否确认退出，以及回收过程中的错误。 */
export interface AdapterCleanupResult {
  readonly exited: boolean
  readonly error: Error | null
}

/** 强制回收使用的信号发送函数，便于测试注入。 */
export type AdapterKill = (adapter: ClosableAdapter) => void

/** close 阶段等待的上限标记，避免把「超时」与「正常完成」混淆。 */
const CLOSE_TIMEOUT = Symbol('close-timeout')

/**
 * @name ensureAdapterExited
 * @description 有界关闭 Adapter，失败或超时后强制回收，并确认进程确实退出
 * @param {ClosableAdapter} adapter Adapter 进程
 * @param {object} options 超时与可注入的 kill 实现
 * @return {Promise<AdapterCleanupResult>} 是否确认退出与遇到的错误
 * @example
 * const result = await ensureAdapterExited(adapter)
 * if (!result.exited) { /* 保留目录用于诊断 *\/ }
 */
export async function ensureAdapterExited(
  adapter: ClosableAdapter,
  options: { timeoutMs?: number; kill?: AdapterKill } = {},
): Promise<AdapterCleanupResult> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const kill = options.kill ?? killAdapterProcessGroup

  let error: Error | null = null
  // close 本身也必须在上限内 settle：AcpProcess.close 若卡在信号或 exited 上，
  // 无界 await 会让整个清理永久挂起，既不回收进程也无法保留目录。
  try {
    const closed = await withTimeout(adapter.close(), timeoutMs)
    if (closed === CLOSE_TIMEOUT) {
      error = new Error(`adapter close did not settle within ${timeoutMs}ms`)
      error = forceKill(adapter, kill, error)
    }
  } catch (closeError: unknown) {
    error = closeError instanceof Error ? closeError : new Error('unknown adapter close failure')
    error = forceKill(adapter, kill, error)
  }

  const exited = await waitForExit(adapter.exited, timeoutMs)
  return { exited, error }
}

/** 强制回收；kill 也失败时聚合两个错误名。 */
function forceKill(adapter: ClosableAdapter, kill: AdapterKill, error: Error): Error {
  try {
    kill(adapter)
    return error
  } catch (killError: unknown) {
    return new Error(
      `adapter cleanup failed (${error.message}); forced kill failed (${killError instanceof Error ? killError.name : 'unknown'})`,
    )
  }
}

/** 给 Promise 加上限；超时返回标记而不是拒绝，调用方决定后续动作。 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof CLOSE_TIMEOUT> {
  if (timeoutMs <= 0) {
    return CLOSE_TIMEOUT
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<typeof CLOSE_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(CLOSE_TIMEOUT), timeoutMs)
  })
  // 超时分支已经用手上这个 Promise 兜底消费；race 保留原始拒绝语义。
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

/** 在限定时间内等待 exited；超时返回 false，调用方据此保留目录。 */
async function waitForExit(exited: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    return false
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const settled = exited.then(
    () => true as const,
    () => true as const,
  )
  try {
    return await Promise.race([settled, timeout])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

/** 向 Adapter 进程组发送 SIGKILL；ESRCH/EPERM 视为已不可达。 */
function killAdapterProcessGroup(adapter: ClosableAdapter): void {
  if (process.platform !== 'win32' && adapter.pid > 0) {
    try {
      process.kill(-adapter.pid, 'SIGKILL')
      return
    } catch (error: unknown) {
      if (!isIgnorableKillError(error)) {
        throw error
      }
    }
  }
  try {
    process.kill(adapter.pid, 'SIGKILL')
  } catch (error: unknown) {
    if (!isIgnorableKillError(error)) {
      throw error
    }
  }
}

function isIgnorableKillError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }
  return error.code === 'ESRCH' || error.code === 'EPERM'
}
