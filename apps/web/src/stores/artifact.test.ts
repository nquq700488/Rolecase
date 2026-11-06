import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactContentDto, ArtifactDto } from '@rolecast/contract'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  content: vi.fn(),
}))

vi.mock('@/api/endpoints.js', () => ({
  artifactEndpoints: {
    list: (...args: unknown[]) => mocks.list(...args),
    content: (...args: unknown[]) => mocks.content(...args),
  },
}))

import { useArtifactStore } from './artifact.js'

const artifact = (id: string): ArtifactDto => ({
  id,
  workspace_id: 'workspace-1',
  session_id: 'session-1',
  task_id: 'task-1',
  source_run_id: 'run-1',
  media_type: 'text/plain; charset=utf-8',
  storage_kind: 'inline',
  status: 'ready',
  size_bytes: 12,
  sha256: 'a'.repeat(64),
  created_at: '2026-11-05T09:00:00.000Z',
})

const page = (items: ArtifactDto[], next_cursor: string | null = null) => ({ items, next_cursor })
const content = (id: string, value: string): ArtifactContentDto => ({
  artifact_id: id,
  media_type: 'text/plain; charset=utf-8',
  content: value,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('ArtifactStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  it('初次加载和翻页只获取 metadata，并对重复项去重', async () => {
    mocks.list
      .mockResolvedValueOnce(page([artifact('artifact-a')], 'artifact-a'))
      .mockResolvedValueOnce(page([artifact('artifact-a'), artifact('artifact-b')]))
    const store = useArtifactStore()

    await store.load('session-1')
    expect(mocks.list).toHaveBeenCalledWith('session-1', { limit: 50 })
    expect(mocks.content).not.toHaveBeenCalled()
    await store.loadMore('session-1')

    expect(mocks.list).toHaveBeenLastCalledWith('session-1', { limit: 50, cursor: 'artifact-a' })
    expect(store.items.map((item) => item.id)).toEqual(['artifact-a', 'artifact-b'])
    expect(mocks.content).not.toHaveBeenCalled()
  })

  it('Session 切换时立即解除旧分页请求的 loadingMore 状态', async () => {
    const oldPage = deferred<ReturnType<typeof page>>()
    mocks.list
      .mockResolvedValueOnce(page([artifact('artifact-old')], 'artifact-old'))
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce(page([artifact('artifact-new')]))
    const store = useArtifactStore()
    await store.load('session-1')

    const loadingOldPage = store.loadMore('session-1')
    expect(store.loadingMore).toBe(true)

    await store.load('session-2')
    expect(store.loadingMore).toBe(false)
    oldPage.resolve(page([artifact('artifact-late')]))
    await loadingOldPage

    expect(store.loadingMore).toBe(false)
    expect(store.items.map((item) => item.id)).toEqual(['artifact-new'])
  })

  it('同一分页响应中的重复 Artifact ID 只追加一次', async () => {
    mocks.list
      .mockResolvedValueOnce(page([artifact('artifact-a')], 'artifact-a'))
      .mockResolvedValueOnce(page([artifact('artifact-a'), artifact('artifact-b'), artifact('artifact-b')]))
    const store = useArtifactStore()
    await store.load('session-1')

    await store.loadMore('session-1')

    expect(store.items.map((item) => item.id)).toEqual(['artifact-a', 'artifact-b'])
  })

  it('同一 Session 从 Artifact A 切换到 B 时丢弃 A 的迟到正文', async () => {
    mocks.list.mockResolvedValue(page([artifact('artifact-a'), artifact('artifact-b')]))
    const responseA = deferred<ArtifactContentDto>()
    const responseB = deferred<ArtifactContentDto>()
    mocks.content.mockReturnValueOnce(responseA.promise).mockReturnValueOnce(responseB.promise)
    const store = useArtifactStore()
    await store.load('session-1')

    const openingA = store.open('session-1', 'artifact-a')
    const openingB = store.open('session-1', 'artifact-b')
    responseB.resolve(content('artifact-b', '正文 B'))
    await openingB
    responseA.resolve(content('artifact-a', '迟到的正文 A'))
    await openingA

    expect(store.previewArtifactId).toBe('artifact-b')
    expect(store.previewContent).toBe('正文 B')
  })

  it('关闭预览使未完成的 content 请求失效', async () => {
    mocks.list.mockResolvedValue(page([artifact('artifact-a')]))
    const response = deferred<ArtifactContentDto>()
    mocks.content.mockReturnValue(response.promise)
    const store = useArtifactStore()
    await store.load('session-1')

    const opening = store.open('session-1', 'artifact-a')
    store.closePreview()
    response.resolve(content('artifact-a', '关闭后不应复活'))
    await opening

    expect(store.previewArtifactId).toBeNull()
    expect(store.previewContent).toBeNull()
  })

  it('Session 切换立即清空旧内容并丢弃迟到正文', async () => {
    mocks.list.mockResolvedValueOnce(page([artifact('artifact-a')])).mockResolvedValueOnce(page([]))
    const response = deferred<ArtifactContentDto>()
    mocks.content.mockReturnValue(response.promise)
    const store = useArtifactStore()
    await store.load('session-1')
    const opening = store.open('session-1', 'artifact-a')

    await store.load('session-2')
    response.resolve(content('artifact-a', '旧 Session 正文'))
    await opening

    expect(store.items).toEqual([])
    expect(store.previewArtifactId).toBeNull()
    expect(store.previewContent).toBeNull()
  })

  it('列表失败提供重试并在重试成功后清除错误', async () => {
    mocks.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([artifact('artifact-a')]))
    const store = useArtifactStore()

    await store.load('session-1')
    expect(store.loadError).toContain('失败')
    await store.load('session-1')

    expect(store.loadError).toBeNull()
    expect(store.items.map((item) => item.id)).toEqual(['artifact-a'])
  })
})
