import { describe, expect, it } from 'vitest'

import type {
  ModelCatalogEntryDto,
  ProviderConnectionDto,
  WorkspaceDto,
} from '@rolecast/contract'

import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import type { RepositoryPort } from '../ports/repository-port.js'
import type { RoleConfigRepositoryPort } from '../ports/role-config-repository-port.js'
import { RoleService } from './role-service.js'

class TestIds implements IdGeneratorPort {
  private sequence = 0

  next(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }
}

const clock: ClockPort = { now: () => new Date('2026-10-14T10:00:00.000Z') }
const workspace: WorkspaceDto = {
  id: 'workspace-001',
  name: '测试工作区',
  created_at: '2026-10-14T10:00:00.000Z',
  updated_at: '2026-10-14T10:00:00.000Z',
}
const provider: ProviderConnectionDto = {
  id: 'provider-001',
  workspace_id: workspace.id,
  provider_kind: 'claude',
  connection_kind: 'local',
  environment_mode: 'inherited',
  config_revision: 1,
}
const model: ModelCatalogEntryDto = {
  id: 'catalog-001',
  workspace_id: workspace.id,
  provider_connection_id: provider.id,
  provider_kind: 'claude',
  model_id: 'model-001',
  display_name: 'Model 001',
  capabilities: {},
  observed_at: '2026-10-14T10:00:00.000Z',
}

class FakeRoleConfig implements RoleConfigRepositoryPort {
  readonly roles = new Map<string, Awaited<ReturnType<RoleConfigRepositoryPort['listRoles']>>[number]>()
  readonly bindings = new Map<string, Awaited<ReturnType<RoleConfigRepositoryPort['listBindings']>>[number]>()

  async listRoles(workspaceId: string) { return [...this.roles.values()].filter((role) => role.workspace_id === workspaceId) }
  async getRole(roleId: string) { return this.roles.get(roleId) ?? null }
  async createRole(role: Awaited<ReturnType<RoleConfigRepositoryPort['listRoles']>>[number]) { this.roles.set(role.id, role); return role }
  async updateRole(role: Awaited<ReturnType<RoleConfigRepositoryPort['listRoles']>>[number], expectedVersion: number) {
    const current = this.roles.get(role.id)
    if (current === undefined || current.version !== expectedVersion) return null
    this.roles.set(role.id, role)
    return role
  }
  async deleteRole(roleId: string) { this.roles.delete(roleId) }
  async listBindings(workspaceId: string) { return [...this.bindings.values()].filter((binding) => binding.workspace_id === workspaceId) }
  async getBinding(bindingId: string) { return this.bindings.get(bindingId) ?? null }
  async getBindingWithRole(workspaceId: string, bindingId: string) {
    const binding = this.bindings.get(bindingId)
    const role = binding === undefined ? undefined : this.roles.get(binding.role_id)
    if (binding === undefined || role === undefined || binding.workspace_id !== workspaceId || role.workspace_id !== workspaceId) {
      return null
    }
    return { binding, role }
  }
  async createBinding(binding: Awaited<ReturnType<RoleConfigRepositoryPort['listBindings']>>[number]) { this.bindings.set(binding.id, binding); return binding }
  async updateBinding(binding: Awaited<ReturnType<RoleConfigRepositoryPort['listBindings']>>[number], expectedVersion: number) {
    const current = this.bindings.get(binding.id)
    if (current === undefined || current.version !== expectedVersion) return null
    this.bindings.set(binding.id, binding)
    return binding
  }
  async deleteBinding(bindingId: string) { this.bindings.delete(bindingId) }
}

const createRepository = (workspaces: readonly WorkspaceDto[] = [workspace]): RepositoryPort => ({
  getWorkspace: async (id: string) => workspaces.find((item) => item.id === id) ?? null,
  getProviderConnection: async (id: string) => id === provider.id ? provider : null,
  listModels: async (id: string) => id === provider.id ? [model] : [],
} as unknown as RepositoryPort)

describe('RoleService', () => {
  it('创建 Role 并通过 ModelCatalog 校验 Binding 引用', async () => {
    const roleConfig = new FakeRoleConfig()
    const service = new RoleService(roleConfig, createRepository(), new TestIds(), clock)
    const role = await service.createRole(workspace.id, { name: '执行者', selectable: true, dispatchable: true })

    expect(role.name).toBe('执行者')
    const binding = await service.createBinding(workspace.id, {
      role_id: role.id,
      provider_connection_id: provider.id,
      model_id: model.model_id,
    })
    expect(binding.role_id).toBe(role.id)
    await expect(service.createBinding(workspace.id, {
      role_id: role.id,
      provider_connection_id: provider.id,
      model_id: 'missing-model',
    })).rejects.toMatchObject({ code: 'model_unavailable', statusCode: 422 })
  })

  it('拒绝跨 Workspace Role 和敏感 runtime_options', async () => {
    const roleConfig = new FakeRoleConfig()
    const service = new RoleService(roleConfig, createRepository(), new TestIds(), clock)
    await expect(service.createBinding(workspace.id, {
      role_id: 'role-from-other-workspace',
      provider_connection_id: provider.id,
      model_id: model.model_id,
    })).rejects.toMatchObject({ code: 'role_not_found', statusCode: 404 })

    const role = await service.createRole(workspace.id, { name: '执行者', selectable: true, dispatchable: true })
    await expect(service.createBinding(workspace.id, {
      role_id: role.id,
      provider_connection_id: provider.id,
      model_id: model.model_id,
      runtime_options: { api_key: 'must-not-store' },
    })).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 })
  })

  it('解析 Workspace 内有效 Binding 及其 Role', async () => {
    const roleConfig = new FakeRoleConfig()
    const service = new RoleService(roleConfig, createRepository(), new TestIds(), clock)
    const role = await service.createRole(workspace.id, { name: '执行者', selectable: true, dispatchable: true })
    const binding = await service.createBinding(workspace.id, {
      role_id: role.id,
      provider_connection_id: provider.id,
      model_id: model.model_id,
    })

    await expect(service.resolveBindingForWorkspace(workspace.id, binding.id)).resolves.toEqual({ binding, role })
  })

  it('Role/Binding 源在一次配置读取中解析为一致快照', async () => {
    const roleConfig = new FakeRoleConfig()
    const service = new RoleService(roleConfig, createRepository(), new TestIds(), clock)
    const role = await service.createRole(workspace.id, { name: '执行者', selectable: true, dispatchable: true })
    const binding = await service.createBinding(workspace.id, {
      role_id: role.id,
      provider_connection_id: provider.id,
      model_id: model.model_id,
    })
    const readBinding = roleConfig.getBinding.bind(roleConfig)
    roleConfig.getBinding = async (bindingId: string) => {
      const current = await readBinding(bindingId)
      roleConfig.roles.set(role.id, { ...role, version: role.version + 1, system_prompt: '并发更新' })
      return current
    }

    await expect(service.resolveBindingForWorkspace(workspace.id, binding.id))
      .resolves.toEqual({ binding, role })
  })

  it('跨 Workspace 或不存在的 Binding 都按 not_found 拒绝', async () => {
    const roleConfig = new FakeRoleConfig()
    const foreignWorkspace = { ...workspace, id: 'workspace-foreign' }
    const service = new RoleService(
      roleConfig,
      createRepository([workspace, foreignWorkspace]),
      new TestIds(),
      clock,
    )
    const role = await service.createRole(workspace.id, { name: '执行者', selectable: true, dispatchable: true })
    const binding = await service.createBinding(workspace.id, {
      role_id: role.id,
      provider_connection_id: provider.id,
      model_id: model.model_id,
    })

    await expect(service.resolveBindingForWorkspace('workspace-foreign', binding.id))
      .rejects.toMatchObject({ code: 'binding_not_found', statusCode: 404 })
    await expect(service.resolveBindingForWorkspace(workspace.id, 'binding-missing'))
      .rejects.toMatchObject({ code: 'binding_not_found', statusCode: 404 })
  })

  it('拒绝不可选择或不可派发的 Role', async () => {
    const roleConfig = new FakeRoleConfig()
    const service = new RoleService(roleConfig, createRepository(), new TestIds(), clock)
    const role = await service.createRole(workspace.id, { name: '执行者', selectable: true, dispatchable: true })
    const binding = await service.createBinding(workspace.id, {
      role_id: role.id,
      provider_connection_id: provider.id,
      model_id: model.model_id,
    })
    roleConfig.roles.set(role.id, { ...role, selectable: false })

    await expect(service.resolveBindingForWorkspace(workspace.id, binding.id))
      .rejects.toMatchObject({ code: 'invalid_request', statusCode: 422 })
  })

  it('拒绝未启用的 RoleBinding', async () => {
    const roleConfig = new FakeRoleConfig()
    const service = new RoleService(roleConfig, createRepository(), new TestIds(), clock)
    const role = await service.createRole(workspace.id, { name: '执行者', selectable: true, dispatchable: true })
    const binding = await service.createBinding(workspace.id, {
      role_id: role.id,
      provider_connection_id: provider.id,
      model_id: model.model_id,
    })
    roleConfig.bindings.set(binding.id, { ...binding, enabled: false })

    await expect(service.resolveBindingForWorkspace(workspace.id, binding.id))
      .rejects.toMatchObject({ code: 'invalid_request', statusCode: 422 })
  })

  it('重新验证 Binding 的 ModelCatalog 引用', async () => {
    const roleConfig = new FakeRoleConfig()
    const service = new RoleService(roleConfig, createRepository(), new TestIds(), clock)
    const role = await service.createRole(workspace.id, { name: '执行者', selectable: true, dispatchable: true })
    const binding = await service.createBinding(workspace.id, {
      role_id: role.id,
      provider_connection_id: provider.id,
      model_id: model.model_id,
    })
    roleConfig.bindings.set(binding.id, { ...binding, model_id: 'model-removed' })

    await expect(service.resolveBindingForWorkspace(workspace.id, binding.id))
      .rejects.toMatchObject({ code: 'model_unavailable', statusCode: 422 })
  })

  it('不静默忽略 RoleBinding runtime_options', async () => {
    const roleConfig = new FakeRoleConfig()
    const service = new RoleService(roleConfig, createRepository(), new TestIds(), clock)
    const role = await service.createRole(workspace.id, { name: '执行者', selectable: true, dispatchable: true })
    const binding = await service.createBinding(workspace.id, {
      role_id: role.id,
      provider_connection_id: provider.id,
      model_id: model.model_id,
      runtime_options: { effort: 'high' },
    })

    await expect(service.resolveBindingForWorkspace(workspace.id, binding.id))
      .rejects.toMatchObject({ code: 'provider_capability_not_supported', statusCode: 422 })
  })
})
