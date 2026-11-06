// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactContentDto, ArtifactDto } from '@rolecast/contract'

const mocks = vi.hoisted(() => ({ list: vi.fn(), content: vi.fn() }))

vi.mock('@/api/endpoints.js', () => ({
  artifactEndpoints: {
    list: (...args: unknown[]) => mocks.list(...args),
    content: (...args: unknown[]) => mocks.content(...args),
  },
}))

import ArtifactPanel from './ArtifactPanel.vue'

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

const body = (id: string, value: string): ArtifactContentDto => ({
  artifact_id: id,
  media_type: 'text/plain; charset=utf-8',
  content: value,
})

const mountPanel = async (attachTo?: HTMLElement) => {
  const wrapper = mount(ArtifactPanel, {
    props: { sessionId: 'session-1' },
    global: { plugins: [createPinia()] },
    ...(attachTo ? { attachTo } : {}),
  })
  await flushPromises()
  return wrapper
}

describe('ArtifactPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mocks.list.mockResolvedValue({ items: [artifact('artifact-a')], next_cursor: null })
    mocks.content.mockResolvedValue(body('artifact-a', '预览正文'))
  })

  it('首屏只呈现 metadata，用户打开后才读取并以纯文本显示正文', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.get('[data-testid="artifact-item-artifact-a"]').text()).toContain('artifact-a')
    expect(mocks.list).toHaveBeenCalledWith('session-1', { limit: 50 })
    expect(mocks.content).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="artifact-item-artifact-a"]').trigger('click')
    await flushPromises()

    expect(mocks.content).toHaveBeenCalledWith('session-1', 'artifact-a')
    expect(wrapper.get('[data-testid="artifact-preview"] pre').text()).toBe('预览正文')
  })

  it('恶意 HTML 样本文字保持文本，不创建可执行 DOM 节点', async () => {
    mocks.content.mockResolvedValue(body('artifact-a', '<img src=x onerror=alert(1)><script>bad()</script>'))
    const wrapper = await mountPanel()
    await wrapper.get('[data-testid="artifact-item-artifact-a"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="artifact-preview"] pre').text())
      .toBe('<img src=x onerror=alert(1)><script>bad()</script>')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
  })

  it('关闭预览后将焦点恢复到打开它的条目按钮', async () => {
    const wrapper = await mountPanel(document.body)

    try {
      const trigger = wrapper.get('[data-testid="artifact-item-artifact-a"]').element as HTMLButtonElement
      trigger.focus()
      trigger.click()
      await flushPromises()
      const closeButton = wrapper.get('[data-testid="artifact-close-preview"]').element as HTMLButtonElement
      closeButton.focus()
      closeButton.click()
      await flushPromises()

      expect(wrapper.find('[data-testid="artifact-preview"]').exists()).toBe(false)
      expect(document.activeElement).toBe(trigger)
    } finally {
      wrapper.unmount()
      wrapper.element.remove()
    }
  })

  it('触发按钮脱离 DOM 后关闭不调用旧节点 focus', async () => {
    const wrapper = await mountPanel(document.body)

    try {
      const trigger = wrapper.get('[data-testid="artifact-item-artifact-a"]').element as HTMLButtonElement
      trigger.click()
      await flushPromises()
      const focus = vi.spyOn(trigger, 'focus')
      trigger.remove()
      await wrapper.get('[data-testid="artifact-close-preview"]').trigger('click')
      await flushPromises()

      expect(focus).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      wrapper.element.remove()
    }
  })

  it('分页失败保留已加载条目并允许重试', async () => {
    mocks.list
      .mockResolvedValueOnce({ items: [artifact('artifact-a')], next_cursor: 'cursor-a' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [artifact('artifact-b')], next_cursor: null })
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="artifact-load-more"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('加载失败')
    expect(wrapper.find('[data-testid="artifact-item-artifact-a"]').exists()).toBe(true)

    await wrapper.get('[data-testid="artifact-load-more"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="artifact-item-artifact-b"]').exists()).toBe(true)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('列表错误显示可重试入口，空列表显示明确空态', async () => {
    mocks.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [], next_cursor: null })
    const wrapper = await mountPanel()
    expect(wrapper.get('[role="alert"]').text()).toContain('失败')

    await wrapper.get('[data-testid="artifact-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('还没有 Artifact')
  })
})
