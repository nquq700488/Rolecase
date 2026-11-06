import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { MailboxMessageDetailDto, MailboxMessageSummaryDto } from '@rolecast/contract'

import { mailboxEndpoints } from '@/api/endpoints.js'

const PAGE_LIMIT = 50

/**
 * 单 Slot Mailbox：摘要分页、详情读取与显式已读。
 *
 * 未读数只代表“已加载摘要”，`hasMore` 为真时页面必须提示还有未加载消息。
 */
export const useMailboxStore = defineStore('mailbox', () => {
  const items = ref<MailboxMessageSummaryDto[]>([])
  const nextCursor = ref<string | null>(null)
  const loading = ref(false)
  const loadingMore = ref(false)
  const loadError = ref<string | null>(null)
  const actionError = ref<string | null>(null)
  const notice = ref<string | null>(null)
  const detail = ref<MailboxMessageDetailDto | null>(null)
  const detailLoading = ref(false)

  const loadedUnreadCount = computed(() => items.value.filter((item) => item.status === 'unread').length)
  const hasMore = computed(() => nextCursor.value !== null)

  // 只有当前 Session+Slot 的最新请求可以写共享状态。
  let generation = 0
  let scopeSessionId = ''
  let scopeSlotId = ''
  // 同一收件范围内还要区分不同消息的详情请求先后；关闭详情同样使其失效。
  let detailRequestId = 0

  function isCurrent(generation_: number, sessionId: string, slotId: string): boolean {
    return generation_ === generation && scopeSessionId === sessionId && scopeSlotId === slotId
  }

  function reset(): void {
    generation += 1
    detailRequestId += 1
    scopeSessionId = ''
    scopeSlotId = ''
    items.value = []
    nextCursor.value = null
    loading.value = false
    loadingMore.value = false
    loadError.value = null
    actionError.value = null
    notice.value = null
    detail.value = null
    detailLoading.value = false
  }

  /** 加载第一页；切换 Session/Slot 会清空旧摘要并丢弃迟到响应。 */
  async function load(sessionId: string, slotId: string): Promise<void> {
    const current = ++generation
    scopeSessionId = sessionId
    scopeSlotId = slotId
    items.value = []
    nextCursor.value = null
    loadError.value = null
    actionError.value = null
    notice.value = null
    detail.value = null
    loading.value = true
    try {
      const page = await mailboxEndpoints.list(sessionId, { slot_id: slotId, limit: PAGE_LIMIT })
      if (!isCurrent(current, sessionId, slotId)) {
        return
      }
      items.value = page.items
      nextCursor.value = page.next_cursor
    } catch {
      if (isCurrent(current, sessionId, slotId)) {
        loadError.value = '收件箱加载失败，请重试。'
      }
    } finally {
      if (isCurrent(current, sessionId, slotId)) {
        loading.value = false
      }
    }
  }

  /** 按 keyset cursor 追加下一页。 */
  async function loadMore(sessionId: string, slotId: string): Promise<void> {
    const cursor = nextCursor.value
    if (cursor === null || loadingMore.value || !isCurrent(generation, sessionId, slotId)) {
      return
    }
    const current = generation
    loadingMore.value = true
    actionError.value = null
    try {
      const page = await mailboxEndpoints.list(sessionId, { slot_id: slotId, limit: PAGE_LIMIT, cursor })
      if (!isCurrent(current, sessionId, slotId)) {
        return
      }
      const known = new Set(items.value.map((item) => item.id))
      items.value = [...items.value, ...page.items.filter((item) => !known.has(item.id))]
      nextCursor.value = page.next_cursor
    } catch {
      if (isCurrent(current, sessionId, slotId)) {
        actionError.value = '更多消息加载失败，请重试。'
      }
    } finally {
      if (isCurrent(current, sessionId, slotId)) {
        loadingMore.value = false
      }
    }
  }

  /** 打开详情后显式标记已读；详情读取失败不写状态。 */
  async function open(sessionId: string, slotId: string, messageId: string): Promise<void> {
    if (!isCurrent(generation, sessionId, slotId)) {
      return
    }
    const current = generation
    const request = ++detailRequestId
    // 同一 Session/Slot 内只有最近一次打开可以写 detail。
    const isCurrentDetail = (): boolean => request === detailRequestId && isCurrent(current, sessionId, slotId)
    detailLoading.value = true
    actionError.value = null
    notice.value = null
    try {
      const loaded = await mailboxEndpoints.detail(sessionId, messageId, slotId)
      if (!isCurrentDetail()) {
        return
      }
      detail.value = loaded
    } catch {
      if (isCurrentDetail()) {
        actionError.value = '消息读取失败，仍为未读，请重试。'
      }
      return
    } finally {
      if (isCurrentDetail()) {
        detailLoading.value = false
      }
    }

    try {
      const result = await mailboxEndpoints.markRead(sessionId, messageId, { slot_id: slotId })
      if (!isCurrent(current, sessionId, slotId)) {
        return
      }
      items.value = items.value.map((item) => (
        item.id === messageId ? { ...item, status: 'read', read_at: result.read_at } : item
      ))
      // 迟到的 mark-read 只能更新它自己的详情，不能投影到用户当前打开的另一条消息。
      if (isCurrentDetail() && detail.value?.message.id === messageId) {
        detail.value = { ...detail.value, status: 'read', read_at: result.read_at }
      }
      // 已过期的请求反馈不能出现在用户当前打开的另一条消息旁。
      if (result.event_bus_status === 'failed' && isCurrentDetail()) {
        notice.value = '已读状态已保存，但实时通知未送达，可刷新列表确认。'
      }
    } catch {
      if (isCurrentDetail()) {
        actionError.value = '已读状态保存失败，消息仍为未读，请重试。'
      }
    }
  }

  function closeDetail(): void {
    detailRequestId += 1
    detail.value = null
    detailLoading.value = false
  }

  return {
    items,
    nextCursor,
    loading,
    loadingMore,
    loadError,
    actionError,
    notice,
    detail,
    detailLoading,
    loadedUnreadCount,
    hasMore,
    load,
    loadMore,
    open,
    closeDetail,
    reset,
  }
})
