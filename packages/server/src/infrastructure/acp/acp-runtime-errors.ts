/** Codex isolated 缺少已确认配置错误。 */
export class ProviderNeedsConfigurationError extends Error {
  readonly code = 'provider_needs_configuration'

  constructor(providerKind: 'claude' | 'codex') {
    super(`${providerKind} isolated environment needs confirmed configuration`)
    this.name = 'ProviderNeedsConfigurationError'
  }
}

/**
 * Codex custom endpoint 的认证未获证明。
 *
 * Batch 0 Probe 实测：endpoint 覆盖生效，但请求不带任何认证头。因此该组合的
 * endpoint 可以记录与发现，运行时必须 fail-closed，绝不能声明 ready。
 */
export class CodexCustomEndpointUnverifiedError extends Error {
  readonly code = 'codex_custom_endpoint_unverified'

  constructor() {
    super('Codex custom endpoint authentication is not verified')
    this.name = 'CodexCustomEndpointUnverifiedError'
  }
}

/**
 * 非 isolated 连接携带 credential_ref 的历史组合。
 *
 * 该组合在读取 CredentialStore 之前就被拒绝，避免 Secret 进入 inherited 环境。
 */
export class CredentialEnvironmentMismatchError extends Error {
  readonly code = 'credential_environment_mismatch'

  constructor() {
    super('credential_ref is only allowed for isolated environments')
    this.name = 'CredentialEnvironmentMismatchError'
  }
}

/** 连接关闭时未决的 ACP 权限请求被收敛。 */
export class AcpConnectionClosedError extends Error {
  readonly code = 'acp_connection_closed'

  constructor() {
    super('ACP connection closed before the permission request settled')
    this.name = 'AcpConnectionClosedError'
  }
}

/**
 * Adapter 发来的权限请求 ID 不在合法域内。
 *
 * 这类 ID 无法被 DTO / SQLite 表达；如果登记成 pending 就永远无法应答。
 */
export class AcpPermissionIdInvalidError extends Error {
  readonly code = 'acp_permission_id_invalid'

  constructor() {
    super('ACP permission request id is not a non-empty string or a safe integer')
    this.name = 'AcpPermissionIdInvalidError'
  }
}

/**
 * 应答的请求 ID 与任何挂起请求都不匹配（含类型不匹配）。
 *
 * number `1` 的 pending 存在时，用 string `"1"` 应答必须 fail-closed，
 * 不能退回按字符串查找去命中另一个请求。
 */
export class AcpPermissionNotFoundError extends Error {
  readonly code = 'acp_permission_id_not_found'

  constructor() {
    super('ACP permission request not found for the given request id')
    this.name = 'AcpPermissionNotFoundError'
  }
}

/**
 * Adapter 发来的权限请求 ID 与已有挂起请求重复（同类型同值）。
 *
 * 覆盖已有 pending 会让原请求永久悬空，因此 fail-closed 拒绝新请求；
 * 错误信息不含 ID 细节，避免把 Adapter 数据带出 Runtime。
 */
export class AcpPermissionIdConflictError extends Error {
  readonly code = 'acp_permission_id_conflict'

  constructor() {
    super('ACP permission request id conflicts with an existing pending request')
    this.name = 'AcpPermissionIdConflictError'
  }
}
