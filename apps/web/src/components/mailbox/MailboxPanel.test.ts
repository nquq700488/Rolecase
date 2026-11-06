// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
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

import MailboxPanel from './MailboxPanel.vue'

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

const detailOf = (item: MailboxMessageSummaryDto): MailboxMessageDetailDto => ({
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

const mountPanel = async (attachTo?: HTMLElement) => {
  const wrapper = mount(MailboxPanel, {
    props: { sessionId: 'session-1', slotId: 'slot-1' },
    ...(attachTo ? { attachTo } : {}),
  })
  await flushPromises()
  return wrapper
}

describe('MailboxPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    setActivePinia(createPinia())
  })

  it('显示已加载未读数量并在有下一页时提示仍有更多', async () => {
    mocks.list.mockResolvedValue(page([summary('message-1')], 'message-1'))

    const wrapper = await mountPanel()

    expect(wrapper.get('[data-testid="mailbox-unread"]').text()).toContain('已加载未读 1 条')
    expect(wrapper.get('[data-testid="mailbox-unread"]').text()).toContain('还有更多消息未加载')
  })

  it('打开条目后显示正文并显式标记已读', async () => {
    const item = summary('message-1')
    mocks.list.mockResolvedValue(page([item]))
    mocks.detail.mockResolvedValue(detailOf(item))
    mocks.markRead.mockResolvedValue({
      message_id: 'message-1', status: 'read', read_at: '2026-11-05T12:00:00.000Z', event_bus_status: 'published',
    })

    const wrapper = await mountPanel()
    await wrapper.get('[data-testid="mailbox-item-message-1"] button').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="mailbox-detail"]').text()).toContain('body-message-1')
    expect(wrapper.get('[data-testid="mailbox-unread"]').text()).toContain('已加载未读 0 条')
  })

  it('加载失败显示重试入口并重新请求当前 Slot', async () => {
    mocks.list.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(page([summary('message-1')]))

    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('收件箱加载失败')

    await wrapper.get('[data-testid="mailbox-retry"]').trigger('click')
    await flushPromises()

    expect(mocks.list).toHaveBeenLastCalledWith('session-1', { slot_id: 'slot-1', limit: 50 })
    expect(wrapper.get('[data-testid="mailbox-unread"]').text()).toContain('已加载未读 1 条')
  })

  it('关闭详情后将焦点恢复到打开详情的消息按钮', async () => {
    const item = summary('message-1')
    mocks.list.mockResolvedValue(page([item]))
    mocks.detail.mockResolvedValue(detailOf(item))
    mocks.markRead.mockResolvedValue({
      message_id: 'message-1', status: 'read', read_at: '2026-11-05T12:00:00.000Z', event_bus_status: 'published',
    })
    const wrapper = await mountPanel(document.body)

    try {
      const trigger = wrapper.get('[data-testid="mailbox-item-message-1"] button').element as HTMLButtonElement
      trigger.focus()
      trigger.click()
      await flushPromises()

      const closeButton = wrapper.get('[data-testid="mailbox-close-detail"]').element as HTMLButtonElement
      closeButton.focus()
      expect(document.activeElement).toBe(closeButton)
      closeButton.click()
      await flushPromises()

      expect(wrapper.find('[data-testid="mailbox-detail"]').exists()).toBe(false)
      expect(document.activeElement).toBe(trigger)
    } finally {
      wrapper.unmount()
      wrapper.element.remove()
    }
  })

  it('触发按钮脱离 DOM 后关闭详情不尝试聚焦旧按钮', async () => {
    const item = summary('message-1')
    mocks.list.mockResolvedValue(page([item]))
    mocks.detail.mockResolvedValue(detailOf(item))
    mocks.markRead.mockResolvedValue({
      message_id: 'message-1', status: 'read', read_at: '2026-11-05T12:00:00.000Z', event_bus_status: 'published',
    })
    const wrapper = await mountPanel(document.body)

    try {
      const trigger = wrapper.get('[data-testid="mailbox-item-message-1"] button').element as HTMLButtonElement
      trigger.click()
      await flushPromises()
      const focusSpy = vi.spyOn(trigger, 'focus')
      trigger.remove()

      const closeButton = wrapper.get('[data-testid="mailbox-close-detail"]').element as HTMLButtonElement
      closeButton.focus()
      closeButton.click()
      await flushPromises()

      expect(trigger.isConnected).toBe(false)
      expect(focusSpy).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="mailbox-detail"]').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      wrapper.element.remove()
    }
  })

  it('切换 Slot 时关闭详情不会恢复旧消息按钮焦点', async () => {
    const item = summary('message-1')
    mocks.list.mockResolvedValue(page([item]))
    mocks.detail.mockResolvedValue(detailOf(item))
    mocks.markRead.mockResolvedValue({
      message_id: 'message-1', status: 'read', read_at: '2026-11-05T12:00:00.000Z', event_bus_status: 'published',
    })
    const wrapper = await mountPanel(document.body)

    try {
      const trigger = wrapper.get('[data-testid="mailbox-item-message-1"] button').element as HTMLButtonElement
      trigger.click()
      await flushPromises()
      const focusSpy = vi.spyOn(trigger, 'focus')
      const closeButton = wrapper.get('[data-testid="mailbox-close-detail"]').element as HTMLButtonElement
      closeButton.click()
      await wrapper.setProps({ slotId: 'slot-2' })
      await flushPromises()

      expect(focusSpy).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="mailbox-detail"]').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      wrapper.element.remove()
    }
  })

  it('关闭处理等待期间组件卸载时不再恢复焦点', async () => {
    const item = summary('message-1')
    mocks.list.mockResolvedValue(page([item]))
    mocks.detail.mockResolvedValue(detailOf(item))
    mocks.markRead.mockResolvedValue({
      message_id: 'message-1', status: 'read', read_at: '2026-11-05T12:00:00.000Z', event_bus_status: 'published',
    })
    const wrapper = await mountPanel(document.body)
    const trigger = wrapper.get('[data-testid="mailbox-item-message-1"] button').element as HTMLButtonElement
    trigger.click()
    await flushPromises()
    const focusSpy = vi.spyOn(trigger, 'focus')
    const closeButton = wrapper.get('[data-testid="mailbox-close-detail"]').element as HTMLButtonElement
    closeButton.focus()
    closeButton.click()
    wrapper.unmount()
    wrapper.element.remove()

    await flushPromises()

    expect(focusSpy).not.toHaveBeenCalled()
  })
})
