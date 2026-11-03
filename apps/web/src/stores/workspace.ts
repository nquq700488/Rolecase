import { defineStore } from 'pinia'
import { ref } from 'vue'

import type { WorkspaceDto } from '@rolecast/contract'

import { workspaceEndpoints } from '@/api/endpoints.js'
import { ApiClientError } from '@/api/httpClient.js'

/** Workspace 列表和当前选择状态。 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const workspaces = ref<WorkspaceDto[]>([])
  const selectedId = ref<string | null>(null)
  const loading = ref(false)
  const errorMessage = ref<string | null>(null)

  async function load(): Promise<void> {
    loading.value = true
    errorMessage.value = null
    try {
      workspaces.value = await workspaceEndpoints.list()
      if (selectedId.value === null && workspaces.value[0] !== undefined) {
        selectedId.value = workspaces.value[0].id
      }
    } catch (error: unknown) {
      errorMessage.value = error instanceof ApiClientError ? error.message : 'Workspace 加载失败'
    } finally {
      loading.value = false
    }
  }

  async function create(name: string): Promise<WorkspaceDto | null> {
    loading.value = true
    errorMessage.value = null
    try {
      const workspace = await workspaceEndpoints.create({ name })
      workspaces.value = [...workspaces.value, workspace]
      selectedId.value = workspace.id
      return workspace
    } catch (error: unknown) {
      errorMessage.value = error instanceof ApiClientError ? error.message : 'Workspace 创建失败'
      return null
    } finally {
      loading.value = false
    }
  }

  function select(id: string): void {
    selectedId.value = id
  }

  return { workspaces, selectedId, loading, errorMessage, load, create, select }
})
