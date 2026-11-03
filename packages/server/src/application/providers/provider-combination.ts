import type { CodexConfigImportDraft } from '../ports/codex-config-import-port.js'
import type { CreateProviderConnectionRequest, ProviderConnectionDto } from '@rolecast/contract'

import { ApplicationError } from '../errors.js'

/** 组合不可运行的结构化原因。 */
export type ProviderCombinationReason =
  /** inherited 连接携带 credential_ref：引用会被静默忽略，必须拒绝。 */
  | 'inherited_with_credential'
  /** Claude 不接受 codex_config。 */
  | 'claude_with_codex_config'
  /** custom_endpoint 缺少合法 base_url。 */
  | 'missing_base_url'
  /** Claude isolated local 不在支持范围内（本地登录不在此切片）。 */
  | 'isolated_local'
  /** isolated 连接缺少可验证的 credential_ref。 */
  | 'missing_credential'
  /** Codex isolated 只能由 config-import/apply 建立，且必须有非空 codex_config。 */
  | 'missing_codex_config'
  /** Codex isolated local 尚无可用认证路径。 */
  | 'codex_isolated_unconfigured'
  /** Codex custom endpoint 的认证未获证明，不得声明 ready。 */
  | 'codex_custom_endpoint_unverified'

/** ProviderConnection 组合的运行时判定结果。 */
export type ProviderCombination =
  /** 可以启动 Adapter；requiresCredential 表示 Runtime 需从 CredentialStore 读取引用。 */
  | { readonly status: 'ready'; readonly requiresCredential: boolean }
  /** 配置不足以运行：三入口统一返回 provider_needs_configuration，不 spawn。 */
  | { readonly status: 'needs_configuration'; readonly reason: ProviderCombinationReason }
  /** 结构上不允许的组合：fail-closed 并返回结构化错误。 */
  | { readonly status: 'invalid'; readonly reason: ProviderCombinationReason }
  /**
   * endpoint 覆盖已被 Probe 证实、但认证未被证明的组合。
   *
   * 不能按 ready 处理，也不能说成「仅缺配置删除」——它是本切片明确不支持的运行状态。
   */
  | { readonly status: 'unverified'; readonly reason: ProviderCombinationReason }

/**
 * @name resolveProviderCombination
 * @description 判定 ProviderConnection 的 provider × kind × environment × 引用组合是否可运行
 * @param {ProviderConnectionDto} connection 持久化的 ProviderConnection
 * @return {ProviderCombination} 可运行、待配置、非法或未证
 * @example
 * resolveProviderCombination({ ...connection, environment_mode: 'isolated' })
 * // { status: 'needs_configuration', reason: 'isolated_local' }
 */
export function resolveProviderCombination(connection: ProviderConnectionDto): ProviderCombination {
  // 结构不变量先于环境模式判断：这些组合任何环境下都不成立。
  if (connection.environment_mode !== 'isolated' && connection.credential_ref !== undefined) {
    return { status: 'invalid', reason: 'inherited_with_credential' }
  }
  if (connection.provider_kind === 'claude' && connection.codex_config !== undefined) {
    return { status: 'invalid', reason: 'claude_with_codex_config' }
  }
  if (connection.connection_kind === 'custom_endpoint' && connection.base_url === undefined) {
    return { status: 'needs_configuration', reason: 'missing_base_url' }
  }

  if (connection.provider_kind === 'codex') {
    return resolveCodex(connection)
  }
  return resolveClaude(connection)
}

/** Claude：inherited 全部允许；isolated 只支持 api_key / custom_endpoint 且需要引用。 */
function resolveClaude(connection: ProviderConnectionDto): ProviderCombination {
  if (connection.environment_mode === 'inherited') {
    // ANTHROPIC_BASE_URL 已由 Probe 证实对 custom_endpoint 生效。
    return { status: 'ready', requiresCredential: false }
  }
  if (connection.connection_kind === 'local') {
    return { status: 'needs_configuration', reason: 'isolated_local' }
  }
  if (connection.credential_ref === undefined) {
    return { status: 'needs_configuration', reason: 'missing_credential' }
  }
  return { status: 'ready', requiresCredential: true }
}

/** Codex：isolated 只由 apply 建立；custom_endpoint 的认证未证。 */
function resolveCodex(connection: ProviderConnectionDto): ProviderCombination {
  // 判据是「有没有 endpoint 覆盖」，不是 connection_kind：旧版 apply 曾把 base_url
  // 写在 api_key / local 连接上，那些形状同样绕不过认证未证的边界。
  if (connection.connection_kind === 'custom_endpoint' || connection.base_url !== undefined) {
    // endpoint 覆盖已证实，但认证头缺失；不能当作可运行组合。
    return { status: 'unverified', reason: 'codex_custom_endpoint_unverified' }
  }
  if (connection.environment_mode === 'inherited') {
    return { status: 'ready', requiresCredential: false }
  }
  if (connection.connection_kind === 'local') {
    return { status: 'needs_configuration', reason: 'codex_isolated_unconfigured' }
  }
  if (connection.credential_ref === undefined) {
    return { status: 'needs_configuration', reason: 'missing_credential' }
  }
  if (!formsPersistedCodexConfig(connection.codex_config)) {
    // 只有选择名（如 model_provider）时 translator 物化不出 config.toml 内容。
    return { status: 'needs_configuration', reason: 'missing_codex_config' }
  }
  return { status: 'ready', requiresCredential: true }
}

/**
 * 持久化的 `codex_config` 能否物化出 Runtime 实际使用的配置。
 *
 * 与草稿校验同源：`model_provider` 只是选择名，必须至少有一个能写入 config.toml
 * 的字段，否则组合不应判 ready（否则 Runtime 会在读完 Secret 后才失败）。
 */
export function formsPersistedCodexConfig(
  config: ProviderConnectionDto['codex_config'],
): boolean {
  if (config === undefined) {
    return false
  }
  return config.model !== undefined
    || config.wire_api !== undefined
    || config.reasoning_effort !== undefined
}

/**
 * @name assertRunnableCombination
 * @description 组合不可运行时抛出结构化 ApplicationError，供 testConnection / discoverModels / Session 共用
 * @param {ProviderConnectionDto} connection 持久化的 ProviderConnection
 * @return {void} ready 时正常返回
 * @throws {ApplicationError} needs_configuration / invalid / unverified
 * @example
 * assertRunnableCombination(connection)
 */
export function assertRunnableCombination(connection: ProviderConnectionDto): void {
  const combination = resolveProviderCombination(connection)
  if (combination.status === 'ready') {
    return
  }
  if (combination.status === 'unverified') {
    // endpoint 覆盖已证实但认证未证：不能与「缺配置」混为一谈，也绝不声明 ready。
    throw new ApplicationError(
      'Codex custom endpoint 的认证尚未验证，不能作为可运行连接',
      'codex_custom_endpoint_unverified',
      422,
      { reason: combination.reason },
    )
  }
  if (combination.status === 'invalid') {
    throw new ApplicationError(
      combination.reason === 'inherited_with_credential'
        ? 'inherited 连接不能携带 credential_ref'
        : 'Provider 连接组合不合法',
      combination.reason === 'inherited_with_credential'
        ? 'credential_environment_mismatch'
        : 'unsupported_option',
      422,
      { reason: combination.reason },
    )
  }
  throw new ApplicationError(
    combination.reason === 'missing_base_url'
      ? 'custom endpoint 连接需要 base_url'
      : 'Provider 仍需要完成凭据配置',
    'provider_needs_configuration',
    422,
    { reason: combination.reason },
  )
}

/**
 * `createConnection` 的结构校验。
 *
 * 只处理「这个请求形状能否成立」；能否运行仍由 `resolveProviderCombination`
 * 在 test/discover/Session 入口判定（如 Claude isolated local 可保存但待配置）。
 */
export function assertCreateCombination(input: CreateProviderConnectionRequest): void {
  if (input.environment_mode !== 'isolated' && input.credential_ref !== undefined) {
    throw new ApplicationError(
      'inherited 连接不能携带 credential_ref',
      'credential_environment_mismatch',
      422,
    )
  }
  if (input.provider_kind === 'codex' && input.environment_mode === 'isolated') {
    // Codex isolated 需要非空 codex_config，只能由 preview/apply 一次性建立。
    throw new ApplicationError(
      'Codex isolated 连接请先通过配置导入完成',
      'provider_needs_configuration',
      422,
    )
  }
  if (input.connection_kind === 'custom_endpoint' && input.base_url === undefined) {
    throw new ApplicationError('custom endpoint 连接需要 base_url', 'invalid_request', 422)
  }
  if (input.connection_kind !== 'custom_endpoint' && input.base_url !== undefined) {
    throw new ApplicationError('只有 custom endpoint 连接可以设置 base_url', 'invalid_request', 422)
  }
  if (input.connection_kind === 'local' && input.credential_ref !== undefined) {
    // local 连接不使用凭据引用：保存下来只会成为永不使用的闲置引用。
    throw new ApplicationError(
      'local 连接不能携带 credential_ref',
      'credential_environment_mismatch',
      422,
    )
  }
  if (
    input.environment_mode === 'isolated'
    && input.connection_kind !== 'local'
    && input.credential_ref === undefined
  ) {
    throw new ApplicationError(
      'isolated 连接需要 credential_ref',
      'credential_required',
      422,
    )
  }
}

/**
 * 草稿能否形成 Runtime 实际使用的 Codex 配置。
 *
 * `model_provider` 只是选择名，单独存在时 translator 物化不出任何字段，
 * 连接会被组合判定为 ready 却在 Runtime 侧失败。因此必须至少有一个能落到
 * `config.toml` 的字段（base_url / wire_api / model / reasoning_effort）。
 */
export function formsRuntimeCodexConfig(draft: CodexConfigImportDraft): boolean {
  return draft.baseUrl !== undefined
    || draft.config.wire_api !== undefined
    || draft.config.model !== undefined
    || draft.config.reasoning_effort !== undefined
}
