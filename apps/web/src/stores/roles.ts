import { defineStore } from 'pinia'
import { ref } from 'vue'

import type {
  CreateRoleBindingRequest,
  CreateRoleRequest,
  RoleBindingDto,
  RoleDto,
  UpdateRoleBindingRequest,
  UpdateRoleRequest,
} from '@rolecast/contract'

import { bindingEndpoints, roleEndpoints } from '@/api/endpoints.js'
import { ApiClientError } from '@/api/httpClient.js'

/** Role 与 RoleBinding 配置状态。 */
export const useRoleStore = defineStore('roles', () => {
  const roles = ref<RoleDto[]>([])
  const bindings = ref<RoleBindingDto[]>([])
  const selectedRoleId = ref<string | null>(null)
  const loading = ref(false)
  const errorMessage = ref<string | null>(null)
  const conflictMessage = ref<string | null>(null)

  async function load(workspaceId: string): Promise<void> {
    loading.value = true
    errorMessage.value = null
    conflictMessage.value = null
    try {
      const [nextRoles, nextBindings] = await Promise.all([
        roleEndpoints.list(workspaceId),
        bindingEndpoints.list(workspaceId),
      ])
      roles.value = nextRoles
      bindings.value = nextBindings
      if (selectedRoleId.value === null || !nextRoles.some((role) => role.id === selectedRoleId.value)) {
        selectedRoleId.value = nextRoles[0]?.id ?? null
      }
    } catch (error: unknown) {
      captureError(error, 'Role 配置加载失败')
    } finally {
      loading.value = false
    }
  }

  async function createRole(workspaceId: string, input: CreateRoleRequest): Promise<RoleDto | null> {
    return mutate(async () => {
      const role = await roleEndpoints.create(workspaceId, input)
      roles.value = [...roles.value, role]
      selectedRoleId.value = role.id
      return role
    }, 'Role 创建失败')
  }

  async function updateRole(roleId: string, input: UpdateRoleRequest): Promise<RoleDto | null> {
    return mutate(async () => {
      const role = await roleEndpoints.update(roleId, input)
      roles.value = roles.value.map((item) => item.id === role.id ? role : item)
      return role
    }, 'Role 保存失败')
  }

  async function removeRole(roleId: string, version: number): Promise<boolean> {
    const result = await mutate(async () => {
      await roleEndpoints.remove(roleId, version)
      roles.value = roles.value.filter((role) => role.id !== roleId)
      bindings.value = bindings.value.filter((binding) => binding.role_id !== roleId)
      if (selectedRoleId.value === roleId) {
        selectedRoleId.value = roles.value[0]?.id ?? null
      }
      return true
    }, 'Role 删除失败')
    return result ?? false
  }

  async function createBinding(workspaceId: string, input: CreateRoleBindingRequest): Promise<RoleBindingDto | null> {
    return mutate(async () => {
      const binding = await bindingEndpoints.create(workspaceId, input)
      bindings.value = [...bindings.value, binding]
      return binding
    }, 'RoleBinding 创建失败')
  }

  async function updateBinding(bindingId: string, input: UpdateRoleBindingRequest): Promise<RoleBindingDto | null> {
    return mutate(async () => {
      const binding = await bindingEndpoints.update(bindingId, input)
      bindings.value = bindings.value.map((item) => item.id === binding.id ? binding : item)
      return binding
    }, 'RoleBinding 保存失败')
  }

  async function removeBinding(bindingId: string, version: number): Promise<boolean> {
    const result = await mutate(async () => {
      await bindingEndpoints.remove(bindingId, version)
      bindings.value = bindings.value.filter((binding) => binding.id !== bindingId)
      return true
    }, 'RoleBinding 删除失败')
    return result ?? false
  }

  function selectRole(roleId: string | null): void {
    selectedRoleId.value = roleId
  }

  async function mutate<T>(operation: () => Promise<T>, fallback: string): Promise<T | null> {
    loading.value = true
    errorMessage.value = null
    conflictMessage.value = null
    try {
      return await operation()
    } catch (error: unknown) {
      captureError(error, fallback)
      return null
    } finally {
      loading.value = false
    }
  }

  function captureError(error: unknown, fallback: string): void {
    if (error instanceof ApiClientError && error.code === 'state_conflict') {
      conflictMessage.value = '配置已被其他操作更新，请重新加载后再保存。'
      errorMessage.value = error.message
      return
    }
    errorMessage.value = error instanceof ApiClientError ? error.message : fallback
  }

  return {
    roles,
    bindings,
    selectedRoleId,
    loading,
    errorMessage,
    conflictMessage,
    load,
    createRole,
    updateRole,
    removeRole,
    createBinding,
    updateBinding,
    removeBinding,
    selectRole,
  }
})
