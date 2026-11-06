import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }))

vi.mock('./httpClient.js', () => ({
  apiRequest: (...args: unknown[]) => mocks.apiRequest(...args),
}))

import { workspaceEndpoints } from './endpoints.js'

describe('Workspace root-path API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('读取未配置 Workspace 时保留 null 状态', async () => {
    mocks.apiRequest.mockResolvedValue({ workspace_id: 'workspace-001', root_path: null })

    await expect(workspaceEndpoints.getRootPath('workspace-001')).resolves.toEqual({
      workspace_id: 'workspace-001',
      root_path: null,
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      { method: 'GET', url: '/api/workspaces/workspace-001/root-path' },
      expect.anything(),
    )
  })

  it('一次性补设只发送 root_path 并解析服务端 canonical 路径', async () => {
    mocks.apiRequest.mockResolvedValue({
      workspace_id: 'workspace-001',
      root_path: '/srv/workspaces/project',
    })

    await expect(workspaceEndpoints.setRootPath('workspace-001', {
      root_path: '/srv/workspaces/project-alias',
    })).resolves.toEqual({
      workspace_id: 'workspace-001',
      root_path: '/srv/workspaces/project',
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      {
        method: 'POST',
        url: '/api/workspaces/workspace-001/root-path',
        data: { root_path: '/srv/workspaces/project-alias' },
      },
      expect.anything(),
    )
  })

  it('补设请求拒绝空路径', () => {
    expect(() => workspaceEndpoints.setRootPath('workspace-001', { root_path: '' })).toThrow()
    expect(mocks.apiRequest).not.toHaveBeenCalled()
  })
})
