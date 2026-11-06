import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }))

vi.mock('./httpClient.js', () => ({
  apiRequest: (...args: unknown[]) => mocks.apiRequest(...args),
}))

import { artifactEndpoints } from './endpoints.js'

describe('Artifact API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('按严格分页查询构造 metadata-only 列表请求', async () => {
    mocks.apiRequest.mockResolvedValue({ items: [], next_cursor: null })

    await expect(artifactEndpoints.list('session/a', { limit: 25, cursor: 'artifact/b' }))
      .resolves.toEqual({ items: [], next_cursor: null })

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      {
        method: 'GET',
        url: '/api/sessions/session%2Fa/artifacts?limit=25&cursor=artifact%2Fb',
      },
      expect.anything(),
    )
  })

  it('仅通过独立 content 路由读取正文', async () => {
    mocks.apiRequest.mockResolvedValue({ artifact_id: 'artifact-1', media_type: 'text/plain; charset=utf-8', content: 'text' })

    await artifactEndpoints.content('session-1', 'artifact-1')

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      { method: 'GET', url: '/api/sessions/session-1/artifacts/artifact-1/content' },
      expect.anything(),
    )
  })

  it('在发送前拒绝越界分页参数', () => {
    expect(() => artifactEndpoints.list('session-1', { limit: 101 })).toThrow()
    expect(mocks.apiRequest).not.toHaveBeenCalled()
  })
})
