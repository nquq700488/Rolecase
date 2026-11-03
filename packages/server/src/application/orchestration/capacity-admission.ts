/**
 * 0B 内部容量边界策略（无副作用、无默认额度）。
 *
 * 只由测试 harness 显式传入额度；生产 composition、环境变量、配置、
 * SQLite、Runtime 与日志都不得读取或持久化该测试值。生产 admission
 * 在用户书面批准额度前保持 fail-closed。
 */

/** 容量维度：Q（queued Task）、P（pending Permission）、N（Workflow 节点总数）。 */
export type CapacityDimension = 'queuedTasks' | 'pendingPermissions' | 'workflowNodes'

/** 有限正整数额度；三个维度必须同时提供。 */
export interface CapacityLimits {
  readonly queuedTasks: number
  readonly pendingPermissions: number
  readonly workflowNodes: number
}

export type CapacityDecisionReason =
  | 'accepted'
  | 'capacity_exceeded'
  | 'limits_unconfigured'
  | 'limits_invalid'
  | 'usage_invalid'

export interface CapacityDecision {
  readonly accepted: boolean
  readonly reason: CapacityDecisionReason
  readonly dimension: CapacityDimension
  readonly used: number
  readonly requested: number
  /** 解析成功时的额度；缺失或非法时为 null。 */
  readonly limit: number | null
}

const DIMENSIONS: readonly CapacityDimension[] = [
  'queuedTasks',
  'pendingPermissions',
  'workflowNodes',
]

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * 解析测试注入的额度。
 *
 * 缺失（undefined/null）与非法（缺维度、非有限正整数）必须区分，
 * 便于调用方 fail-closed 并记录稳定原因；不存在任何隐式默认值。
 */
export function parseCapacityLimits(
  input: unknown,
): CapacityLimits | 'unconfigured' | 'invalid' {
  if (input === undefined || input === null) {
    return 'unconfigured'
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return 'invalid'
  }
  const record = input as Record<string, unknown>
  if (!DIMENSIONS.every((dimension) => isPositiveSafeInteger(record[dimension]))) {
    return 'invalid'
  }
  return {
    queuedTasks: record.queuedTasks as number,
    pendingPermissions: record.pendingPermissions as number,
    workflowNodes: record.workflowNodes as number,
  }
}

/**
 * 判定一次容量请求：`used + requested <= limit` 时接受。
 *
 * `limits` 必须由调用方显式传入（测试代码）；缺失或非法不回落默认值。
 * `requested` 必须是正整数；N 的 requested 为调用方预先计算的总节点数，
 * 本策略不负责 DAG/嵌套结构遍历。
 */
export function evaluateCapacity(input: {
  readonly limits: unknown
  readonly dimension: CapacityDimension
  readonly used: number
  readonly requested: number
}): CapacityDecision {
  const base = {
    dimension: input.dimension,
    used: input.used,
    requested: input.requested,
  }
  const parsed = parseCapacityLimits(input.limits)
  if (parsed === 'unconfigured') {
    return { ...base, accepted: false, reason: 'limits_unconfigured', limit: null }
  }
  if (parsed === 'invalid') {
    return { ...base, accepted: false, reason: 'limits_invalid', limit: null }
  }
  const limit = parsed[input.dimension]
  if (
    !isNonNegativeSafeInteger(input.used)
    || !isPositiveSafeInteger(input.requested)
    || !Number.isSafeInteger(input.used + input.requested)
  ) {
    return { ...base, accepted: false, reason: 'usage_invalid', limit }
  }
  if (input.used + input.requested > limit) {
    return { ...base, accepted: false, reason: 'capacity_exceeded', limit }
  }
  return { ...base, accepted: true, reason: 'accepted', limit }
}
