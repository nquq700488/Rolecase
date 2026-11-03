// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import type { ProviderConnectionDto, RoleBindingDto, RoleDto } from '@rolecast/contract'

const listProviders = vi.fn()
const listModels = vi.fn()
const listRoles = vi.fn()
const listBindings = vi.fn()
const createSession = vi.fn()
const listSessions = vi.fn()

vi.mock('@/api/endpoints.js', () => ({
  credentialEndpoints: { create: vi.fn() },
  providerEndpoints: {
    list: (...args: unknown[]) => listProviders(...args),
    create: vi.fn(),
    test: vi.fn(),
    discover: vi.fn(),
    models: (...args: unknown[]) => listModels(...args),
    previewConfigImport: vi.fn(),
    applyConfigImport: vi.fn(),
    update: vi.fn(),
  },
  roleEndpoints: { list: (...args: unknown[]) => listRoles(...args) },
  bindingEndpoints: { list: (...args: unknown[]) => listBindings(...args) },
  sessionEndpoints: {
    list: (...args: unknown[]) => listSessions(...args),
    create: (...args: unknown[]) => createSession(...args),
  },
}))

const RouterLinkStub = defineComponent({
  name: 'RouterLink',
  props: { to: { type: [String, Object], required: false } },
  setup: (props, { slots }) => () => h('a', {
    href: typeof props.to === 'string' ? props.to : undefined,
  }, slots.default?.()),
})

const provider = (workspaceId: string): ProviderConnectionDto => ({
  id: `provider-${workspaceId}`,
  workspace_id: workspaceId,
  provider_kind: 'claude',
  connection_kind: 'local',
  environment_mode: 'inherited',
  config_revision: 1,
})

const role = (id: string, workspaceId: string, overrides: Partial<RoleDto> = {}): RoleDto => ({
  id,
  workspace_id: workspaceId,
  name: `角色 ${id}`,
  description: '',
  system_prompt: 'private prompt',
  required_guidelines: [],
  gates: [],
  output_contract: '',
  blocking_conditions: [],
  selectable: true,
  dispatchable: true,
  version: 1,
  created_at: '2026-10-14T10:00:00.000Z',
  updated_at: '2026-10-14T10:00:00.000Z',
  ...overrides,
})

const binding = (
  id: string,
  workspaceId: string,
  roleId: string,
  overrides: Partial<RoleBindingDto> = {},
): RoleBindingDto => ({
  id,
  workspace_id: workspaceId,
  role_id: roleId,
  provider_connection_id: `provider-${workspaceId}`,
  model_id: `model-${id}`,
  runtime_options: {},
  priority: 0,
  enabled: true,
  version: 1,
  created_at: '2026-10-14T10:00:00.000Z',
  updated_at: '2026-10-14T10:00:00.000Z',
  ...overrides,
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

const mountPage = async (workspaceId: string) => {
  const ProviderPage = (await import('./ProviderPage.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/workspaces/:workspaceId/provider', component: ProviderPage },
      { path: '/sessions/:sessionId', component: ProviderPage },
      { path: '/', component: ProviderPage },
    ],
  })
  await router.push(`/workspaces/${workspaceId}/provider`)
  await router.isReady()
  const wrapper = mount(ProviderPage, {
    global: {
      plugins: [router],
      stubs: { RouterLink: RouterLinkStub, CredentialRefField: true, SessionList: true },
    },
  })
  await flushPromises()
  return { wrapper, router }
}

describe('ProviderPage RoleBinding Session 创建', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    listProviders.mockImplementation(async (workspaceId: string) => [provider(workspaceId)])
    listModels.mockResolvedValue([{
      id: 'catalog-model',
      workspace_id: 'workspace-a',
      provider_connection_id: 'provider-workspace-a',
      provider_kind: 'claude',
      model_id: 'default-model',
      display_name: '默认模型',
      capabilities: {},
      observed_at: '2026-10-14T10:00:00.000Z',
    }])
    listRoles.mockImplementation(async (workspaceId: string) => [role(`role-${workspaceId}`, workspaceId)])
    listBindings.mockImplementation(async (workspaceId: string) => [binding(`binding-${workspaceId}`, workspaceId, `role-${workspaceId}`)])
    listSessions.mockResolvedValue([])
    createSession.mockResolvedValue({ session: { id: 'session-created' }, agentSlot: { id: 'slot-created' } })
  })

  it('默认保留 Provider/model 路径，Binding 模式只提交名称与 Binding ID', async () => {
    const { wrapper, router } = await mountPage('workspace-a')

    expect((wrapper.get('[data-testid="session-creation-mode"]').element as HTMLSelectElement).value).toBe('provider')
    await wrapper.get('[data-testid="start-session"]').trigger('click')
    await flushPromises()
    expect(createSession).toHaveBeenLastCalledWith('workspace-a', {
      name: 'claude 对话',
      provider_connection_id: 'provider-workspace-a',
      model_id: 'default-model',
    })

    await router.push('/workspaces/workspace-a/provider')
    await flushPromises()
    await wrapper.get('[data-testid="session-creation-mode"]').setValue('role-binding')
    await flushPromises()
    await wrapper.get('[data-testid="role-binding-select"]').setValue('binding-workspace-a')
    await wrapper.get('[data-testid="start-role-session"]').trigger('click')
    await flushPromises()

    expect(createSession).toHaveBeenLastCalledWith('workspace-a', {
      name: '角色 role-workspace-a 对话',
      role_binding_id: 'binding-workspace-a',
    })
    expect(createSession.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      role_binding_id: 'binding-workspace-a',
    }))
    expect(Object.keys(createSession.mock.calls.at(-1)?.[1] as object).sort()).toEqual(['name', 'role_binding_id'])
    expect(router.currentRoute.value.fullPath).toBe('/sessions/session-created')
    wrapper.unmount()
  })

  it('只列出当前 Workspace 内符合派发条件且无运行时选项的 Binding', async () => {
    const eligibleRole = role('role-good', 'workspace-a')
    const disabledRole = role('role-disabled', 'workspace-a', { dispatchable: false })
    const unselectableRole = role('role-unselectable', 'workspace-a', { selectable: false })
    listRoles.mockResolvedValue([eligibleRole, disabledRole, unselectableRole])
    listBindings.mockResolvedValue([
      binding('binding-good', 'workspace-a', eligibleRole.id),
      binding('binding-disabled-role', 'workspace-a', disabledRole.id),
      binding('binding-unselectable-role', 'workspace-a', unselectableRole.id),
      binding('binding-disabled', 'workspace-a', eligibleRole.id, { enabled: false }),
      binding('binding-runtime', 'workspace-a', eligibleRole.id, { runtime_options: { temperature: 0.4 } }),
      binding('binding-foreign', 'workspace-b', eligibleRole.id),
    ])
    const { wrapper } = await mountPage('workspace-a')
    await wrapper.get('[data-testid="session-creation-mode"]').setValue('role-binding')
    await flushPromises()
    expect(listRoles).toHaveBeenCalledWith('workspace-a')
    expect(listBindings).toHaveBeenCalledWith('workspace-a')

    const select = wrapper.get('[data-testid="role-binding-select"]')
    expect(select.text()).toContain('角色 role-good')
    expect(select.text()).not.toContain('binding-disabled-role')
    expect(select.text()).not.toContain('binding-unselectable-role')
    expect(select.text()).not.toContain('binding-disabled')
    expect(select.text()).not.toContain('binding-runtime')
    expect(select.text()).not.toContain('binding-foreign')
    wrapper.unmount()
  })

  it('离开 Workspace 路由后不沿用旧 Workspace ID', async () => {
    const { wrapper, router } = await mountPage('workspace-a')

    await router.push('/')
    await flushPromises()
    await wrapper.get('[data-testid="session-creation-mode"]').setValue('role-binding')
    await flushPromises()

    expect(listProviders).toHaveBeenLastCalledWith('')
    expect(listRoles).not.toHaveBeenCalled()
    expect(listBindings).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="role-binding-empty"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('A 已选择 Binding 后切换到 B 立即清空选择并阻止提交', async () => {
    const pendingRolesB = deferred<RoleDto[]>()
    const pendingBindingsB = deferred<RoleBindingDto[]>()
    listRoles.mockImplementation((workspaceId: string) => workspaceId === 'workspace-b'
      ? pendingRolesB.promise
      : Promise.resolve([role('role-a', 'workspace-a')]))
    listBindings.mockImplementation((workspaceId: string) => workspaceId === 'workspace-b'
      ? pendingBindingsB.promise
      : Promise.resolve([binding('binding-a', 'workspace-a', 'role-a')]))
    const { wrapper, router } = await mountPage('workspace-a')
    await wrapper.get('[data-testid="session-creation-mode"]').setValue('role-binding')
    await flushPromises()
    await wrapper.get('[data-testid="role-binding-select"]').setValue('binding-a')

    await router.push('/workspaces/workspace-b/provider')
    await flushPromises()

    expect(wrapper.find('[data-testid="role-binding-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="role-binding-select"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="start-role-session"]').attributes('disabled')).toBeDefined()
    expect(createSession).not.toHaveBeenCalled()

    pendingRolesB.resolve([role('role-b', 'workspace-b')])
    pendingBindingsB.resolve([binding('binding-b', 'workspace-b', 'role-b')])
    await flushPromises()
    expect((wrapper.get('[data-testid="role-binding-select"]').element as HTMLSelectElement).value).toBe('')
    await wrapper.get('[data-testid="role-binding-select"]').setValue('binding-b')
    await wrapper.get('[data-testid="start-role-session"]').trigger('click')
    await flushPromises()

    expect(createSession).toHaveBeenCalledExactlyOnceWith('workspace-b', {
      name: '角色 role-b 对话',
      role_binding_id: 'binding-b',
    })
    wrapper.unmount()
  })

  it('忽略迟到的 Workspace A Role/Binding 响应，不覆盖 B 的选择', async () => {
    const pendingRolesA = deferred<RoleDto[]>()
    const pendingBindingsA = deferred<RoleBindingDto[]>()
    listRoles.mockImplementation((workspaceId: string) => workspaceId === 'workspace-a'
      ? pendingRolesA.promise
      : Promise.resolve([role('role-b', 'workspace-b')]))
    listBindings.mockImplementation((workspaceId: string) => workspaceId === 'workspace-a'
      ? pendingBindingsA.promise
      : Promise.resolve([binding('binding-b', 'workspace-b', 'role-b')]))
    const { wrapper, router } = await mountPage('workspace-a')
    await wrapper.get('[data-testid="session-creation-mode"]').setValue('role-binding')
    await flushPromises()
    expect(listRoles).toHaveBeenCalledWith('workspace-a')
    expect(listBindings).toHaveBeenCalledWith('workspace-a')

    await router.push('/workspaces/workspace-b/provider')
    await flushPromises()
    expect(listRoles).toHaveBeenCalledWith('workspace-b')
    expect(listBindings).toHaveBeenCalledWith('workspace-b')
    await wrapper.get('[data-testid="role-binding-select"]').setValue('binding-b')

    pendingRolesA.resolve([role('role-a', 'workspace-a')])
    pendingBindingsA.resolve([binding('binding-a', 'workspace-a', 'role-a')])
    await flushPromises()

    expect(wrapper.get('[data-testid="role-binding-select"]').text()).toContain('role-b')
    expect((wrapper.get('[data-testid="role-binding-select"]').element as HTMLSelectElement).value).toBe('binding-b')
    expect(createSession).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('候选加载失败仍保留旧 Provider 创建流程并显示可恢复错误', async () => {
    listRoles.mockRejectedValue(new Error('synthetic role list failure'))
    listBindings.mockRejectedValue(new Error('synthetic binding list failure'))
    const { wrapper } = await mountPage('workspace-a')
    await wrapper.get('[data-testid="session-creation-mode"]').setValue('role-binding')
    await flushPromises()

    expect(wrapper.find('[data-testid="role-binding-error"]').exists()).toBe(true)
    await wrapper.get('[data-testid="session-creation-mode"]').setValue('provider')
    await flushPromises()
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="start-session"]').trigger('click')
    await flushPromises()
    expect(createSession).toHaveBeenCalledWith('workspace-a', expect.objectContaining({
      provider_connection_id: 'provider-workspace-a',
      model_id: 'default-model',
    }))
    wrapper.unmount()
  })

  it('候选请求显示加载状态并在无合格 Binding 时显示空态', async () => {
    const pendingRoles = deferred<RoleDto[]>()
    const pendingBindings = deferred<RoleBindingDto[]>()
    listRoles.mockReturnValue(pendingRoles.promise)
    listBindings.mockReturnValue(pendingBindings.promise)
    const { wrapper } = await mountPage('workspace-a')
    await wrapper.get('[data-testid="session-creation-mode"]').setValue('role-binding')

    expect(wrapper.find('[data-testid="role-binding-loading"]').exists()).toBe(true)
    pendingRoles.resolve([])
    pendingBindings.resolve([])
    await flushPromises()

    expect(wrapper.find('[data-testid="role-binding-empty"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="start-role-session"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('Binding 候选加载失败后可重试并显示恢复后的候选', async () => {
    listRoles.mockRejectedValueOnce(new Error('synthetic role list failure'))
      .mockResolvedValue([role('role-retry', 'workspace-a')])
    listBindings.mockRejectedValueOnce(new Error('synthetic binding list failure'))
      .mockResolvedValue([binding('binding-retry', 'workspace-a', 'role-retry')])
    const { wrapper } = await mountPage('workspace-a')
    await wrapper.get('[data-testid="session-creation-mode"]').setValue('role-binding')
    await flushPromises()

    await wrapper.get('[data-testid="retry-role-bindings"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="role-binding-error"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="role-binding-select"]').text()).toContain('role-retry')
    wrapper.unmount()
  })
})
