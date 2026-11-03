import type { RoleBindingDto, RoleDto } from '@rolecast/contract'

/** Role/RoleBinding 配置版本冲突。 */
export class RoleConfigConflictError extends Error {
  readonly code = 'state_conflict'

  constructor(message = 'Role 配置版本已变化') {
    super(message)
    this.name = 'RoleConfigConflictError'
  }
}

/** 删除 Role 时仍存在 Binding 引用。 */
export class RoleConfigResourceInUseError extends Error {
  readonly code = 'resource_in_use'

  constructor(message = 'Role 仍被 RoleBinding 引用') {
    super(message)
    this.name = 'RoleConfigResourceInUseError'
  }
}

/** 配置资源在 mutation 临界区内消失。 */
export class RoleConfigResourceMissingError extends Error {
  readonly code = 'not_found'

  constructor(message = 'Role 配置资源不存在') {
    super(message)
    this.name = 'RoleConfigResourceMissingError'
  }
}

/** 配置 mutation 临界区内用于校验外部 Provider/Model 引用的上下文。 */
export interface RoleBindingReferenceContext {
  readonly workspaceId: string
  readonly roles: readonly RoleDto[]
}

/** Binding 引用校验回调；执行时仍持有 Workspace 配置 mutation 锁。 */
export type RoleBindingReferenceValidator = (
  context: RoleBindingReferenceContext,
  binding: RoleBindingDto,
) => Promise<void>

/**
 * @name RoleConfigRepositoryPort
 * @description 提供 Workspace JSON 中 Role 与 RoleBinding 的存储无关 CRUD
 */
export interface RoleConfigRepositoryPort {
  /** 列出 Workspace 的 Role。 */
  listRoles(workspaceId: string): Promise<RoleDto[]>
  /** 按全局实体 ID 获取 Role。 */
  getRole(roleId: string): Promise<RoleDto | null>
  /** 创建 Role。 */
  createRole(role: RoleDto): Promise<RoleDto>
  /** 按实体 version 更新 Role；资源不存在返回 null。 */
  updateRole(role: RoleDto, expectedVersion: number): Promise<RoleDto | null>
  /** 按实体 version 删除 Role；有引用时抛出资源占用错误。 */
  deleteRole(roleId: string, expectedVersion: number): Promise<void>

  /** 列出 Workspace 的 RoleBinding。 */
  listBindings(workspaceId: string): Promise<RoleBindingDto[]>
  /** 按全局实体 ID 获取 RoleBinding。 */
  getBinding(bindingId: string): Promise<RoleBindingDto | null>
  /** 从同一 Workspace 配置快照读取 Binding 与其 Role，避免跨版本组合。 */
  getBindingWithRole(
    workspaceId: string,
    bindingId: string,
  ): Promise<{ binding: RoleBindingDto; role: RoleDto } | null>
  /** 创建 RoleBinding，并在 mutation 临界区内执行引用校验。 */
  createBinding(binding: RoleBindingDto, validate: RoleBindingReferenceValidator): Promise<RoleBindingDto>
  /** 按实体 version 更新 RoleBinding，并在 mutation 临界区内执行引用校验；资源不存在返回 null。 */
  updateBinding(
    binding: RoleBindingDto,
    expectedVersion: number,
    validate: RoleBindingReferenceValidator,
  ): Promise<RoleBindingDto | null>
  /** 按实体 version 删除 RoleBinding。 */
  deleteBinding(bindingId: string, expectedVersion: number): Promise<void>
}
