import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceDto } from '@rolecast/contract'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getRootPath: vi.fn(),
  setRootPath: vi.fn(),
}))

vi.mock('@/api/endpoints.js', () => ({
  workspaceEndpoints: {
    list: (...args: unknown[]) => mocks.list(...args),
    create: (...args: unknown[]) => mocks.create(...args),
    getRootPath: (...args: unknown[]) => mocks.getRootPath(...args),
    setRootPath: (...args: unknown[]) => mocks.setRootPath(...args),
  },
}))

const workspace = (id: string): WorkspaceDto => ({
  id,
  name: `Workspace ${id}`,
  created_at: '2026-11-04T10:00:00.000Z',
  updated_at: '2026-11-04T10:00:00.000Z',
})

const loadStore = async () => (await import('./workspace.js')).useWorkspaceStore()

describe('Workspace Store 根路径状态', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    setActivePinia(createPinia())
    mocks.list.mockResolvedValue([])
  })

  it('并行读取每个 Workspace 的已配置、未配置与读取失败状态', async () => {
    mocks.list.mockResolvedValue([workspace('configured'), workspace('empty'), workspace('failed')])
    mocks.getRootPath.mockImplementation(async (id: string) => {
      if (id === 'configured') {
        return { workspace_id: id, root_path: '/canonical/project' }
      }
      if (id === 'empty') {
        return { workspace_id: id, root_path: null }
      }
      throw new Error('读取失败')
    })
    const store = await loadStore()

    await store.load()

    expect(store.rootPathStates.configured).toEqual({ status: 'configured', rootPath: '/canonical/project' })
    expect(store.rootPathStates.empty).toEqual({ status: 'unconfigured' })
    expect(store.rootPathStates.failed?.status).toBe('error')
    expect(store.rootPathStates.failed?.status).not.toBe('unconfigured')
  })

  it('创建 Workspace 时同时提交名称和根路径并从服务端读取 canonical 路径', async () => {
    const created = workspace('new-workspace')
    mocks.create.mockResolvedValue(created)
    mocks.getRootPath.mockResolvedValue({
      workspace_id: created.id,
      root_path: '/canonical/new-workspace',
    })
    const store = await loadStore()

    await expect(store.create('Research', '/input/workspace-alias')).resolves.toEqual(created)

    expect(mocks.create).toHaveBeenCalledWith({ name: 'Research', root_path: '/input/workspace-alias' })
    expect(mocks.getRootPath).toHaveBeenCalledWith(created.id)
    expect(store.rootPathStates[created.id]).toEqual({
      status: 'configured',
      rootPath: '/canonical/new-workspace',
    })
  })

  it('补设失败后重新读取服务端状态，不把竞争更新误留为未配置', async () => {
    mocks.list.mockResolvedValue([workspace('workspace-001')])
    mocks.getRootPath
      .mockResolvedValueOnce({ workspace_id: 'workspace-001', root_path: null })
      .mockResolvedValueOnce({ workspace_id: 'workspace-001', root_path: '/canonical/winner' })
    mocks.setRootPath.mockRejectedValue(new Error('设置冲突'))
    const store = await loadStore()

    await store.load()
    await expect(store.setRootPath('workspace-001', '/input/other')).resolves.toBe(false)

    expect(store.rootPathStates['workspace-001']).toEqual({
      status: 'configured',
      rootPath: '/canonical/winner',
    })
  })
})
