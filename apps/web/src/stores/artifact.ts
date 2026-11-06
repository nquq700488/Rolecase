import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { ArtifactContentDto, ArtifactDto } from '@rolecast/contract'

import { artifactEndpoints } from '@/api/endpoints.js'

const PAGE_LIMIT = 50

/** Session-scoped Artifact metadata pages and explicitly requested plain-text previews. */
export const useArtifactStore = defineStore('artifact', () => {
  const items = ref<ArtifactDto[]>([])
  const nextCursor = ref<string | null>(null)
  const loading = ref(false)
  const loadingMore = ref(false)
  const loadError = ref<string | null>(null)
  const actionError = ref<string | null>(null)
  const previewArtifactId = ref<string | null>(null)
  const previewContent = ref<string | null>(null)
  const previewLoading = ref(false)
  const previewError = ref<string | null>(null)

  const hasMore = computed(() => nextCursor.value !== null)
  let generation = 0
  let scopeSessionId = ''
  let previewRequestId = 0

  function isCurrent(current: number, sessionId: string): boolean {
    return current === generation && scopeSessionId === sessionId
  }

  function reset(): void {
    generation += 1
    previewRequestId += 1
    scopeSessionId = ''
    items.value = []
    nextCursor.value = null
    loading.value = false
    loadingMore.value = false
    loadError.value = null
    actionError.value = null
    previewArtifactId.value = null
    previewContent.value = null
    previewLoading.value = false
    previewError.value = null
  }

  /** Loads the first metadata-only page and invalidates previous session work. */
  async function load(sessionId: string): Promise<void> {
    const current = ++generation
    previewRequestId += 1
    scopeSessionId = sessionId
    items.value = []
    nextCursor.value = null
    loadingMore.value = false
    loadError.value = null
    actionError.value = null
    previewArtifactId.value = null
    previewContent.value = null
    previewLoading.value = false
    previewError.value = null
    loading.value = true
    try {
      const page = await artifactEndpoints.list(sessionId, { limit: PAGE_LIMIT })
      if (isCurrent(current, sessionId)) {
        items.value = page.items
        nextCursor.value = page.next_cursor
      }
    } catch {
      if (isCurrent(current, sessionId)) {
        loadError.value = 'Artifact 列表加载失败，请重试。'
      }
    } finally {
      if (isCurrent(current, sessionId)) {
        loading.value = false
      }
    }
  }

  /** Appends one bounded metadata page and removes duplicate IDs. */
  async function loadMore(sessionId: string): Promise<void> {
    const cursor = nextCursor.value
    if (cursor === null || loadingMore.value || !isCurrent(generation, sessionId)) {
      return
    }
    const current = generation
    loadingMore.value = true
    actionError.value = null
    try {
      const page = await artifactEndpoints.list(sessionId, { limit: PAGE_LIMIT, cursor })
      if (!isCurrent(current, sessionId)) {
        return
      }
      const known = new Set(items.value.map((item) => item.id))
      items.value = [...items.value, ...page.items.filter((item) => {
        if (known.has(item.id)) {
          return false
        }
        known.add(item.id)
        return true
      })]
      nextCursor.value = page.next_cursor
    } catch {
      if (isCurrent(current, sessionId)) {
        actionError.value = '更多 Artifact 加载失败，请重试。'
      }
    } finally {
      if (isCurrent(current, sessionId)) {
        loadingMore.value = false
      }
    }
  }

  /** Fetches body only after an explicit user request; stale previews are discarded. */
  async function open(sessionId: string, artifactId: string): Promise<void> {
    if (!isCurrent(generation, sessionId) || !items.value.some((item) => item.id === artifactId)) {
      return
    }
    const current = generation
    const request = ++previewRequestId
    const isCurrentPreview = (): boolean => (
      request === previewRequestId
      && isCurrent(current, sessionId)
      && previewArtifactId.value === artifactId
    )
    previewArtifactId.value = artifactId
    previewContent.value = null
    previewError.value = null
    previewLoading.value = true
    actionError.value = null
    try {
      const body: ArtifactContentDto = await artifactEndpoints.content(sessionId, artifactId)
      if (!isCurrentPreview()) {
        return
      }
      if (body.artifact_id !== artifactId) {
        throw new Error('artifact content scope mismatch')
      }
      previewContent.value = body.content
    } catch {
      if (isCurrentPreview()) {
        previewError.value = 'Artifact 正文读取失败，请重试。'
      }
    } finally {
      if (isCurrentPreview()) {
        previewLoading.value = false
      }
    }
  }

  function closePreview(): void {
    previewRequestId += 1
    previewArtifactId.value = null
    previewContent.value = null
    previewLoading.value = false
    previewError.value = null
  }

  return {
    items,
    nextCursor,
    loading,
    loadingMore,
    loadError,
    actionError,
    previewArtifactId,
    previewContent,
    previewLoading,
    previewError,
    hasMore,
    load,
    loadMore,
    open,
    closePreview,
    reset,
  }
})
