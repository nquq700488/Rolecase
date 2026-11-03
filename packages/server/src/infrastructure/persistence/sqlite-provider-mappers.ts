import {
  codexConnectionConfigSchema,
  providerConnectionDtoSchema,
  type CodexConnectionConfig,
  type ProviderConnectionDto,
} from '@rolecast/contract'

type Row = Record<string, unknown>

const toOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

/** 将 ProviderConnection SQLite 行映射为经过 Contract 严格校验的 DTO。 */
export const toProviderConnection = (row: Row): ProviderConnectionDto => {
  const providerKind = row.provider_kind as ProviderConnectionDto['provider_kind']
  const codexConfig = parseCodexConfig(row.codex_config_json)
  const raw = {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    ...(toOptionalString(row.provider_definition_id) === undefined
      ? {}
      : { provider_definition_id: String(row.provider_definition_id) }),
    provider_kind: providerKind,
    connection_kind: row.connection_kind as ProviderConnectionDto['connection_kind'],
    ...(toOptionalString(row.base_url) === undefined ? {} : { base_url: String(row.base_url) }),
    ...(toOptionalString(row.credential_ref) === undefined ? {} : { credential_ref: String(row.credential_ref) }),
    environment_mode: row.environment_mode as ProviderConnectionDto['environment_mode'],
    ...(codexConfig === undefined ? {} : { codex_config: codexConfig }),
    config_revision: Number(row.config_revision ?? 1),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
  const result = providerConnectionDtoSchema.safeParse(raw)
  if (!result.success) {
    throw new Error('SQLite ProviderConnection 数据无效')
  }
  // 历史记录可能是 Claude + codex_config：允许读出以便页面展示「需要重建」
  // 并通过 PATCH codex_config: null 清除；运行闸门由组合判定统一 fail-closed。
  return result.data
}

function parseCodexConfig(value: unknown): CodexConnectionConfig | undefined {
  const text = toOptionalString(value)
  if (text === undefined) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('SQLite Codex 配置 JSON 无效')
  }
  const result = codexConnectionConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error('SQLite Codex 配置字段无效')
  }
  return result.data
}
