import type {
  CapabilitySnapshot,
  CodexConfigImportApplyRequest,
  CreateProviderConnectionRequest,
  ModelCatalogEntryDto,
  ProviderConnectionDto,
  UpdateProviderConnectionRequest,
} from '@rolecast/contract'

import { ApplicationError, isCodedError } from '../errors.js'
import type {
  ConfigImportInvalidError,
  ConfigImportNotFoundError,
  ConfigImportStaleError,
  ConfigImportTargetConflictError,
  CodexConfigImportDraft,
  CodexConfigImportPort,
} from '../ports/codex-config-import-port.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { CredentialStorePort } from '../ports/credential-store-port.js'
import { CredentialDeniedError } from '../ports/credential-store-port.js'
import type {
  IdGeneratorPort,
  ProviderDefinitionPort,
  RuntimeEnvironmentPort,
} from '../ports/id-generator-port.js'
import type { CapabilityDiscoveryPort } from '../ports/capability-discovery-port.js'
import type { RepositoryPort } from '../ports/repository-port.js'
import {
  assertCreateCombination,
  assertRunnableCombination,
  formsRuntimeCodexConfig,
} from './provider-combination.js'
import { createProviderRuntimeInput } from './provider-runtime-input.js'

/** Provider 配置与能力发现用例服务。 */
export class ProviderService {
  constructor(
    private readonly repository: RepositoryPort,
    private readonly discovery: CapabilityDiscoveryPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly definitions: ProviderDefinitionPort,
    private readonly environment: RuntimeEnvironmentPort,
    private readonly configImport?: CodexConfigImportPort,
    private readonly credentials?: CredentialStorePort,
  ) {}

  /**
   * 创建 ProviderConnection。
   *
   * Claude 可以按组合矩阵直接创建 inherited 与 isolated；Codex isolated 仍只能
   * 由 config-import/apply 建立（需要非空导入配置）。isolated 引用只在此处
   * `validate`，绝不读取 Secret 原文。
   */
  async createConnection(
    workspaceId: string,
    input: CreateProviderConnectionRequest,
  ): Promise<ProviderConnectionDto> {
    assertCreateCombination(input)
    if (input.environment_mode === 'isolated' && input.credential_ref !== undefined) {
      await this.validateCredentialReference(input.credential_ref)
    }
    const workspace = await this.repository.getWorkspace(workspaceId)
    if (workspace === null) {
      throw new ApplicationError('Workspace 不存在', 'not_found', 404, { resource: 'workspace' })
    }
    const timestamp = this.clock.now().toISOString()
    return this.repository.createProviderConnection({
      id: this.ids.next('provider'),
      workspace_id: workspaceId,
      provider_kind: input.provider_kind,
      connection_kind: input.connection_kind,
      ...(input.base_url === undefined ? {} : { base_url: input.base_url }),
      ...(input.credential_ref === undefined ? {} : { credential_ref: input.credential_ref }),
      environment_mode: input.environment_mode,
      config_revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
    })
  }

  /**
   * 修正 ProviderConnection 的非秘密字段。
   *
   * 顺序固定：组合校验 → 引用 validate（绝不 get）→ CAS 写入。
   * 任何一步失败都不写入、不改变 `config_revision`。
   */
  async updateConnection(
    providerId: string,
    input: UpdateProviderConnectionRequest,
  ): Promise<ProviderConnectionDto> {
    const connection = await this.requireConnection(providerId)
    const merged: ProviderConnectionDto = {
      ...connection,
      ...(input.connection_kind === undefined ? {} : { connection_kind: input.connection_kind }),
      ...(input.environment_mode === undefined ? {} : { environment_mode: input.environment_mode }),
      // null 表示清空；undefined 表示保持原值。
      base_url: input.base_url === null ? undefined : (input.base_url ?? connection.base_url),
      credential_ref: input.credential_ref === null
        ? undefined
        : (input.credential_ref ?? connection.credential_ref),
      ...(input.codex_config === null ? { codex_config: undefined } : {}),
    }
    if (merged.base_url === undefined) {
      delete (merged as { base_url?: string }).base_url
    }
    if (merged.credential_ref === undefined) {
      delete (merged as { credential_ref?: string }).credential_ref
    }
    if (merged.codex_config === undefined) {
      delete (merged as { codex_config?: unknown }).codex_config
    }

    assertUpdateCombination(merged)
    if (input.credential_ref !== undefined && input.credential_ref !== null) {
      await this.validateCredentialReference(input.credential_ref)
    }

    const updated = await this.repository.updateProviderConnection({
      ...merged,
      updated_at: this.clock.now().toISOString(),
    }, input.config_revision)
    if (updated === null) {
      throw new ApplicationError('Provider 配置已发生变化，请重新加载', 'state_conflict', 409, {
        reason: 'config_revision_changed',
      })
    }
    return updated
  }

  /** 列出 Workspace 的连接。 */
  listConnections(workspaceId: string): Promise<ProviderConnectionDto[]> {
    return this.repository.listProviderConnections(workspaceId)
  }

  /** 测试连接并返回握手能力，不保存秘密。 */
  async testConnection(providerId: string): Promise<CapabilitySnapshot> {
    const connection = await this.requireConnection(providerId)
    return this.discover(connection)
  }

  /** 发现能力并把模型目录保存到 SQLite。 */
  async discoverModels(providerId: string): Promise<CapabilitySnapshot> {
    const connection = await this.requireConnection(providerId)
    // 捕获发现开始时的配置版本：Adapter 往返期间配置可能被更新。
    const capturedRevision = connection.config_revision
    const snapshot = await this.discover(connection)
    const models = this.extractModels(connection, snapshot)
    const saved = await this.repository.saveModelsIfCurrentRevision(
      connection.id,
      capturedRevision,
      models,
    )
    if (!saved) {
      // 配置已变化：旧目录失效，要求调用方重新加载。
      throw new ApplicationError('Provider 配置已更新，请重新发现模型', 'state_conflict', 409, {
        reason: 'config_revision_changed',
      })
    }
    return snapshot
  }

  /** 统一把能力发现的 Runtime 错误映射为结构化 Application 错误。 */
  private async discover(connection: ProviderConnectionDto): Promise<CapabilitySnapshot> {
    // 组合判定先于 Runtime：缺配置/非法/未证的组合不 spawn、不读凭据。
    assertRunnableCombination(connection)
    try {
      return await this.discovery.discover(
        createProviderRuntimeInput(connection, this.definitions, this.environment),
      )
    } catch (error: unknown) {
      throw mapDiscoveryError(error)
    }
  }

  /** 返回已持久化的模型目录。 */
  listModels(providerId: string): Promise<ModelCatalogEntryDto[]> {
    return this.repository.listModels(providerId)
  }

  /** 读取并保存 Codex 非秘密配置 preview。 */
  async previewConfigImport(providerId: string, sourcePath: string): Promise<CodexConfigImportDraft> {
    const connection = await this.requireCodexConnection(providerId)
    if (this.configImport === undefined) {
      throw new ApplicationError('Codex 配置导入不可用', 'config_import_invalid', 503)
    }
    try {
      return await this.configImport.preview(
        connection.workspace_id,
        connection.id,
        connection.config_revision,
        sourcePath,
      )
    } catch (error: unknown) {
      throw mapConfigImportError(error)
    }
  }

  /** 在用户确认后应用 Codex 非秘密配置。 */
  async applyConfigImport(
    providerId: string,
    input: CodexConfigImportApplyRequest,
  ): Promise<ProviderConnectionDto> {
    const connection = await this.requireCodexConnection(providerId)
    if (this.configImport === undefined) {
      throw new ApplicationError('Codex 配置导入不可用', 'config_import_invalid', 503)
    }
    if (input.target_config_revision !== connection.config_revision) {
      throw new ApplicationError('Provider 配置已发生变化，请重新预览', 'config_import_target_conflict', 409)
    }

    const credentialRef = input.credential_ref ?? connection.credential_ref
    if (connection.connection_kind === 'local' && credentialRef !== undefined) {
      // local 连接不接受凭据引用；这一步必须在任何 validate / 写入之前。
      throw new ApplicationError(
        'local 连接不能携带 credential_ref',
        'credential_environment_mismatch',
        422,
      )
    }
    if (connection.connection_kind === 'api_key' && credentialRef === undefined) {
      throw new ApplicationError('API Key 连接需要 credential_ref', 'credential_required', 422)
    }

    let draft: CodexConfigImportDraft
    try {
      draft = await this.configImport.claim(
        input.preview_id,
        connection.workspace_id,
        connection.id,
        input.target_config_revision,
      )
    } catch (error: unknown) {
      throw mapConfigImportError(error)
    }

    // 有效配置校验先于 CredentialStore：草稿若无法形成 Runtime 配置，
    // 组合判定会误判 ready，最后由 Runtime fail，同时白白读取一次凭据。
    if (!formsRuntimeCodexConfig(draft)) {
      throw new ApplicationError('Codex 配置文件缺少可用的运行时字段', 'config_import_invalid', 422)
    }

    if (credentialRef !== undefined) {
      await this.validateCredentialReference(credentialRef)
    }

    const updated = await this.repository.updateProviderConnection({
      ...connection,
      environment_mode: 'isolated',
      // 导入产生 base_url 时连接实际变成 custom endpoint：必须同步 connection_kind，
      // 否则普通 api_key 会绕过「Codex custom endpoint 认证未证」的边界。
      connection_kind: draft.baseUrl === undefined ? connection.connection_kind : 'custom_endpoint',
      ...(draft.baseUrl === undefined ? {} : { base_url: draft.baseUrl }),
      ...(credentialRef === undefined ? {} : { credential_ref: credentialRef }),
      codex_config: draft.config,
      updated_at: this.clock.now().toISOString(),
    }, input.target_config_revision)
    if (updated === null) {
      throw new ApplicationError('Provider 配置已发生变化，请重新预览', 'config_import_target_conflict', 409)
    }
    return updated
  }

  /** 只 validate 引用，绝不 get 原文；失败按类别映射为结构化错误。 */
  private async validateCredentialReference(credentialRef: string): Promise<void> {
    if (this.credentials === undefined) {
      throw new ApplicationError('凭据存储不可用', 'credentials_unavailable', 503)
    }
    let valid = false
    try {
      valid = await this.credentials.validate(credentialRef)
    } catch (error: unknown) {
      if (error instanceof CredentialDeniedError) {
        throw new ApplicationError('凭据访问被拒绝', 'credential_denied', 403)
      }
      throw new ApplicationError('凭据存储不可用', 'credentials_unavailable', 503)
    }
    if (!valid) {
      throw new ApplicationError('凭据引用不存在', 'credential_not_found', 404)
    }
  }

  private async requireConnection(providerId: string): Promise<ProviderConnectionDto> {
    const connection = await this.repository.getProviderConnection(providerId)
    if (connection === null) {
      throw new ApplicationError('ProviderConnection 不存在', 'not_found', 404, { resource: 'provider' })
    }
    return connection
  }

  private async requireCodexConnection(providerId: string): Promise<ProviderConnectionDto> {
    const connection = await this.requireConnection(providerId)
    if (connection.provider_kind !== 'codex') {
      throw new ApplicationError('配置导入只支持 Codex Provider', 'unsupported_option', 422)
    }
    return connection
  }

  private extractModels(
    connection: ProviderConnectionDto,
    snapshot: CapabilitySnapshot,
  ): ModelCatalogEntryDto[] {
    const rawModels = Array.isArray(snapshot.capabilities.models)
      ? snapshot.capabilities.models
      : extractModelsFromConfigOptions(snapshot.capabilities.config_options)
    return rawModels.flatMap((rawModel, index) => {
      if (typeof rawModel === 'string' && rawModel.length > 0) {
        return [this.modelEntry(connection, snapshot, rawModel, index)]
      }
      if (typeof rawModel !== 'object' || rawModel === null || Array.isArray(rawModel)) {
        return []
      }
      const record = rawModel as Record<string, unknown>
      const modelId = typeof record.id === 'string' ? record.id : typeof record.model === 'string' ? record.model : typeof record.value === 'string' ? record.value : null
      return modelId === null ? [] : [this.modelEntry(connection, snapshot, modelId, index, record)]
    })
  }

  private modelEntry(
    connection: ProviderConnectionDto,
    snapshot: CapabilitySnapshot,
    modelId: string,
    index: number,
    raw: Record<string, unknown> = {},
  ): ModelCatalogEntryDto {
    const displayName = typeof raw.name === 'string' ? raw.name : modelId
    return {
      id: this.ids.next(`model-${index}`),
      workspace_id: connection.workspace_id,
      provider_connection_id: connection.id,
      provider_kind: connection.provider_kind,
      model_id: modelId,
      display_name: displayName,
      capabilities: {},
      observed_at: snapshot.observed_at,
    }
  }
}

/**
 * `updateConnection` 的结构校验。
 *
 * 与创建路径共享不变量，但允许 already-isolated 的连接修正字段；
 * Codex isolated 仍只能由配置导入进入。
 */
function assertUpdateCombination(connection: ProviderConnectionDto): void {
  if (connection.provider_kind === 'claude' && connection.codex_config !== undefined) {
    // 与组合判定保持一致：Claude 残留 codex_config 属于不可修复的遗留配置。
    throw new ApplicationError(
      'Claude 连接不能携带 Codex 配置，请重新创建或通过配置导入重建',
      'unsupported_option',
      422,
    )
  }
  if (connection.environment_mode !== 'isolated' && connection.credential_ref !== undefined) {
    throw new ApplicationError(
      'inherited 连接不能携带 credential_ref',
      'credential_environment_mismatch',
      422,
    )
  }
  if (connection.connection_kind === 'local' && connection.credential_ref !== undefined) {
    throw new ApplicationError(
      'local 连接不能携带 credential_ref',
      'credential_environment_mismatch',
      422,
    )
  }
  if (connection.connection_kind === 'custom_endpoint' && connection.base_url === undefined) {
    throw new ApplicationError('custom endpoint 连接需要 base_url', 'provider_needs_configuration', 422)
  }
  if (connection.connection_kind !== 'custom_endpoint' && connection.base_url !== undefined) {
    throw new ApplicationError('只有 custom endpoint 连接可以设置 base_url', 'invalid_request', 422)
  }
  if (connection.provider_kind === 'codex' && connection.environment_mode === 'isolated') {
    throw new ApplicationError(
      'Codex isolated 连接请继续使用配置导入',
      'provider_needs_configuration',
      422,
    )
  }
  if (
    connection.environment_mode === 'isolated'
    && connection.connection_kind !== 'local'
    && connection.credential_ref === undefined
  ) {
    throw new ApplicationError('isolated 连接需要 credential_ref', 'credential_required', 422)
  }
}

/** 把 Runtime 抛出的凭据/环境错误映射为结构化 Application 错误；无法识别时原样抛出。 */
function mapDiscoveryError(error: unknown): Error {
  if (isCodedError(error, 'codex_custom_endpoint_unverified')) {
    return new ApplicationError(
      'Codex custom endpoint 的认证尚未验证，不能作为可运行连接',
      'codex_custom_endpoint_unverified',
      422,
    )
  }
  if (isCodedError(error, 'credential_environment_mismatch')) {
    return new ApplicationError('凭据引用与连接环境模式不匹配', 'credential_environment_mismatch', 422)
  }
  if (isCodedError(error, 'provider_needs_configuration')) {
    return new ApplicationError('Provider 仍需要完成凭据配置', 'provider_needs_configuration', 422)
  }
  if (isCodedError(error, 'credential_denied')) {
    return new ApplicationError('凭据访问被拒绝', 'credential_denied', 403)
  }
  if (isCodedError(error, 'credentials_unavailable')) {
    return new ApplicationError('凭据存储不可用', 'credentials_unavailable', 503)
  }
  return error instanceof Error
    ? error
    : new ApplicationError('Provider 能力发现失败', 'adapter_start_failed', 502)
}

function mapConfigImportError(error: unknown): ApplicationError {
  if (isConfigImportError(error, 'config_import_not_found')) {
    return new ApplicationError('Codex 配置文件不存在或不可读取', 'config_import_not_found', 404)
  }
  if (isConfigImportError(error, 'config_import_stale')) {
    return new ApplicationError('Codex 配置文件在确认后发生变化，请重新预览', 'config_import_stale', 409)
  }
  if (isConfigImportError(error, 'config_import_target_conflict')) {
    return new ApplicationError('Codex 配置导入草稿与目标连接不匹配', 'config_import_target_conflict', 409)
  }
  if (isConfigImportError(error, 'config_import_invalid')) {
    return new ApplicationError('Codex 配置文件格式或字段无效', 'config_import_invalid', 422)
  }
  return new ApplicationError('Codex 配置导入失败', 'config_import_invalid', 422)
}

function isConfigImportError(
  error: unknown,
  code: ConfigImportInvalidError['code']
    | ConfigImportNotFoundError['code']
    | ConfigImportStaleError['code']
    | ConfigImportTargetConflictError['code'],
): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

const extractModelsFromConfigOptions = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const modelOption = value.find((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return false
    }
    return (item as Record<string, unknown>).category === 'model'
  })
  if (typeof modelOption !== 'object' || modelOption === null || Array.isArray(modelOption)) {
    return []
  }
  const options = (modelOption as Record<string, unknown>).options
  return Array.isArray(options) ? options : []
}
