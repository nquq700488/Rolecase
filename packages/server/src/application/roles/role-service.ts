import {
  isSensitiveRuntimeOptionKey,
  type CreateRoleBindingRequest,
  type CreateRoleRequest,
  type ModelCatalogEntryDto,
  type RoleBindingDto,
  type RoleDto,
  type UpdateRoleBindingRequest,
  type UpdateRoleRequest,
} from '@rolecast/contract'

import {
  assertBindingWorkspaceConsistency,
  createRole,
  createRoleBinding,
  updateRole,
  updateRoleBinding,
  type RoleBindingUpdate,
  type RoleUpdate,
} from '../../domain/index.js'
import { ApplicationError } from '../errors.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import {
  RoleConfigConflictError,
  RoleConfigResourceInUseError,
  RoleConfigResourceMissingError,
  type RoleConfigRepositoryPort,
} from '../ports/role-config-repository-port.js'
import type { RepositoryPort } from '../ports/repository-port.js'

/**
 * @name RoleService
 * @description 编排 Role/RoleBinding 配置用例，隔离 JSON 配置和 Provider/Model 引用校验
 */
export class RoleService {
  constructor(
    private readonly roles: RoleConfigRepositoryPort,
    private readonly repository: RepositoryPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  /** 列出 Workspace 的 Role。 */
  async listRoles(workspaceId: string): Promise<RoleDto[]> {
    await this.requireWorkspace(workspaceId)
    return this.roles.listRoles(workspaceId)
  }

  /** 获取 Role；不存在时返回稳定错误。 */
  async getRole(roleId: string): Promise<RoleDto> {
    const role = await this.roles.getRole(roleId)
    if (role === null) {
      throw this.roleNotFound()
    }
    return role
  }

  /** 创建 Role。 */
  async createRole(workspaceId: string, input: CreateRoleRequest): Promise<RoleDto> {
    await this.requireWorkspace(workspaceId)
    const now = this.clock.now()
    const role = createRole({
      id: this.ids.next('role'),
      workspaceId,
      name: input.name,
      now,
      ...optionalRoleFields(input),
    })
    return this.runConfig(() => this.roles.createRole(toRoleDto(role)))
  }

  /** 按 version 更新 Role。 */
  async updateRole(roleId: string, input: UpdateRoleRequest): Promise<RoleDto> {
    const current = await this.getRole(roleId)
    const updated = updateRole(currentToDomainRole(current), toRoleUpdate(input), this.clock.now())
    const result = await this.runConfig(() => this.roles.updateRole(toRoleDto(updated), input.version))
    if (result === null) {
      throw this.roleNotFound()
    }
    return result
  }

  /** 按 version 删除 Role；仍被 Binding 引用时拒绝。 */
  async deleteRole(roleId: string, version: number): Promise<void> {
    await this.getRole(roleId)
    try {
      await this.roles.deleteRole(roleId, version)
    } catch (error: unknown) {
      throw this.mapConfigError(error, 'Role 删除失败')
    }
  }

  /** 列出 Workspace 的 RoleBinding。 */
  async listBindings(workspaceId: string): Promise<RoleBindingDto[]> {
    await this.requireWorkspace(workspaceId)
    return this.roles.listBindings(workspaceId)
  }

  /** 获取 RoleBinding；不存在时返回稳定错误。 */
  async getBinding(bindingId: string): Promise<RoleBindingDto> {
    const binding = await this.roles.getBinding(bindingId)
    if (binding === null) {
      throw this.bindingNotFound()
    }
    return binding
  }

  /**
   * @name resolveBindingForWorkspace
   * @description 解析并验证 Session 可用的 Workspace RoleBinding
   * @param {string} workspaceId Session 所属 Workspace
   * @param {string} bindingId 已配置 RoleBinding ID
   * @return {Promise<{ binding: RoleBindingDto; role: RoleDto }>} 已验证的 Binding 与 Role
   */
  async resolveBindingForWorkspace(
    workspaceId: string,
    bindingId: string,
  ): Promise<{ binding: RoleBindingDto; role: RoleDto }> {
    await this.requireWorkspace(workspaceId)
    const resolved = await this.roles.getBindingWithRole(workspaceId, bindingId)
    if (resolved === null) {
      throw this.bindingNotFound()
    }
    const { binding, role } = resolved
    if (binding.workspace_id !== workspaceId || role.workspace_id !== workspaceId) {
      throw this.bindingNotFound()
    }
    if (!binding.enabled) {
      throw new ApplicationError('RoleBinding 未启用', 'invalid_request', 422)
    }
    if (Object.keys(binding.runtime_options).length > 0) {
      throw new ApplicationError('该 RoleBinding 含暂不支持的 runtime_options', 'provider_capability_not_supported', 422)
    }
    if (!role.selectable || !role.dispatchable) {
      throw new ApplicationError('Role 当前不可分配给 AgentSlot', 'invalid_request', 422)
    }
    await this.validateBindingReferences(
      workspaceId,
      binding.role_id,
      binding.provider_connection_id,
      binding.model_id,
      [role],
    )
    return { binding, role }
  }

  /** 创建 RoleBinding，并校验 Role、ProviderConnection 和 Model 的引用完整性。 */
  async createBinding(workspaceId: string, input: CreateRoleBindingRequest): Promise<RoleBindingDto> {
    await this.requireWorkspace(workspaceId)
    await this.validateBindingReferences(workspaceId, input.role_id, input.provider_connection_id, input.model_id)
    assertSafeRuntimeOptions(input.runtime_options)
    const binding = createRoleBinding({
      id: this.ids.next('binding'),
      workspaceId,
      roleId: input.role_id,
      providerConnectionId: input.provider_connection_id,
      modelId: input.model_id,
      now: this.clock.now(),
      ...optionalBindingFields(input),
    })
    const dto = toBindingDto(binding)
    return this.runConfig(() => this.roles.createBinding(dto, (context, currentBinding) =>
      this.validateBindingReferences(
        context.workspaceId,
        currentBinding.role_id,
        currentBinding.provider_connection_id,
        currentBinding.model_id,
        context.roles,
      )))
  }

  /** 按 version 更新 RoleBinding。 */
  async updateBinding(bindingId: string, input: UpdateRoleBindingRequest): Promise<RoleBindingDto> {
    const current = await this.getBinding(bindingId)
    const roleId = input.role_id ?? current.role_id
    const providerConnectionId = input.provider_connection_id ?? current.provider_connection_id
    const modelId = input.model_id ?? current.model_id
    await this.validateBindingReferences(current.workspace_id, roleId, providerConnectionId, modelId)
    assertSafeRuntimeOptions(input.runtime_options)
    const updated = updateRoleBinding(
      bindingToDomain(current),
      toBindingUpdate(input),
      this.clock.now(),
    )
    const updatedDto = toBindingDto(updated)
    const result = await this.runConfig(() => this.roles.updateBinding(
      updatedDto,
      input.version,
      (context, currentBinding) => this.validateBindingReferences(
        context.workspaceId,
        currentBinding.role_id,
        currentBinding.provider_connection_id,
        currentBinding.model_id,
        context.roles,
      ),
    ))
    if (result === null) {
      throw this.bindingNotFound()
    }
    return result
  }

  /** 按 version 删除 RoleBinding。 */
  async deleteBinding(bindingId: string, version: number): Promise<void> {
    await this.getBinding(bindingId)
    try {
      await this.roles.deleteBinding(bindingId, version)
    } catch (error: unknown) {
      throw this.mapConfigError(error, 'RoleBinding 删除失败')
    }
  }

  private async requireWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.repository.getWorkspace(workspaceId)
    if (workspace === null) {
      throw new ApplicationError('Workspace 不存在', 'workspace_not_found', 404)
    }
  }

  private async validateBindingReferences(
    workspaceId: string,
    roleId: string,
    providerConnectionId: string,
    modelId: string,
    availableRoles?: readonly RoleDto[],
  ): Promise<void> {
    const role = availableRoles?.find((candidate) => candidate.id === roleId)
      ?? await this.roles.getRole(roleId)
    if (role === undefined || role === null || role.workspace_id !== workspaceId) {
      throw this.roleNotFound()
    }
    const provider = await this.repository.getProviderConnection(providerConnectionId)
    if (provider === null || provider.workspace_id !== workspaceId) {
      throw new ApplicationError('ProviderConnection 不属于当前 Workspace', 'not_found', 404, {
        resource: 'provider',
      })
    }
    const models = await this.repository.listModels(providerConnectionId)
    const selected = models.find((model) => isModelForBinding(model, workspaceId, providerConnectionId, modelId))
    if (selected === undefined) {
      throw new ApplicationError('模型不属于指定 ProviderConnection', 'model_unavailable', 422, {
        model_id: modelId,
      })
    }
  }

  private async runConfig<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error: unknown) {
      throw this.mapConfigError(error, 'Role 配置操作失败')
    }
  }

  private mapConfigError(error: unknown, fallbackMessage: string): ApplicationError | Error {
    if (error instanceof ApplicationError) {
      return error
    }
    if (error instanceof RoleConfigConflictError) {
      return new ApplicationError('配置已被其他操作更新，请重新加载', 'state_conflict', 409)
    }
    if (error instanceof RoleConfigResourceInUseError) {
      return new ApplicationError('Role 仍被 RoleBinding 引用', 'resource_in_use', 409)
    }
    if (error instanceof RoleConfigResourceMissingError) {
      return new ApplicationError('配置资源不存在', 'not_found', 404)
    }
    return new ApplicationError(fallbackMessage, 'internal_error', 500)
  }

  private roleNotFound(): ApplicationError {
    return new ApplicationError('Role 不存在', 'role_not_found', 404)
  }

  private bindingNotFound(): ApplicationError {
    return new ApplicationError('RoleBinding 不存在', 'binding_not_found', 404)
  }
}

const optionalRoleFields = (input: CreateRoleRequest): {
  readonly description?: string
  readonly systemPrompt?: string
  readonly requiredGuidelines?: readonly string[]
  readonly gates?: readonly string[]
  readonly outputContract?: string
  readonly blockingConditions?: readonly string[]
  readonly selectable?: boolean
  readonly dispatchable?: boolean
} => ({
  ...(input.description === undefined ? {} : { description: input.description }),
  ...(input.system_prompt === undefined ? {} : { systemPrompt: input.system_prompt }),
  ...(input.required_guidelines === undefined ? {} : { requiredGuidelines: input.required_guidelines }),
  ...(input.gates === undefined ? {} : { gates: input.gates }),
  ...(input.output_contract === undefined ? {} : { outputContract: input.output_contract }),
  ...(input.blocking_conditions === undefined ? {} : { blockingConditions: input.blocking_conditions }),
  ...(input.selectable === undefined ? {} : { selectable: input.selectable }),
  ...(input.dispatchable === undefined ? {} : { dispatchable: input.dispatchable }),
})

const toRoleUpdate = (input: UpdateRoleRequest): RoleUpdate => ({
  ...(input.name === undefined ? {} : { name: input.name }),
  ...(input.description === undefined ? {} : { description: input.description }),
  ...(input.system_prompt === undefined ? {} : { systemPrompt: input.system_prompt }),
  ...(input.required_guidelines === undefined ? {} : { requiredGuidelines: input.required_guidelines }),
  ...(input.gates === undefined ? {} : { gates: input.gates }),
  ...(input.output_contract === undefined ? {} : { outputContract: input.output_contract }),
  ...(input.blocking_conditions === undefined ? {} : { blockingConditions: input.blocking_conditions }),
  ...(input.selectable === undefined ? {} : { selectable: input.selectable }),
  ...(input.dispatchable === undefined ? {} : { dispatchable: input.dispatchable }),
})

const optionalBindingFields = (input: CreateRoleBindingRequest): {
  readonly runtimeOptions?: Readonly<Record<string, string | number | boolean>>
  readonly priority?: number
  readonly enabled?: boolean
} => ({
  ...(input.runtime_options === undefined ? {} : { runtimeOptions: input.runtime_options }),
  ...(input.priority === undefined ? {} : { priority: input.priority }),
  ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
})

const toBindingUpdate = (input: UpdateRoleBindingRequest): RoleBindingUpdate => ({
  ...(input.role_id === undefined ? {} : { roleId: input.role_id }),
  ...(input.provider_connection_id === undefined ? {} : { providerConnectionId: input.provider_connection_id }),
  ...(input.model_id === undefined ? {} : { modelId: input.model_id }),
  ...(input.runtime_options === undefined ? {} : { runtimeOptions: input.runtime_options }),
  ...(input.priority === undefined ? {} : { priority: input.priority }),
  ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
})

const toRoleDto = (role: ReturnType<typeof createRole>): RoleDto => ({
  id: role.id,
  workspace_id: role.workspaceId,
  name: role.name,
  description: role.description,
  system_prompt: role.systemPrompt,
  required_guidelines: [...role.requiredGuidelines],
  gates: [...role.gates],
  output_contract: role.outputContract,
  blocking_conditions: [...role.blockingConditions],
  selectable: role.selectable,
  dispatchable: role.dispatchable,
  version: role.version,
  created_at: role.createdAt.toISOString(),
  updated_at: role.updatedAt.toISOString(),
})

const toBindingDto = (binding: ReturnType<typeof createRoleBinding>): RoleBindingDto => ({
  id: binding.id,
  workspace_id: binding.workspaceId,
  role_id: binding.roleId,
  provider_connection_id: binding.providerConnectionId,
  model_id: binding.modelId,
  runtime_options: { ...binding.runtimeOptions },
  priority: binding.priority,
  enabled: binding.enabled,
  version: binding.version,
  created_at: binding.createdAt.toISOString(),
  updated_at: binding.updatedAt.toISOString(),
})

const currentToDomainRole = (role: RoleDto): Parameters<typeof updateRole>[0] => ({
  id: role.id,
  workspaceId: role.workspace_id,
  name: role.name,
  description: role.description,
  systemPrompt: role.system_prompt,
  requiredGuidelines: [...role.required_guidelines],
  gates: [...role.gates],
  outputContract: role.output_contract,
  blockingConditions: [...role.blocking_conditions],
  selectable: role.selectable,
  dispatchable: role.dispatchable,
  version: role.version,
  createdAt: new Date(role.created_at),
  updatedAt: new Date(role.updated_at),
})

const bindingToDomain = (binding: RoleBindingDto): Parameters<typeof updateRoleBinding>[0] => ({
  id: binding.id,
  workspaceId: binding.workspace_id,
  roleId: binding.role_id,
  providerConnectionId: binding.provider_connection_id,
  modelId: binding.model_id,
  runtimeOptions: { ...binding.runtime_options },
  priority: binding.priority,
  enabled: binding.enabled,
  version: binding.version,
  createdAt: new Date(binding.created_at),
  updatedAt: new Date(binding.updated_at),
})

const assertSafeRuntimeOptions = (
  options: Readonly<Record<string, string | number | boolean>> | undefined,
): void => {
  if (options === undefined) {
    return
  }
  for (const key of Object.keys(options)) {
    if (isSensitiveRuntimeOptionKey(key)) {
      throw new ApplicationError('runtime_options 不得包含凭据字段', 'invalid_request', 400)
    }
  }
}

const isModelForBinding = (
  model: ModelCatalogEntryDto,
  workspaceId: string,
  providerConnectionId: string,
  modelId: string,
): boolean => model.workspace_id === workspaceId
  && model.provider_connection_id === providerConnectionId
  && model.model_id === modelId
