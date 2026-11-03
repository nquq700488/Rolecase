import { providerConnectionDtoSchema } from '@rolecast/contract'
import type {
  ModelCatalogEntryDto,
  ProviderConnectionDto,
} from '@rolecast/contract'

import { SqliteDatabase } from './sqlite-database.js'
import { toProviderConnection } from './sqlite-provider-mappers.js'

type Row = Record<string, unknown>

const toJson = (value: unknown): string => JSON.stringify(value)

/** ProviderConnection 与模型目录的私有持久化。 */
export class SqliteProviderStore {
  constructor(private readonly database: SqliteDatabase) {}

  async createProviderConnection(connection: ProviderConnectionDto): Promise<ProviderConnectionDto> {
    const validated = providerConnectionDtoSchema.parse(connection)
    this.database
      .prepare(
        `INSERT INTO provider_connections(
          id, workspace_id, provider_definition_id, provider_kind, connection_kind,
          base_url, credential_ref, environment_mode, codex_config_json, config_revision,
          created_at, updated_at
        ) VALUES (@id, @workspace_id, @provider_definition_id, @provider_kind, @connection_kind,
          @base_url, @credential_ref, @environment_mode, @codex_config_json, @config_revision,
          @created_at, @updated_at)`,
      )
      .run({
        ...validated,
        provider_definition_id: validated.provider_definition_id ?? null,
        base_url: validated.base_url ?? null,
        credential_ref: validated.credential_ref ?? null,
        codex_config_json: validated.codex_config === undefined ? null : toJson(validated.codex_config),
        config_revision: validated.config_revision ?? 1,
        created_at: validated.created_at ?? new Date().toISOString(),
        updated_at: validated.updated_at ?? new Date().toISOString(),
      })
    return validated
  }


  async updateProviderConnection(
    connection: ProviderConnectionDto,
    expectedConfigRevision: number,
  ): Promise<ProviderConnectionDto | null> {
    const validated = providerConnectionDtoSchema.parse(connection)
    const result = this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `UPDATE provider_connections SET
          provider_definition_id = @provider_definition_id,
          provider_kind = @provider_kind,
          connection_kind = @connection_kind,
          base_url = @base_url,
          credential_ref = @credential_ref,
          environment_mode = @environment_mode,
          codex_config_json = @codex_config_json,
          config_revision = config_revision + 1,
          updated_at = @updated_at
         WHERE id = @id AND workspace_id = @workspace_id AND config_revision = @expected_config_revision`,
      )
          .run({
            ...validated,
            provider_definition_id: validated.provider_definition_id ?? null,
            base_url: validated.base_url ?? null,
            credential_ref: validated.credential_ref ?? null,
            codex_config_json: validated.codex_config === undefined ? null : toJson(validated.codex_config),
            expected_config_revision: expectedConfigRevision,
            updated_at: validated.updated_at ?? new Date().toISOString(),
          })
      if (changed.changes !== 1) {
        return false
      }
      // 配置已变：旧模型目录立即失效，避免在下一次 discover 前被继续读取。
      this.database
        .prepare('DELETE FROM model_catalog WHERE provider_connection_id = ?')
        .run(validated.id)
      return true
    })
    if (result !== true) {
      return null
    }
    return this.getProviderConnection(validated.id)
  }


  async getProviderConnection(id: string): Promise<ProviderConnectionDto | null> {
    const row = this.database
      .prepare(
        `SELECT id, workspace_id, provider_definition_id, provider_kind, connection_kind,
          base_url, credential_ref, environment_mode, codex_config_json, config_revision,
          created_at, updated_at
         FROM provider_connections WHERE id = ?`,
      )
      .get(id) as Row | undefined
    return row === undefined ? null : toProviderConnection(row)
  }


  async listProviderConnections(workspaceId: string): Promise<ProviderConnectionDto[]> {
    const rows = this.database
      .prepare(
        `SELECT id, workspace_id, provider_definition_id, provider_kind, connection_kind,
          base_url, credential_ref, environment_mode, codex_config_json, config_revision,
          created_at, updated_at
         FROM provider_connections WHERE workspace_id = ? ORDER BY id`,
      )
      .all(workspaceId) as Row[]
    return rows.map(toProviderConnection)
  }


  async saveModelsIfCurrentRevision(
    providerConnectionId: string,
    expectedConfigRevision: number,
    models: readonly ModelCatalogEntryDto[],
  ): Promise<boolean> {
    return this.database.transaction(() => {
      const row = this.database
        .prepare('SELECT config_revision FROM provider_connections WHERE id = ?')
        .get(providerConnectionId) as { config_revision?: number } | undefined
      if (row === undefined || Number(row.config_revision) !== expectedConfigRevision) {
        return false
      }
      // 同一事务内先检查再替换，避免 TOCTOU：旧发现在此只能被丢弃。
      this.database
        .prepare('DELETE FROM model_catalog WHERE provider_connection_id = ?')
        .run(providerConnectionId)
      const statement = this.database.prepare(
        `INSERT INTO model_catalog(
          id, workspace_id, provider_connection_id, provider_kind, model_id,
          display_name, capabilities_json, observed_at
        ) VALUES (@id, @workspace_id, @provider_connection_id, @provider_kind, @model_id,
          @display_name, @capabilities_json, @observed_at)`,
      )
      for (const model of models) {
        statement.run({ ...model, capabilities_json: toJson(model.capabilities) })
      }
      return true
    })
  }


  async listModels(providerConnectionId: string): Promise<ModelCatalogEntryDto[]> {
    const rows = this.database
      .prepare(
        `SELECT id, workspace_id, provider_connection_id, provider_kind, model_id,
          display_name, capabilities_json, observed_at
         FROM model_catalog WHERE provider_connection_id = ? ORDER BY model_id`,
      )
      .all(providerConnectionId) as Row[]
    return rows.map(toModel)
  }

}

const toModel = (row: Row): ModelCatalogEntryDto => ({
  id: String(row.id),
  workspace_id: String(row.workspace_id),
  provider_connection_id: String(row.provider_connection_id),
  provider_kind: row.provider_kind as ModelCatalogEntryDto['provider_kind'],
  model_id: String(row.model_id),
  display_name: String(row.display_name),
  capabilities: JSON.parse(String(row.capabilities_json)) as ModelCatalogEntryDto['capabilities'],
  observed_at: String(row.observed_at),
})
