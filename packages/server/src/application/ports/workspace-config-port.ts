import type { RoleBindingDto, RoleDto } from '@rolecast/contract'

/** 当前 Workspace JSON 配置格式版本。 */
export const WORKSPACE_CONFIG_SCHEMA_VERSION = 1

/** Workspace JSON 配置快照。 */
export interface WorkspaceConfigSnapshot {
  readonly workspaceId: string
  readonly schemaVersion: number
  readonly version: number
  readonly roles: readonly RoleDto[]
  readonly bindings: readonly RoleBindingDto[]
}

/** Workspace JSON 配置写入草稿，不包含由 Port 递增的配置版本。 */
export interface WorkspaceConfigDraft {
  readonly workspaceId: string
  readonly schemaVersion: number
  readonly roles: readonly RoleDto[]
  readonly bindings: readonly RoleBindingDto[]
}

/** Workspace mutation 的结果和下一份配置草稿。 */
export interface WorkspaceConfigMutation<T> {
  readonly value: T
  readonly draft: WorkspaceConfigDraft
}

/** 配置版本冲突。 */
export class WorkspaceConfigConflictError extends Error {
  readonly code = 'state_conflict'

  constructor(message = 'Workspace 配置版本已变化') {
    super(message)
    this.name = 'WorkspaceConfigConflictError'
  }
}

/** 配置文件不可读取、校验或迁移。 */
export class WorkspaceConfigUnavailableError extends Error {
  readonly code = 'config_unavailable'

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'WorkspaceConfigUnavailableError'
  }
}

/** 配置文件安全路径或符号链接检查失败。 */
export class WorkspaceConfigPathError extends Error {
  readonly code = 'config_path_invalid'

  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceConfigPathError'
  }
}

/**
 * @name WorkspaceConfigPort
 * @description 提供 Workspace JSON 配置的读取、串行 mutation 和 CAS 边界
 */
export interface WorkspaceConfigPort {
  /** 读取单个 Workspace 配置；不存在时返回 version=0 的空配置。 */
  read(workspaceId: string): Promise<WorkspaceConfigSnapshot>
  /** 列出已存在的 Workspace 配置，供基础设施执行全局资源定位。 */
  list(): Promise<WorkspaceConfigSnapshot[]>
  /** 在同一 Workspace 锁内完成异步读取、校验、CAS 和原子写入。 */
  mutate<T>(
    workspaceId: string,
    expectedVersion: number,
    operation: (current: WorkspaceConfigSnapshot) => Promise<WorkspaceConfigMutation<T>>,
  ): Promise<T>
}
