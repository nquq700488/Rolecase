// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

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

const mountPage = async () => {
  const HomePage = (await import('./HomePage.vue')).default
  const EmptyPage = defineComponent({ render: () => h('div') })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: HomePage },
      { path: '/workspaces/:workspaceId/provider', component: EmptyPage },
    ],
  })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(HomePage, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

describe('HomePage Workspace 根路径流程', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.restoreAllMocks()
    setActivePinia(createPinia())
    window.localStorage.clear()
    mocks.list.mockResolvedValue([])
    mocks.getRootPath.mockImplementation(async (id: string) => ({ workspace_id: id, root_path: null }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('新建 Workspace 必须同时提供名称和绝对根路径', async () => {
    const wrapper = await mountPage()
    mocks.create.mockResolvedValue(workspace('created'))
    mocks.getRootPath.mockResolvedValue({ workspace_id: 'created', root_path: '/canonical/created' })

    await wrapper.get('#workspace-name').setValue('Research')
    await wrapper.get('form[aria-label="新建工作区"]').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('输入现存目录的绝对路径')
    expect(mocks.create).not.toHaveBeenCalled()

    await wrapper.get('#workspace-root-path').setValue('/input/workspace')
    await wrapper.get('form[aria-label="新建工作区"]').trigger('submit')
    await flushPromises()

    expect(mocks.create).toHaveBeenCalledWith({ name: 'Research', root_path: '/input/workspace' })
  })

  it('取消一次性补设确认时不发送写入请求', async () => {
    mocks.list.mockResolvedValue([workspace('legacy')])
    const wrapper = await mountPage()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    await wrapper.get('button.root-path-configure').trigger('click')
    await wrapper.get('#root-path-input').setValue('/input/legacy')
    await wrapper.get('form[aria-label="一次性设置根目录"]').trigger('submit')
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('不能修改'))
    expect(mocks.setRootPath).not.toHaveBeenCalled()
  })

  it('确认补设后展示服务端返回的 canonical 路径', async () => {
    mocks.list.mockResolvedValue([workspace('legacy')])
    mocks.setRootPath.mockResolvedValue({
      workspace_id: 'legacy',
      root_path: '/canonical/legacy',
    })
    const wrapper = await mountPage()
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    await wrapper.get('button.root-path-configure').trigger('click')
    await wrapper.get('#root-path-input').setValue('/input/legacy-alias')
    await wrapper.get('form[aria-label="一次性设置根目录"]').trigger('submit')
    await flushPromises()

    expect(mocks.setRootPath).toHaveBeenCalledWith('legacy', { root_path: '/input/legacy-alias' })
    expect(wrapper.text()).toContain('/canonical/legacy')
    expect(wrapper.find('button.root-path-configure').exists()).toBe(false)
    expect(window.localStorage.length).toBe(0)
  })

  it('补设期间服务端已配置时关闭编辑入口并展示当前规范路径', async () => {
    mocks.list.mockResolvedValue([workspace('legacy')])
    mocks.getRootPath
      .mockResolvedValueOnce({ workspace_id: 'legacy', root_path: null })
      .mockResolvedValueOnce({ workspace_id: 'legacy', root_path: '/canonical/winner' })
    mocks.setRootPath.mockRejectedValue(new Error('设置冲突'))
    const wrapper = await mountPage()
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    await wrapper.get('button.root-path-configure').trigger('click')
    await wrapper.get('#root-path-input').setValue('/input/other')
    await wrapper.get('form[aria-label="一次性设置根目录"]').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('/canonical/winner')
    expect(wrapper.find('#root-path-input').exists()).toBe(false)
    expect(wrapper.find('button.root-path-configure').exists()).toBe(false)
  })

  it('根路径读取失败时显示错误和重试而不提供补设入口', async () => {
    mocks.list.mockResolvedValue([workspace('legacy')])
    mocks.getRootPath
      .mockRejectedValueOnce(new Error('读取失败'))
      .mockResolvedValueOnce({ workspace_id: 'legacy', root_path: null })
    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('根目录状态读取失败')
    expect(wrapper.find('button.root-path-configure').exists()).toBe(false)

    await wrapper.get('button.root-path-retry').trigger('click')
    await flushPromises()

    expect(mocks.getRootPath).toHaveBeenCalledTimes(2)
    expect(wrapper.find('button.root-path-configure').exists()).toBe(true)
  })
})
