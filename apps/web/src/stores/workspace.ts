import { defineStore } from 'pinia'
import { ref } from 'vue'

import type { WorkspaceDto } from '@rolecast/contract'

import { workspaceEndpoints } from '@/api/endpoints.js'
import { ApiClientError } from '@/api/httpClient.js'

type WorkspaceRootPathState =
  | { status: 'loading' }
  | { status: 'configured'; rootPath: string }
  | { status: 'unconfigured' }
  | { status: 'error' }

/** Workspace 列表和当前选择状态。 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const workspaces = ref<WorkspaceDto[]>([])
  const selectedId = ref<string | null>(null)
  const loading = ref(false)
  const errorMessage = ref<string | null>(null)
  const rootPathStates = ref<Record<string, WorkspaceRootPathState>>({})
  const rootPathActionErrors = ref<Record<string, string>>({})

  async function load(): Promise<void> {
    loading.value = true
    errorMessage.value = null
    try {
      workspaces.value = await workspaceEndpoints.list()
      rootPathStates.value = Object.fromEntries(
        workspaces.value.map(({ id }) => [id, { status: 'loading' }]),
      )
      rootPathActionErrors.value = {}
      if (selectedId.value === null && workspaces.value[0] !== undefined) {
        selectedId.value = workspaces.value[0].id
      }
      await Promise.all(workspaces.value.map(({ id }) => loadRootPath(id)))
    } catch (error: unknown) {
      errorMessage.value = error instanceof ApiClientError ? error.message : 'Workspace 加载失败'
    } finally {
      loading.value = false
    }
  }

  async function loadRootPath(workspaceId: string): Promise<void> {
    rootPathActionErrors.value = omitWorkspace(rootPathActionErrors.value, workspaceId)
    setRootPathState(workspaceId, { status: 'loading' })
    try {
      const dto = await workspaceEndpoints.getRootPath(workspaceId)
      setRootPathState(
        workspaceId,
        dto.root_path === null
          ? { status: 'unconfigured' }
          : { status: 'configured', rootPath: dto.root_path },
      )
    } catch {
      setRootPathState(workspaceId, { status: 'error' })
    }
  }

  async function create(name: string, rootPath: string): Promise<WorkspaceDto | null> {
    loading.value = true
    errorMessage.value = null
    try {
      const workspace = await workspaceEndpoints.create({ name, root_path: rootPath })
      workspaces.value = [...workspaces.value, workspace]
      selectedId.value = workspace.id
      setRootPathState(workspace.id, { status: 'loading' })
      await loadRootPath(workspace.id)
      return workspace
    } catch (error: unknown) {
      errorMessage.value = error instanceof ApiClientError ? error.message : 'Workspace 创建失败'
      return null
    } finally {
      loading.value = false
    }
  }

  async function setRootPath(workspaceId: string, rootPath: string): Promise<boolean> {
    rootPathActionErrors.value = omitWorkspace(rootPathActionErrors.value, workspaceId)
    try {
      const dto = await workspaceEndpoints.setRootPath(workspaceId, { root_path: rootPath })
      if (dto.root_path === null) {
        setRootPathState(workspaceId, { status: 'error' })
        rootPathActionErrors.value = {
          ...rootPathActionErrors.value,
          [workspaceId]: '服务器未返回已保存的根目录，请重新读取状态。',
        }
        return false
      }
      setRootPathState(workspaceId, { status: 'configured', rootPath: dto.root_path })
      return true
    } catch (error: unknown) {
      await loadRootPath(workspaceId)
      rootPathActionErrors.value = {
        ...rootPathActionErrors.value,
        [workspaceId]: getRootPathActionError(error),
      }
      return false
    }
  }

  function select(id: string): void {
    selectedId.value = id
  }

  function setRootPathState(workspaceId: string, state: WorkspaceRootPathState): void {
    rootPathStates.value = { ...rootPathStates.value, [workspaceId]: state }
  }

  return {
    workspaces,
    selectedId,
    loading,
    errorMessage,
    rootPathStates,
    rootPathActionErrors,
    load,
    loadRootPath,
    create,
    setRootPath,
    select,
  }
})

function omitWorkspace<T>(record: Record<string, T>, workspaceId: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== workspaceId))
}

function getRootPathActionError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'workspace_root_invalid') {
      return '服务器无法访问该目录。请确认它存在、为目录且服务端有访问权限。'
    }
    if (error.code === 'workspace_root_duplicate') {
      return '该目录已关联其他工作区，请选择其他目录。'
    }
    if (error.code === 'workspace_root_already_configured') {
      return '此工作区的根目录已设置，正在重新读取当前状态。'
    }
  }
  return '根目录设置失败，请检查路径后重试。'
}
