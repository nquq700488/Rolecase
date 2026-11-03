import type { RoleBindingDto, RoleDto } from '@rolecast/contract'

import {
  WorkspaceConfigConflictError,
  type WorkspaceConfigDraft,
  type WorkspaceConfigPort,
  type WorkspaceConfigSnapshot,
} from '../../application/ports/workspace-config-port.js'
import {
  RoleConfigConflictError,
  RoleConfigResourceInUseError,
  RoleConfigResourceMissingError,
  type RoleBindingReferenceValidator,
  type RoleConfigRepositoryPort,
} from '../../application/ports/role-config-repository-port.js'

const cloneRole = (role: RoleDto): RoleDto => ({
  ...role,
  required_guidelines: [...role.required_guidelines],
  gates: [...role.gates],
  blocking_conditions: [...role.blocking_conditions],
})

const cloneBinding = (binding: RoleBindingDto): RoleBindingDto => ({
  ...binding,
  runtime_options: { ...binding.runtime_options },
})

const draftWith = (
  current: WorkspaceConfigSnapshot,
  roles: readonly RoleDto[],
  bindings: readonly RoleBindingDto[],
): WorkspaceConfigDraft => ({
  workspaceId: current.workspaceId,
  schemaVersion: current.schemaVersion,
  roles: roles.map(cloneRole),
  bindings: bindings.map(cloneBinding),
})

interface RoleLocation {
  readonly snapshot: WorkspaceConfigSnapshot
  readonly role: RoleDto
}

interface BindingLocation {
  readonly snapshot: WorkspaceConfigSnapshot
  readonly binding: RoleBindingDto
}

/**
 * @name JsonRoleConfigRepository
 * @description 以 Workspace JSON mutation/CAS 实现 Role 与 RoleBinding CRUD
 */
export class JsonRoleConfigRepository implements RoleConfigRepositoryPort {
  constructor(private readonly config: WorkspaceConfigPort) {}

  async listRoles(workspaceId: string): Promise<RoleDto[]> {
    const snapshot = await this.config.read(workspaceId)
    return snapshot.roles.map(cloneRole)
  }

  async getRole(roleId: string): Promise<RoleDto | null> {
    const location = await this.findRole(roleId)
    return location === null ? null : cloneRole(location.role)
  }

  async createRole(role: RoleDto): Promise<RoleDto> {
    const current = await this.config.read(role.workspace_id)
    try {
      return await this.config.mutate(role.workspace_id, current.version, async (latest) => {
        if (latest.roles.some((item) => item.id === role.id)) {
          throw new RoleConfigConflictError('Role ID 已存在')
        }
        return {
          value: cloneRole(role),
          draft: draftWith(latest, [...latest.roles, role], latest.bindings),
        }
      })
    } catch (error: unknown) {
      throw this.mapConfigError(error)
    }
  }

  async updateRole(role: RoleDto, expectedVersion: number): Promise<RoleDto | null> {
    const location = await this.findRole(role.id)
    if (location === null) {
      return null
    }
    try {
      return await this.config.mutate(location.snapshot.workspaceId, location.snapshot.version, async (latest) => {
        const current = latest.roles.find((item) => item.id === role.id)
        if (current === undefined) {
          throw new RoleConfigResourceMissingError()
        }
        this.assertVersion(current.version, expectedVersion)
        if (role.workspace_id !== current.workspace_id || role.version !== expectedVersion + 1) {
          throw new RoleConfigConflictError('Role 更新版本或归属无效')
        }
        const roles = latest.roles.map((item) => item.id === role.id ? role : item)
        return { value: cloneRole(role), draft: draftWith(latest, roles, latest.bindings) }
      })
    } catch (error: unknown) {
      if (error instanceof RoleConfigResourceMissingError) {
        return null
      }
      throw this.mapConfigError(error)
    }
  }

  async deleteRole(roleId: string, expectedVersion: number): Promise<void> {
    const location = await this.findRole(roleId)
    if (location === null) {
      throw new RoleConfigResourceMissingError('Role 不存在')
    }
    try {
      await this.config.mutate(location.snapshot.workspaceId, location.snapshot.version, async (latest) => {
        const current = latest.roles.find((item) => item.id === roleId)
        if (current === undefined) {
          throw new RoleConfigResourceMissingError('Role 不存在')
        }
        this.assertVersion(current.version, expectedVersion)
        if (latest.bindings.some((binding) => binding.role_id === roleId)) {
          throw new RoleConfigResourceInUseError()
        }
        return {
          value: undefined,
          draft: draftWith(latest, latest.roles.filter((role) => role.id !== roleId), latest.bindings),
        }
      })
    } catch (error: unknown) {
      throw this.mapConfigError(error)
    }
  }

  async listBindings(workspaceId: string): Promise<RoleBindingDto[]> {
    const snapshot = await this.config.read(workspaceId)
    return snapshot.bindings.map(cloneBinding)
  }

  async getBinding(bindingId: string): Promise<RoleBindingDto | null> {
    const location = await this.findBinding(bindingId)
    return location === null ? null : cloneBinding(location.binding)
  }

  async getBindingWithRole(
    workspaceId: string,
    bindingId: string,
  ): Promise<{ binding: RoleBindingDto; role: RoleDto } | null> {
    const snapshot = await this.config.read(workspaceId)
    const binding = snapshot.bindings.find((candidate) => candidate.id === bindingId)
    if (binding === undefined || binding.workspace_id !== workspaceId) {
      return null
    }
    const role = snapshot.roles.find((candidate) => candidate.id === binding.role_id)
    if (role === undefined || role.workspace_id !== workspaceId) {
      return null
    }
    return { binding: cloneBinding(binding), role: cloneRole(role) }
  }

  async createBinding(
    binding: RoleBindingDto,
    validate: RoleBindingReferenceValidator,
  ): Promise<RoleBindingDto> {
    const current = await this.config.read(binding.workspace_id)
    try {
      return await this.config.mutate(binding.workspace_id, current.version, async (latest) => {
        if (latest.bindings.some((item) => item.id === binding.id)) {
          throw new RoleConfigConflictError('RoleBinding ID 已存在')
        }
        await validate({ workspaceId: latest.workspaceId, roles: latest.roles }, binding)
        return {
          value: cloneBinding(binding),
          draft: draftWith(latest, latest.roles, [...latest.bindings, binding]),
        }
      })
    } catch (error: unknown) {
      throw this.mapConfigError(error)
    }
  }

  async updateBinding(
    binding: RoleBindingDto,
    expectedVersion: number,
    validate: RoleBindingReferenceValidator,
  ): Promise<RoleBindingDto | null> {
    const location = await this.findBinding(binding.id)
    if (location === null) {
      return null
    }
    try {
      return await this.config.mutate(location.snapshot.workspaceId, location.snapshot.version, async (latest) => {
        const current = latest.bindings.find((item) => item.id === binding.id)
        if (current === undefined) {
          throw new RoleConfigResourceMissingError('RoleBinding 不存在')
        }
        this.assertVersion(current.version, expectedVersion)
        if (binding.workspace_id !== current.workspace_id || binding.version !== expectedVersion + 1) {
          throw new RoleConfigConflictError('RoleBinding 更新版本或归属无效')
        }
        await validate({ workspaceId: latest.workspaceId, roles: latest.roles }, binding)
        const bindings = latest.bindings.map((item) => item.id === binding.id ? binding : item)
        return { value: cloneBinding(binding), draft: draftWith(latest, latest.roles, bindings) }
      })
    } catch (error: unknown) {
      if (error instanceof RoleConfigResourceMissingError) {
        return null
      }
      throw this.mapConfigError(error)
    }
  }

  async deleteBinding(bindingId: string, expectedVersion: number): Promise<void> {
    const location = await this.findBinding(bindingId)
    if (location === null) {
      throw new RoleConfigResourceMissingError('RoleBinding 不存在')
    }
    try {
      await this.config.mutate(location.snapshot.workspaceId, location.snapshot.version, async (latest) => {
        const current = latest.bindings.find((item) => item.id === bindingId)
        if (current === undefined) {
          throw new RoleConfigResourceMissingError('RoleBinding 不存在')
        }
        this.assertVersion(current.version, expectedVersion)
        return {
          value: undefined,
          draft: draftWith(latest, latest.roles, latest.bindings.filter((binding) => binding.id !== bindingId)),
        }
      })
    } catch (error: unknown) {
      throw this.mapConfigError(error)
    }
  }

  private async findRole(roleId: string): Promise<RoleLocation | null> {
    const snapshots = await this.config.list()
    for (const snapshot of snapshots) {
      const role = snapshot.roles.find((item) => item.id === roleId)
      if (role !== undefined) {
        return { snapshot, role }
      }
    }
    return null
  }

  private async findBinding(bindingId: string): Promise<BindingLocation | null> {
    const snapshots = await this.config.list()
    for (const snapshot of snapshots) {
      const binding = snapshot.bindings.find((item) => item.id === bindingId)
      if (binding !== undefined) {
        return { snapshot, binding }
      }
    }
    return null
  }

  private assertVersion(currentVersion: number, expectedVersion: number): void {
    if (currentVersion !== expectedVersion) {
      throw new RoleConfigConflictError()
    }
  }

  private mapConfigError(error: unknown): Error {
    if (error instanceof WorkspaceConfigConflictError) {
      return new RoleConfigConflictError()
    }
    return error instanceof Error ? error : new Error('Role 配置操作失败')
  }
}
