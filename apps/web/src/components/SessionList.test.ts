// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

import type { SessionDto } from '@rolecast/contract'

const listSessions = vi.fn()

vi.mock('@/api/endpoints.js', () => ({
  sessionEndpoints: {
    list: (...args: unknown[]) => listSessions(...args),
  },
}))

const RouterLinkStub = defineComponent({
  name: 'RouterLink',
  props: { to: { type: [String, Object], required: true } },
  setup: (props, { slots }) => () => h('a', {
    href: typeof props.to === 'string' ? props.to : undefined,
  }, slots.default?.()),
})

const makeSession = (overrides: Partial<SessionDto> = {}): SessionDto => ({
  id: 'session-001',
  workspace_id: 'workspace-a',
  name: '设计讨论',
  status: 'active',
  created_at: '2026-10-25T12:00:00.000Z',
  updated_at: '2026-10-26T12:30:00.000Z',
  ...overrides,
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const mountList = async (workspaceId = 'workspace-a') => {
  const SessionList = (await import('./SessionList.vue')).default
  return mount(SessionList, {
    props: { workspaceId },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}

describe('SessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listSessions.mockResolvedValue([])
  })

  it('按 API 顺序展示 Session 信息并链接到对应 Room', async () => {
    const sessions = [
      makeSession({ id: 'session-recent', name: '最近的讨论', status: 'active' }),
      makeSession({
        id: 'session-old',
        name: '已完成的规划',
        status: 'completed',
        updated_at: '2026-10-24T12:30:00.000Z',
      }),
    ]
    listSessions.mockResolvedValue(sessions)

    const wrapper = await mountList()
    await flushPromises()

    const rows = wrapper.findAll('ul[aria-label="已有 Session"] > li')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('最近的讨论')
    expect(rows[0]?.text()).toContain('运行中')
    expect(rows[1]?.text()).toContain('已完成的规划')
    expect(rows[1]?.text()).toContain('已完成')
    expect(wrapper.findAll('time').map((time) => time.attributes('datetime'))).toEqual([
      '2026-10-26T12:30:00.000Z',
      '2026-10-24T12:30:00.000Z',
    ])
    expect(wrapper.findAll('a[href^="/sessions/"]').map((link) => link.attributes('href'))).toEqual([
      '/sessions/session-recent',
      '/sessions/session-old',
    ])
    expect(listSessions).toHaveBeenCalledExactlyOnceWith('workspace-a')
  })

  it('等待请求时显示加载状态，空结果显示创建入口', async () => {
    const pending = deferred<SessionDto[]>()
    listSessions.mockReturnValue(pending.promise)

    const wrapper = await mountList()
    expect(wrapper.get('[role="status"]').text()).toContain('正在加载')

    pending.resolve([])
    await flushPromises()

    expect(wrapper.get('[data-testid="sessions-empty"]').text()).toContain('还没有 Session')
    expect(wrapper.find('a[href="#provider-settings"]').exists()).toBe(true)
    expect(wrapper.find('ul').exists()).toBe(false)
  })

  it('请求失败后显示错误并支持一次重试恢复', async () => {
    listSessions
      .mockRejectedValueOnce(new Error('request failed'))
      .mockResolvedValueOnce([makeSession({ id: 'session-recovered', name: '恢复后的 Session' })])

    const wrapper = await mountList()
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('Session 列表加载失败')
    expect(wrapper.find('[data-testid="sessions-empty"]').exists()).toBe(false)

    await wrapper.get('[data-testid="retry-sessions"]').trigger('click')
    await flushPromises()

    expect(listSessions).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('恢复后的 Session')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('切换 Workspace 时清空旧条目并加载新 Workspace', async () => {
    const pendingB = deferred<SessionDto[]>()
    listSessions.mockImplementation((workspaceId: string) => (workspaceId === 'workspace-a'
      ? Promise.resolve([makeSession({ id: 'session-a', name: 'A 的 Session' })])
      : pendingB.promise))

    const wrapper = await mountList()
    await flushPromises()
    expect(wrapper.text()).toContain('A 的 Session')

    await wrapper.setProps({ workspaceId: 'workspace-b' })

    expect(listSessions).toHaveBeenLastCalledWith('workspace-b')
    expect(wrapper.text()).not.toContain('A 的 Session')
    expect(wrapper.get('[role="status"]').text()).toContain('正在加载')

    pendingB.resolve([makeSession({ id: 'session-b', workspace_id: 'workspace-b', name: 'B 的 Session' })])
    await flushPromises()

    expect(wrapper.text()).toContain('B 的 Session')
    expect(wrapper.text()).not.toContain('A 的 Session')
  })

  it('丢弃旧 Workspace 的迟到响应', async () => {
    const pendingA = deferred<SessionDto[]>()
    listSessions.mockImplementation((workspaceId: string) => (workspaceId === 'workspace-a'
      ? pendingA.promise
      : Promise.resolve([makeSession({ id: 'session-b', workspace_id: 'workspace-b', name: 'B 的 Session' })])))

    const wrapper = await mountList()
    await wrapper.setProps({ workspaceId: 'workspace-b' })
    await flushPromises()

    pendingA.resolve([makeSession({ id: 'session-a', name: 'A 的迟到 Session' })])
    await flushPromises()

    expect(listSessions.mock.calls.map(([workspaceId]) => workspaceId)).toEqual(['workspace-a', 'workspace-b'])
    expect(wrapper.text()).toContain('B 的 Session')
    expect(wrapper.text()).not.toContain('A 的迟到 Session')
  })

  it('卸载后不渲染尚未完成请求的结果', async () => {
    const pending = deferred<SessionDto[]>()
    listSessions.mockReturnValue(pending.promise)

    const wrapper = await mountList()
    expect(listSessions).toHaveBeenCalledExactlyOnceWith('workspace-a')
    wrapper.unmount()
    pending.resolve([makeSession({ id: 'session-after-unmount', name: '卸载后的 Session' })])
    await flushPromises()

    expect(wrapper.find('a[href^="/sessions/"]').exists()).toBe(false)
  })
})
