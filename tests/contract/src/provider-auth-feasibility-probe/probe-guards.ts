import { summarizeUrl, type SafeUrlSummary } from './auth-summary.js'

/** JSON-RPC request cancelled 错误码（ACP / Codex 2.2.2 实测）。 */
const JSON_RPC_REQUEST_CANCELLED = -32800

/** 反向请求是否是可作为证据的 URL elicitation。 */
export type ElicitationVerdict =
  | { readonly accepted: true; readonly url: SafeUrlSummary }
  | {
      readonly accepted: false
      readonly reason: 'not_url_mode' | 'missing_elicitation_id' | 'missing_url' | 'invalid_url'
    }

/**
 * @name classifyElicitation
 * @description 只接受 mode=url 且 URL 可解析的 elicitation，其余一律 fail-closed
 *
 * 不能把任何 `elicitation/create` 都当成设备码 URL：form 模式或畸形 URL
 * 不构成「观察到 URL elicitation」的证据。
 * @param {unknown} params elicitation/create 的 params
 * @return {ElicitationVerdict} 是否可接受及原因
 * @example
 * classifyElicitation({ mode: 'url', url: 'https://chatgpt.com/device' }).accepted // true
 */
export function classifyElicitation(params: unknown): ElicitationVerdict {
  const record = asRecord(params)
  if (record.mode !== 'url') {
    return { accepted: false, reason: 'not_url_mode' }
  }
  // ACP URL elicitation 必须带非空 elicitationId；ID 本身不进入摘要。
  if (typeof record.elicitationId !== 'string' || record.elicitationId.length === 0) {
    return { accepted: false, reason: 'missing_elicitation_id' }
  }
  if (typeof record.url !== 'string' || record.url.length === 0) {
    return { accepted: false, reason: 'missing_url' }
  }
  const url = summarizeUrl(record.url)
  if (url.scheme === 'invalid' || url.host_class === 'invalid') {
    return { accepted: false, reason: 'invalid_url' }
  }
  return { accepted: true, url }
}

/** initialize 响应里可观察到的 agent capability 摘要。 */
export interface AgentCapabilityObservation {
  /** `agentCapabilities.auth.logout` 是否以非 null 对象声明。 */
  readonly logoutDeclared: boolean
  /** `agentCapabilities.auth` 是否存在。 */
  readonly authDeclared: boolean
}

/**
 * @name observeAgentCapabilities
 * @description 从 initialize 响应读取 auth.logout 声明，不推断
 * @param {unknown} initialize initialize 响应
 * @return {AgentCapabilityObservation} 声明形状
 * @example observeAgentCapabilities({ agentCapabilities: { auth: { logout: {} } } })
 */
export function observeAgentCapabilities(initialize: unknown): AgentCapabilityObservation {
  const capabilities = asRecord(asRecord(initialize).agentCapabilities)
  const auth = asRecord(capabilities.auth)
  const authDeclared = Object.hasOwn(capabilities, 'auth') && !isNullish(capabilities.auth)
  const logout = auth.logout
  return {
    authDeclared,
    // 只有显式声明为非数组对象（含空对象）才算支持 logout；null/缺失/数组都不算。
    logoutDeclared: Object.hasOwn(auth, 'logout')
      && typeof logout === 'object'
      && logout !== null
      && !Array.isArray(logout),
  }
}

/** authenticate 的结果分类，用于区分「取消」与「传输/超时/致命错误」。 */
export type AuthenticateFailureKind =
  | 'cancelled'
  | 'timeout'
  | 'transport'
  | 'remote'
  | 'unknown'

/**
 * @name classifyAuthenticateFailure
 * @description 把 authenticate 抛出的错误分成取消与真实失败
 *
 * 只有取消类错误可以算「客户端已拒绝」；timeout / transport / remote 都不行。
 * @param {unknown} error 捕获的异常
 * @return {AuthenticateFailureKind} 分类
 * @example classifyAuthenticateFailure(new Error('ACP input closed')) // 'transport'
 */
export function classifyAuthenticateFailure(error: unknown): AuthenticateFailureKind {
  if (typeof error !== 'object' || error === null) {
    return 'unknown'
  }
  const record = error as Record<string, unknown>
  const code = typeof record.code === 'number' ? record.code : null
  const name = typeof record.name === 'string' ? record.name : ''
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : ''

  if (name === 'AcpRequestTimeoutError') {
    return 'timeout'
  }
  if (
    name === 'AcpRequestAbortedError'
    || name === 'AcpInputClosedError'
    || name === 'AcpInvalidFrameError'
    || name === 'AcpOutputLimitError'
  ) {
    return 'transport'
  }
  // 锁定 Codex 2.2.2 用 RequestError.requestCancelled(-32800) 表达设备码取消；
  // 这是唯一可识别的取消形状，不能靠 message 关键词猜测。
  if (code === JSON_RPC_REQUEST_CANCELLED) {
    return 'cancelled'
  }
  if (code !== null || name === 'AcpRemoteError') {
    return 'remote'
  }
  // 无 code 的本地错误：只按 message 判断超时，不判断取消。
  if (/timed out|timeout/.test(message)) {
    return 'timeout'
  }
  return 'unknown'
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function isNullish(value: unknown): boolean {
  return value === undefined || value === null
}

/** Adapter 错误离开 Probe 时的稳定分类。 */
export interface StableAdapterError {
  /** 数值 JSON-RPC code；非远端错误为 null。 */
  readonly code: string | null
  /** 失败阶段分类，不含任何 Adapter 原文。 */
  readonly stage: 'remote' | 'timeout' | 'transport' | 'unknown'
  /** 固定文案，绝不拼接原始 message/data。 */
  readonly message: string
}

/**
 * @name classifyAdapterError
 * @description 把 Adapter 错误压成稳定分类，丢弃原始 message/data
 *
 * Adapter 可能在错误里回显合成 Secret、URL 或 metadata；这些内容不能进入
 * 测试输出或异常信息。
 * @param {unknown} error 捕获的异常
 * @return {StableAdapterError} 稳定分类
 * @example
 * classifyAdapterError(new Error('boom')) // { stage: 'unknown', message: 'adapter failed during probe' }
 */
export function classifyAdapterError(error: unknown): StableAdapterError {
  const kind = classifyAuthenticateFailure(error)
  const record = typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)
    : {}
  const code = typeof record.code === 'number' ? String(record.code) : null
  const stage: StableAdapterError['stage'] = kind === 'cancelled'
    ? 'remote'
    : kind === 'remote'
      ? 'remote'
      : kind === 'timeout'
        ? 'timeout'
        : kind === 'transport'
          ? 'transport'
          : 'unknown'
  return {
    code,
    stage,
    message: 'adapter failed during probe',
  }
}
