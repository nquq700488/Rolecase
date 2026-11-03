import type { CodexConnectionConfig } from '@rolecast/contract'

/** 导入得到的非秘密模型摘要。 */
export interface CodexConfigImportModel {
  readonly modelId: string
  readonly displayName: string
}

/** 已脱敏且绑定目标 ProviderConnection 的 Codex 导入草稿。 */
export interface CodexConfigImportDraft {
  readonly previewId: string
  readonly workspaceId: string
  readonly providerId: string
  readonly sourceName: string
  readonly sourceDigest: string
  readonly targetConfigRevision: number
  readonly baseUrl?: string
  readonly config: CodexConnectionConfig
  readonly models: readonly CodexConfigImportModel[]
  readonly warnings: readonly string[]
}

/** Codex 配置导入源文件不存在。 */
export class ConfigImportNotFoundError extends Error {
  readonly code = 'config_import_not_found'

  constructor() {
    super('Codex 配置文件不存在或不可读取')
    this.name = 'ConfigImportNotFoundError'
  }
}

/** Codex 配置内容无效。 */
export class ConfigImportInvalidError extends Error {
  readonly code = 'config_import_invalid'

  constructor() {
    super('Codex 配置文件格式或字段无效')
    this.name = 'ConfigImportInvalidError'
  }
}

/** 源文件在确认后发生变化。 */
export class ConfigImportStaleError extends Error {
  readonly code = 'config_import_stale'

  constructor() {
    super('Codex 配置文件在确认后发生变化')
    this.name = 'ConfigImportStaleError'
  }
}

/** 导入草稿已过期、已使用或绑定目标不匹配。 */
export class ConfigImportTargetConflictError extends Error {
  readonly code = 'config_import_target_conflict'

  constructor() {
    super('Codex 配置导入草稿与目标连接不匹配')
    this.name = 'ConfigImportTargetConflictError'
  }
}

/** Codex 配置导入的 Application Port。 */
export interface CodexConfigImportPort {
  /** 读取并保存一个短生命周期的脱敏 preview。 */
  preview(
    workspaceId: string,
    providerId: string,
    targetConfigRevision: number,
    sourcePath: string,
  ): Promise<CodexConfigImportDraft>
  /** 校验并 claim preview；claim 成功后不可再次使用。 */
  claim(
    previewId: string,
    workspaceId: string,
    providerId: string,
    targetConfigRevision: number,
  ): Promise<CodexConfigImportDraft>
}
