import type { RunDto, RunStatus } from '@rolecast/contract'

/** 终态 Run 不可被迟到事件覆盖。 */
export const isTerminalRunStatus = (status: RunStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled'

/** resume 允许的来源状态。 */
export const canResumeRun = (status: RunStatus): boolean =>
  status === 'paused' || status === 'interrupted'

/** retry 允许的来源状态。 */
export const canRetryRun = (status: RunStatus): boolean =>
  status === 'failed' || status === 'interrupted' || status === 'cancelled'

/** cancel 允许的来源状态。 */
export const canCancelRun = (status: RunStatus): boolean =>
  status === 'running' || status === 'waiting_user'

/**
 * @name isRetryLeaf
 * @description 判断 Run 是否为 retry chain 的叶节点（不存在任何后代）
 * @param {RunDto} run 目标 Run
 * @param {readonly RunDto[]} chainRuns 同 chain 的全部 Run
 * @return {boolean} 无后代时为 true
 * @example isRetryLeaf(run, chainRuns)
 */
export function isRetryLeaf(run: RunDto, chainRuns: readonly RunDto[]): boolean {
  return !chainRuns.some((candidate) => candidate.attempt > run.attempt)
}
