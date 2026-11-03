import type { SafeUrlSummary } from './auth-summary.js'

/** device-code 取消探针的结论；只有 observed 才能称为已验证。 */
export type DeviceCodeOutcome =
  /** 真的收到 URL elicitation 并成功拒绝/取消，且清理收敛。 */
  | { readonly status: 'cancelled_and_cleaned'; readonly url: SafeUrlSummary }
  /** 在 elicitation 出现前被 loopback 出口阻断：必须是 unverified，不能算通过。 */
  | { readonly status: 'unverified'; readonly reason: 'elicitation_not_observed_before_network_block' }
  /** 其他失败（Adapter 错误、超时、未声明方法）：同样 unverified，并记录类别。 */
  | { readonly status: 'unverified'; readonly reason: string }
  /** 方法未被 initialize 声明。 */
  | { readonly status: 'unsupported'; readonly reason: 'method_not_declared' }

/** 一次探针的可观察输入（全部已脱敏）。 */
export interface DeviceCodeObservation {
  /** initialize 是否声明了该方法。 */
  readonly methodDeclared: boolean
  /** 是否收到 elicitation/create。 */
  readonly elicitationObserved: boolean
  /** 收到 elicitation 后客户端是否成功返回拒绝/取消。 */
  readonly cancellationDelivered: boolean
  /** authenticate 是否以明确的 request-cancelled 结束（正常 resolve 不算）。 */
  readonly authenticateCancelled: boolean
  /** Adapter 是否在有界时间内收敛（请求结束 / 进程退出）。 */
  readonly adapterSettled: boolean
  /** 是否还有未决请求。 */
  readonly pendingRequests: number
  /** 进程与临时目录是否都已回收。 */
  readonly resourcesReleased: boolean
  /** 是否观察到非 loopback 出口被 sandbox 阻断。 */
  readonly egressBlocked: boolean
  /** 收到 elicitation 时的 URL 安全摘要。 */
  readonly url: SafeUrlSummary | null
}

/**
 * @name decideDeviceCodeOutcome
 * @description 按证据严格判定 device-code 取消路径；网络阻断只能是 unverified
 * @param {DeviceCodeObservation} observation 已脱敏的观察结果
 * @return {DeviceCodeOutcome} 结论
 * @example
 * decideDeviceCodeOutcome({ ...observation, methodDeclared: false })
 * // { status: 'unsupported', reason: 'method_not_declared' }
 */
export function decideDeviceCodeOutcome(observation: DeviceCodeObservation): DeviceCodeOutcome {
  if (!observation.methodDeclared) {
    return { status: 'unsupported', reason: 'method_not_declared' }
  }
  if (!observation.elicitationObserved) {
    // 没收到 elicitation 时，不能把「网络阻断」或「正常退出」当成通过。
    return observation.egressBlocked
      ? { status: 'unverified', reason: 'elicitation_not_observed_before_network_block' }
      : { status: 'unverified', reason: 'elicitation_not_observed' }
  }
  // 收到 elicitation 后必须逐项满足：取消已送达、Adapter 收敛、无 pending、资源已回收。
  if (!observation.cancellationDelivered) {
    return { status: 'unverified', reason: 'cancellation_not_delivered' }
  }
  if (!observation.authenticateCancelled) {
    // 正常 resolve、timeout、transport、remote 都不是取消证据。
    return { status: 'unverified', reason: 'authenticate_not_cancelled' }
  }
  if (!observation.adapterSettled) {
    return { status: 'unverified', reason: 'adapter_did_not_settle' }
  }
  if (observation.pendingRequests !== 0) {
    return { status: 'unverified', reason: 'pending_requests_remain' }
  }
  if (!observation.resourcesReleased) {
    return { status: 'unverified', reason: 'resources_not_released' }
  }
  if (observation.url === null) {
    return { status: 'unverified', reason: 'elicitation_url_missing' }
  }
  return { status: 'cancelled_and_cleaned', url: observation.url }
}
