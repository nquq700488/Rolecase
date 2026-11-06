import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MailboxMessageDetailDto, MailboxMessageSummaryDto, MailboxPageDto } from '@rolecast/contract'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  markRead: vi.fn(),
}))

vi.mock('@/api/endpoints.js', () => ({
  mailboxEndpoints: {
    list: (...args: unknown[]) => mocks.list(...args),
    detail: (...args: unknown[]) => mocks.detail(...args),
    markRead: (...args: unknown[]) => mocks.markRead(...args),
  },
}))

const summary = (id: string, overrides: Partial<MailboxMessageSummaryDto> = {}): MailboxMessageSummaryDto => ({
  id,
  session_id: 'session-1',
  sender_id: 'slot-sender',
  to_slot_id: 'slot-1',
  created_at: '2026-11-05T09:00:00.000Z',
  status: 'unread',
  read_at: null,
  ...overrides,
})

const page = (items: MailboxMessageSummaryDto[], nextCursor: string | null = null): MailboxPageDto => ({
  items,
  next_cursor: nextCursor,
})

const detail = (item: MailboxMessageSummaryDto): MailboxMessageDetailDto => ({
  message: {
    id: item.id,
    session_id: item.session_id,
    run_id: 'run-1',
    sender_kind: 'agent',
    sender_id: item.sender_id,
    content: `body-${item.id}`,
    created_at: item.created_at,
    kind: 'handoff',
    to_slot_id: item.to_slot_id,
  },
  status: item.status,
  read_at: item.read_at,
})

const loadStore = async () => (await import('./mailbox.js')).useMailboxStore()

describe('Mailbox Store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    setActivePinia(createPinia())
  })

  it('只统计已加载摘要的未读数，并在有下一页时提示仍有更多', async () => {
    mocks.list.mockResolvedValue(page([summary('message-1'), summary('message-2', { status: 'read', read_at: '2026-11-05T10:00:00.000Z' })], 'message-2'))
    const store = await loadStore()

    await store.load('session-1', 'slot-1')

    expect(mocks.list).toHaveBeenCalledWith('session-1', { slot_id: 'slot-1', limit: 50 })
    expect(store.items).toHaveLength(2)
    expect(store.loadedUnreadCount).toBe(1)
    expect(store.hasMore).toBe(true)
    expect(store.loading).toBe(false)
  })

  it('加载更多追加到已加载摘要且不重复', async () => {
    mocks.list
      .mockResolvedValueOnce(page([summary('message-1')], 'message-1'))
      .mockResolvedValueOnce(page([summary('message-2')]))
    const store = await loadStore()
    await store.load('session-1', 'slot-1')

    await store.loadMore('session-1', 'slot-1')

    expect(mocks.list).toHaveBeenLastCalledWith('session-1', { slot_id: 'slot-1', limit: 50, cursor: 'message-1' })
    expect(store.items.map((item) => item.id)).toEqual(['message-1', 'message-2'])
    expect(store.loadedUnreadCount).toBe(2)
    expect(store.hasMore).toBe(false)
  })

  it('切换 Slot 时清空旧摘要并丢弃迟到响应', async () => {
    let resolveFirst: (value: MailboxPageDto) => void = () => undefined
    mocks.list
      .mockImplementationOnce(() => new Promise<MailboxPageDto>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce(page([summary('message-b')]))
    const store = await loadStore()

    const first = store.load('session-1', 'slot-a')
    await store.load('session-1', 'slot-b')
    resolveFirst(page([summary('message-a')]))
    await first

    expect(store.items.map((item) => item.id)).toEqual(['message-b'])
  })

  it('打开详情后显式标记已读并只递减一次', async () => {
    const item = summary('message-1')
    mocks.list.mockResolvedValue(page([item]))
    mocks.detail.mockResolvedValue(detail(item))
    mocks.markRead.mockResolvedValue({
      message_id: 'message-1', status: 'read', read_at: '2026-11-05T12:00:00.000Z', event_bus_status: 'published',
    })
    const store = await loadStore()
    await store.load('session-1', 'slot-1')

    await store.open('session-1', 'slot-1', 'message-1')
    expect(mocks.markRead).toHaveBeenCalledWith('session-1', 'message-1', { slot_id: 'slot-1' })
    expect(store.loadedUnreadCount).toBe(0)
    expect(store.items[0]).toMatchObject({ status: 'read', read_at: '2026-11-05T12:00:00.000Z' })

    await store.open('session-1', 'slot-1', 'message-1')
    expect(store.loadedUnreadCount).toBe(0)
  })

  it('标记已读失败时保留 unread 并显示可重试错误', async () => {
    const item = summary('message-1')
    mocks.list.mockResolvedValue(page([item]))
    mocks.detail.mockResolvedValue(detail(item))
    mocks.markRead.mockRejectedValue(new Error('unavailable'))
    const store = await loadStore()
    await store.load('session-1', 'slot-1')

    await store.open('session-1', 'slot-1', 'message-1')

    expect(store.items[0]?.status).toBe('unread')
    expect(store.loadedUnreadCount).toBe(1)
    expect(store.actionError).toContain('已读')
  })

  it('EventBus 通知失败时仍保留已读状态并提示刷新', async () => {
    const item = summary('message-1')
    mocks.list.mockResolvedValue(page([item]))
    mocks.detail.mockResolvedValue(detail(item))
    mocks.markRead.mockResolvedValue({
      message_id: 'message-1', status: 'read', read_at: '2026-11-05T12:00:00.000Z', event_bus_status: 'failed',
    })
    const store = await loadStore()
    await store.load('session-1', 'slot-1')

    await store.open('session-1', 'slot-1', 'message-1')

    expect(store.items[0]?.status).toBe('read')
    expect(store.notice).toContain('刷新')
  })

  it('同一 Slot 内先打开 A 再打开 B 时，迟到的 A 详情不覆盖 B', async () => {
    const first = summary('message-a')
    const second = summary('message-b')
    let resolveA: (value: MailboxMessageDetailDto) => void = () => undefined
    mocks.list.mockResolvedValue(page([first, second]))
    mocks.detail
      .mockImplementationOnce(() => new Promise<MailboxMessageDetailDto>((resolve) => { resolveA = resolve }))
      .mockResolvedValueOnce(detail(second))
    mocks.markRead.mockResolvedValue({
      message_id: 'message-a', status: 'read', read_at: '2026-11-05T12:00:00.000Z', event_bus_status: 'published',
    })
    const store = await loadStore()
    await store.load('session-1', 'slot-1')

    const openA = store.open('session-1', 'slot-1', 'message-a')
    await store.open('session-1', 'slot-1', 'message-b')
    resolveA(detail(first))
    await openA

    // B 是用户当前打开的详情，并已显式标记已读；迟到的 A 不得覆盖它。
    expect(store.detail?.message.id).toBe('message-b')
    expect(store.detail?.status).toBe('read')
    expect(store.items.find((item) => item.id === 'message-a')?.status).toBe('unread')
    expect(mocks.markRead).toHaveBeenCalledTimes(1)
  })

  it('过期的 mark-read 失败不污染当前详情反馈', async () => {
    const first = summary('message-a')
    const second = summary('message-b')
    let rejectA: (error: Error) => void = () => undefined
    mocks.list.mockResolvedValue(page([first, second]))
    mocks.detail.mockImplementation((_session: string, messageId: string) => (
      Promise.resolve(detail(messageId === 'message-a' ? first : second))
    ))
    mocks.markRead.mockImplementation((_session: string, messageId: string) => (
      messageId === 'message-a'
        ? new Promise((_resolve, reject) => { rejectA = reject })
        : Promise.resolve({
          message_id: 'message-b', status: 'read', read_at: '2026-11-05T13:00:00.000Z', event_bus_status: 'published',
        })
    ))
    const store = await loadStore()
    await store.load('session-1', 'slot-1')

    const openA = store.open('session-1', 'slot-1', 'message-a')
    // 让 A 的详情完成并发出 mark-read，再切换到 B。
    await Promise.resolve()
    await store.open('session-1', 'slot-1', 'message-b')
    rejectA(new Error('unavailable'))
    await openA

    expect(store.detail?.message.id).toBe('message-b')
    expect(store.actionError).toBeNull()
    expect(store.items.find((item) => item.id === 'message-a')?.status).toBe('unread')
    // 确认 A 的 mark-read 确实在 B 之前发出，避免测试退化为未执行分支。
    expect(mocks.markRead.mock.calls.map((call) => call[1])).toEqual(['message-a', 'message-b'])
  })

  it('过期的 EventBus 失败通知不显示到当前详情', async () => {
    const first = summary('message-a')
    const second = summary('message-b')
    let resolveA: (value: unknown) => void = () => undefined
    mocks.list.mockResolvedValue(page([first, second]))
    mocks.detail.mockImplementation((_session: string, messageId: string) => (
      Promise.resolve(detail(messageId === 'message-a' ? first : second))
    ))
    mocks.markRead.mockImplementation((_session: string, messageId: string) => (
      messageId === 'message-a'
        ? new Promise((resolve) => { resolveA = resolve })
        : Promise.resolve({
          message_id: 'message-b', status: 'read', read_at: '2026-11-05T13:00:00.000Z', event_bus_status: 'published',
        })
    ))
    const store = await loadStore()
    await store.load('session-1', 'slot-1')

    const openA = store.open('session-1', 'slot-1', 'message-a')
    // 让 A 的详情完成并发出 mark-read，再切换到 B。
    await Promise.resolve()
    await store.open('session-1', 'slot-1', 'message-b')
    resolveA({
      message_id: 'message-a', status: 'read', read_at: '2026-11-05T12:00:00.000Z', event_bus_status: 'failed',
    })
    await openA

    expect(store.detail?.message.id).toBe('message-b')
    expect(store.notice).toBeNull()
    // 已持久化的 A 状态仍按消息 ID 更新摘要。
    expect(store.items.find((item) => item.id === 'message-a')?.status).toBe('read')
    expect(mocks.markRead.mock.calls.map((call) => call[1])).toEqual(['message-a', 'message-b'])
  })

  it('关闭详情会使未完成的详情请求失效', async () => {
    const item = summary('message-1')
    let resolveDetail: (value: MailboxMessageDetailDto) => void = () => undefined
    mocks.list.mockResolvedValue(page([item]))
    mocks.detail.mockImplementationOnce(() => new Promise<MailboxMessageDetailDto>((resolve) => { resolveDetail = resolve }))
    const store = await loadStore()
    await store.load('session-1', 'slot-1')

    const opening = store.open('session-1', 'slot-1', 'message-1')
    store.closeDetail()
    resolveDetail(detail(item))
    await opening

    expect(store.detail).toBeNull()
    expect(mocks.markRead).not.toHaveBeenCalled()
    expect(store.items[0]?.status).toBe('unread')
  })

  it('详情读取失败时不调用 mark-read 且保留 unread', async () => {
    const item = summary('message-1')
    mocks.list.mockResolvedValue(page([item]))
    mocks.detail.mockRejectedValue(new Error('unavailable'))
    const store = await loadStore()
    await store.load('session-1', 'slot-1')

    await store.open('session-1', 'slot-1', 'message-1')

    expect(mocks.markRead).not.toHaveBeenCalled()
    expect(store.items[0]?.status).toBe('unread')
    expect(store.actionError).not.toBeNull()
  })
})
