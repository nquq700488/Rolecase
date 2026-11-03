/** 认证方法类型的封闭枚举；未知类型一律归为 `other`。 */
export type AuthMethodType = 'terminal' | 'url' | 'api-key' | 'gateway' | 'other'

/** 认证方法摘要：只保留白名单字段，不含任何原始值。 */
export interface AuthMethodSummary {
  readonly method_id: string
  readonly type: AuthMethodType
  readonly args_present: boolean
  readonly args_count: number
  readonly env_present: boolean
  readonly env_count: number
}

/** 认证状态通知摘要：只保留出现标记，不保留账号或 payload。 */
export interface AuthStatusSummary {
  readonly observed: boolean
  readonly kinds: readonly string[]
}

/** URL 的 scheme 分类。 */
export type UrlSchemeClass = 'https' | 'http-loopback' | 'other' | 'invalid'

/** URL 的 host 分类。 */
export type UrlHostClass = 'allowlisted' | 'loopback' | 'other' | 'invalid'

/** URL 安全摘要：不含 hostname、path 内容、port 或动态值。 */
export interface SafeUrlSummary {
  readonly scheme: UrlSchemeClass
  /** 静态 allowlist 模板 ID；未知 path 只给 segment 数，不给内容。 */
  readonly path_template: string | null
  readonly path_segment_count: number
  readonly host_class: UrlHostClass
  readonly has_userinfo: boolean
  readonly has_query: boolean
  readonly has_fragment: boolean
}

/**
 * 锁定版本核验过的认证方法 ID allowlist。
 *
 * 未知方法只记 `other`，避免把 Adapter 动态值（可能是账号或租户）带进摘要。
 */
const KNOWN_METHOD_IDS = new Set([
  'claude-ai-login',
  'console-login',
  'api-key',
  'chat-gpt',
  'chat-gpt-device-code',
  'gateway',
  'gateway-bedrock',
])

/** 已定义的认证类型枚举。 */
const KNOWN_TYPES = new Set<AuthMethodType>(['terminal', 'url', 'api-key', 'gateway'])

/**
 * @name summarizeAuthMethod
 * @description 把 ACP auth method 压成白名单摘要，丢弃 args/env/name/description/_meta 原始值
 * @param {unknown} method 原始 auth method 对象
 * @return {AuthMethodSummary} 白名单摘要
 * @example
 * summarizeAuthMethod({ id: 'chat-gpt', type: 'url', args: { a: 1 } })
 * // { method_id: 'chat-gpt', type: 'url', args_present: true, args_count: 1, ... }
 */
export function summarizeAuthMethod(method: unknown): AuthMethodSummary {
  const record = asRecord(method)
  const rawId = typeof record.id === 'string' ? record.id : ''
  const rawType = typeof record.type === 'string' ? record.type : ''
  // args 可能是对象（环境风格）或字符串数组（terminal 命令行），都只记数量。
  const argsCount = Array.isArray(record.args)
    ? record.args.length
    : Object.keys(asRecord(record.args)).length
  const env = asRecord(record.env)
  return {
    // 未知 ID 只记 other：ID 可能含租户或账号信息。
    method_id: KNOWN_METHOD_IDS.has(rawId) ? rawId : 'other',
    type: KNOWN_TYPES.has(rawType as AuthMethodType) ? (rawType as AuthMethodType) : 'other',
    args_present: argsCount > 0,
    args_count: argsCount,
    env_present: Object.keys(env).length > 0,
    env_count: Object.keys(env).length,
  }
}

/**
 * @name summarizeAuthMethods
 * @description 汇总 initialize 返回的 authMethods
 * @param {unknown} value initialize.authMethods 原值
 * @return {readonly AuthMethodSummary[]} 每个方法一条白名单摘要
 * @example summarizeAuthMethods([]) // []
 */
export function summarizeAuthMethods(value: unknown): readonly AuthMethodSummary[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map(summarizeAuthMethod)
}

/**
 * 锁定版本实际确认过的 auth status kind。
 *
 * 必须精确匹配：放行任意 shape 合法的字符串会把账号或租户之类的动态值
 * 透传到摘要里（例如 `acme-tenant` 也符合「小写 + 连字符」）。
 */
const KNOWN_STATUS_KINDS = new Set([
  // 锁定 Claude 0.90.0 与 Codex 2.2.2 实际发出的 kind。
  'none',
  'account',
  'api_key',
  'gateway',
  'external',
])

/**
 * @name summarizeAuthStatus
 * @description 只记录状态通知是否出现与 allowlist 内的 kind，不保留账号或 payload
 * @param {readonly unknown[]} notifications 收到的通知参数数组
 * @return {AuthStatusSummary} 出现标记与 kind 列表
 * @example summarizeAuthStatus([]) // { observed: false, kinds: [] }
 */
export function summarizeAuthStatus(notifications: readonly unknown[]): AuthStatusSummary {
  const kinds: string[] = []
  for (const notification of notifications) {
    const record = asRecord(notification)
    const kind = typeof record.kind === 'string' ? record.kind : null
    // 未知 kind 只记 `other`，避免把账号/租户等动态值带出去。
    kinds.push(kind !== null && KNOWN_STATUS_KINDS.has(kind) ? kind : 'other')
  }
  return { observed: notifications.length > 0, kinds }
}

/**
 * @name summarizeAuthStatusEnvelope
 * @description 从 `_auth/status_update` 的包装参数中提取脱敏状态摘要
 *
 * 真实参数形状是 `{ authStatus: { kind, ... } }`；只取 `authStatus` 本身，
 * 不保留账号、Token 或 vendor payload。缺少包装时不回退到扁平 kind。
 * @param {readonly unknown[]} notifications 收到的通知参数数组
 * @return {AuthStatusSummary} 出现标记与 kind 列表
 * @example
 * summarizeAuthStatusEnvelope([{ authStatus: { kind: 'account' } }])
 * // { observed: true, kinds: ['account'] }
 */
export function summarizeAuthStatusEnvelope(notifications: readonly unknown[]): AuthStatusSummary {
  const statuses = notifications.flatMap((notification) => {
    const wrapped = asRecord(notification).authStatus
    return typeof wrapped === 'object' && wrapped !== null && !Array.isArray(wrapped) ? [wrapped] : []
  })
  return summarizeAuthStatus(statuses)
}

/** 静态 host allowlist：来自锁定 Adapter 的文档化端点，逐项精确匹配。 */
const ALLOWLISTED_HOSTS = new Set(['claude.ai', 'console.anthropic.com', 'chatgpt.com', 'auth.openai.com'])

/** 静态 path 模板：完整 pathname 精确匹配，避免保留动态片段。 */
const PATH_TEMPLATES: Readonly<Record<string, string>> = {
  '/oauth/authorize': 'oauth_authorize',
  '/login/device': 'device_login',
  '/device': 'device',
}

/**
 * @name summarizeUrl
 * @description 把 URL 压成安全摘要：只给分类、模板 ID 或 segment 数、存在标记
 * @param {unknown} value 原始 URL 字符串
 * @return {SafeUrlSummary} 不含 hostname/path 内容/port/动态值的摘要
 * @example
 * summarizeUrl('https://claude.ai/oauth/authorize?code=canary').path_template // 'oauth_authorize'
 */
export function summarizeUrl(value: unknown): SafeUrlSummary {
  if (typeof value !== 'string' || value.length === 0) {
    return invalidSummary()
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // 解析失败不回显原始输入：它可能含 query 或 userinfo。
    return invalidSummary()
  }

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  return {
    scheme: classifyScheme(url),
    path_template: PATH_TEMPLATES[url.pathname] ?? null,
    path_segment_count: segments.length,
    host_class: classifyHost(url.hostname),
    has_userinfo: url.username.length > 0 || url.password.length > 0,
    has_query: url.search.length > 1,
    has_fragment: url.hash.length > 1,
  }
}

/** scheme 只区分四个封闭类别。 */
function classifyScheme(url: URL): UrlSchemeClass {
  if (url.protocol === 'https:') {
    return 'https'
  }
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) {
    return 'http-loopback'
  }
  if (url.protocol === 'http:' || url.protocol === '') {
    return 'other'
  }
  return 'other'
}

/** host 只给分类，绝不回显 hostname。 */
function classifyHost(hostname: string): UrlHostClass {
  const normalized = hostname.toLowerCase()
  if (ALLOWLISTED_HOSTS.has(normalized)) {
    return 'allowlisted'
  }
  if (isLoopbackHost(normalized)) {
    return 'loopback'
  }
  return normalized.length === 0 ? 'invalid' : 'other'
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

function invalidSummary(): SafeUrlSummary {
  return {
    scheme: 'invalid',
    path_template: null,
    path_segment_count: 0,
    host_class: 'invalid',
    has_userinfo: false,
    has_query: false,
    has_fragment: false,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}
