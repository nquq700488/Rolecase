// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import type { ProviderConnectionDto, SessionDto } from '@rolecast/contract'

import { ApiClientError } from '@/api/httpClient.js'

const list = vi.fn()
const create = vi.fn()
const testConnection = vi.fn()
const discover = vi.fn()
const models = vi.fn()
const previewConfigImport = vi.fn()
const applyConfigImport = vi.fn()
const updateConnection = vi.fn()
const createSession = vi.fn()
const createCredential = vi.fn()
const listSessions = vi.fn()

vi.mock('@/api/endpoints.js', () => ({
  credentialEndpoints: {
    create: (...args: unknown[]) => createCredential(...args),
  },
  providerEndpoints: {
    list: (...args: unknown[]) => list(...args),
    create: (...args: unknown[]) => create(...args),
    test: (...args: unknown[]) => testConnection(...args),
    discover: (...args: unknown[]) => discover(...args),
    models: (...args: unknown[]) => models(...args),
    previewConfigImport: (...args: unknown[]) => previewConfigImport(...args),
    applyConfigImport: (...args: unknown[]) => applyConfigImport(...args),
    update: (...args: unknown[]) => updateConnection(...args),
  },
  sessionEndpoints: {
    list: (...args: unknown[]) => listSessions(...args),
    create: (...args: unknown[]) => createSession(...args),
  },
}))

/** RouterLink 桩，避免测试依赖真实路由。 */
const RouterLinkStub = defineComponent({
  name: 'RouterLink',
  props: { to: { type: [String, Object], required: false } },
  setup: (props, { slots }) => () => h('a', {
    href: typeof props.to === 'string' ? props.to : undefined,
  }, slots.default?.()),
})

const connection = (overrides: Partial<ProviderConnectionDto>): ProviderConnectionDto => ({
  id: 'provider-001',
  workspace_id: 'workspace-001',
  provider_kind: 'claude',
  connection_kind: 'local',
  environment_mode: 'inherited',
  config_revision: 1,
  ...overrides,
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

/** 动态导入页面，确保 mock 在模块解析前生效。 */
const mountPage = async () => {
  const ProviderPage = (await import('./ProviderPage.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/workspaces/:workspaceId/provider', component: ProviderPage },
      { path: '/sessions/:sessionId', component: ProviderPage },
      { path: '/', component: ProviderPage },
    ],
  })
  await router.push('/workspaces/workspace-001/provider')
  await router.isReady()
  const wrapper = mount(ProviderPage, {
    global: {
      plugins: [router],
      stubs: { RouterLink: RouterLinkStub },
    },
  })
  await flushPromises()
  return wrapper
}

describe('ProviderPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    list.mockResolvedValue([])
    listSessions.mockResolvedValue([])
    models.mockResolvedValue([])
    testConnection.mockResolvedValue({
      provider_kind: 'claude',
      adapter_version: '0.90.0',
      source: 'acp_handshake',
      observed_at: '2026-10-14T10:00:00.000Z',
      capabilities: {},
    })
    discover.mockResolvedValue({
      provider_kind: 'claude',
      adapter_version: '0.90.0',
      source: 'acp_handshake',
      observed_at: '2026-10-14T10:00:00.000Z',
      capabilities: {},
    })
  })

  it('创建 inherited 连接只提交非秘密字段', async () => {
    const wrapper = await mountPage()
    create.mockResolvedValue(connection({}))

    await wrapper.get('#provider-kind').setValue('claude')
    await wrapper.get('#connection-kind').setValue('custom_endpoint')
    await wrapper.get('#environment-mode').setValue('inherited')
    await wrapper.get('#base-url').setValue('https://gateway.example.test/v1')
    await wrapper.get('form').trigger('submit')

    expect(create).toHaveBeenCalledTimes(1)
    const payload = create.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload).toEqual({
      provider_kind: 'claude',
      connection_kind: 'custom_endpoint',
      environment_mode: 'inherited',
      base_url: 'https://gateway.example.test/v1',
    })
    // inherited 组合不渲染 Secret 输入，payload 也不含 Secret 形状的键。
    expect(Object.keys(payload).some((key) => /secret|token|api_?key|password/i.test(key))).toBe(false)
    expect(wrapper.find('input[type="password"]').exists()).toBe(false)
  })

  it('Claude isolated 提交 credential_ref 但不在页面上回显其含义', async () => {
    const wrapper = await mountPage()
    create.mockResolvedValue(connection({
      environment_mode: 'isolated',
      connection_kind: 'api_key',
      credential_ref: 'credential-001',
    }))

    await wrapper.get('#environment-mode').setValue('isolated')
    await wrapper.get('#connection-kind').setValue('api_key')
    await wrapper.get('#credential-ref').setValue('credential-001')
    await wrapper.get('form').trigger('submit')

    expect(create.mock.calls[0]?.[1]).toEqual({
      provider_kind: 'claude',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
    })
    // 提交后输入被清空，避免长期保留在表单状态里。
    expect((wrapper.get('#credential-ref').element as HTMLInputElement).value).toBe('')
    expect(wrapper.text()).toContain('引用已设置')
  })

  it('创建前可通过 API key 生成引用，提交时不携带 Secret', async () => {
    const wrapper = await mountPage()
    createCredential.mockResolvedValue({ credential_ref: 'credential-new' })
    create.mockResolvedValue(connection({
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-new',
    }))

    await wrapper.get('#environment-mode').setValue('isolated')
    await wrapper.get('#connection-kind').setValue('api_key')
    await wrapper.get('#credential-ref-secret').setValue('sk-synthetic')
    await wrapper.get('[data-testid="credential-ref-create"]').trigger('click')
    await flushPromises()
    await wrapper.get('form').trigger('submit')

    expect(createCredential).toHaveBeenCalledTimes(1)
    expect(createCredential.mock.calls[0]?.[0]).toMatchObject({ secret: 'sk-synthetic' })
    const payload = create.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload.credential_ref).toBe('credential-new')
    expect(Object.keys(payload).some((key) => /secret|token|api_?key|password/i.test(key))).toBe(false)
  })

  it('编辑连接前可通过 API key 生成引用', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-claude',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-old',
    })])
    createCredential.mockResolvedValue({ credential_ref: 'credential-new' })
    updateConnection.mockResolvedValue(connection({
      id: 'provider-claude',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-new',
      config_revision: 2,
    }))
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="edit-connection"]').trigger('click')
    await wrapper.get('#edit-credential-ref-secret').setValue('sk-synthetic')
    await wrapper.get('[data-testid="edit-credential-ref-create"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="save-connection"]').trigger('click')
    await flushPromises()

    expect(createCredential.mock.calls[0]?.[0]).toMatchObject({ secret: 'sk-synthetic' })
    expect(updateConnection.mock.calls[0]?.[1]).toMatchObject({ credential_ref: 'credential-new' })
    expect(updateConnection.mock.calls[0]?.[1]).not.toHaveProperty('secret')
  })

  it('Codex 导入应用前可通过 API key 生成引用', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'inherited',
    })])
    previewConfigImport.mockResolvedValue({
      preview_id: 'preview-001',
      target_provider_connection_id: 'provider-codex',
      workspace_id: 'workspace-001',
      source_path: '/tmp/codex/config.toml',
      source_name: 'config.toml',
      source_digest: 'a'.repeat(64),
      target_config_revision: 1,
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
      models: [{ model_id: 'gpt-test', display_name: 'gpt-test' }],
      warnings: [],
    })
    createCredential.mockResolvedValue({ credential_ref: 'credential-new' })
    applyConfigImport.mockResolvedValue(connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-new',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
    }))
    const wrapper = await mountPage()

    await wrapper.get('#config-source-path').setValue('/tmp/codex/config.toml')
    await wrapper.get('[data-testid="preview-import"]').trigger('click')
    await flushPromises()
    await wrapper.get('#import-credential-ref-secret').setValue('sk-synthetic')
    await wrapper.get('[data-testid="import-credential-ref-create"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="apply-import"]').trigger('click')
    await flushPromises()

    expect(createCredential.mock.calls[0]?.[0]).toMatchObject({ secret: 'sk-synthetic' })
    expect(applyConfigImport).toHaveBeenCalledWith('provider-codex', {
      preview_id: 'preview-001',
      confirmed: true,
      target_config_revision: 1,
      credential_ref: 'credential-new',
    })
  })

  it('提交中禁用按钮并显示 loading 文案', async () => {
    const wrapper = await mountPage()
    const resolvers: Array<(value: ProviderConnectionDto) => void> = []
    create.mockImplementation(() => new Promise<ProviderConnectionDto>((resolve) => {
      resolvers.push(resolve)
    }))

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const submit = wrapper.get('button[type="submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
    expect(submit.text()).toContain('保存中')

    for (const resolve of resolvers) {
      resolve(connection({}))
    }
    await flushPromises()
  })

  it('credential 错误按 ApiClientError.code 显示且保留表单选择', async () => {
    const wrapper = await mountPage()
    create.mockRejectedValue(new ApiClientError('凭据引用不存在', 'credential_not_found', 404, null))

    await wrapper.get('#environment-mode').setValue('isolated')
    await wrapper.get('#connection-kind').setValue('api_key')
    await wrapper.get('#credential-ref').setValue('credential-missing')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('凭据引用不存在')
    // 失败不清空选择，也不静默切回 inherited。
    expect((wrapper.get('#environment-mode').element as HTMLSelectElement).value).toBe('isolated')
    expect((wrapper.get('#connection-kind').element as HTMLSelectElement).value).toBe('api_key')
  })

  it('needs_configuration 状态禁用测试与 Session 启动', async () => {
    list.mockResolvedValue([connection({ environment_mode: 'isolated' })])
    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('待配置')
    expect(wrapper.get('[data-testid="test-connection"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeDefined()
    expect(testConnection).not.toHaveBeenCalled()
  })

  it('Codex custom endpoint 显示认证未验证并禁止运行操作', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'custom_endpoint',
      base_url: 'https://gateway.example.test/v1',
      environment_mode: 'inherited',
    })])
    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('认证未验证')
    expect(wrapper.get('[data-testid="test-connection"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeDefined()
    // 未验证的连接不能被静默当作可运行。
    expect(testConnection).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
  })

  it('Codex 配置导入先预览再确认应用，提交非秘密字段', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
    })])
    previewConfigImport.mockResolvedValue({
      preview_id: 'preview-001',
      provider_id: 'provider-codex',
      workspace_id: 'workspace-001',
      source_name: 'config.toml',
      source_digest: 'a'.repeat(64),
      target_config_revision: 1,
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
      models: [{ model_id: 'gpt-test', display_name: 'gpt-test' }],
      warnings: [],
    })
    applyConfigImport.mockResolvedValue(connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
    }))
    const wrapper = await mountPage()

    await wrapper.get('#config-source-path').setValue('/tmp/codex/config.toml')
    await wrapper.get('[data-testid="preview-import"]').trigger('click')
    await flushPromises()

    expect(previewConfigImport).toHaveBeenCalledWith('provider-codex', { source_path: '/tmp/codex/config.toml' })
    expect(wrapper.text()).toContain('gpt-test')

    await wrapper.get('#import-credential-ref').setValue('credential-001')
    await wrapper.get('[data-testid="apply-import"]').trigger('click')
    await flushPromises()

    expect(applyConfigImport).toHaveBeenCalledWith('provider-codex', {
      preview_id: 'preview-001',
      confirmed: true,
      target_config_revision: 1,
      credential_ref: 'credential-001',
    })
  })

  it('inherited Codex 连接展示配置导入入口（既定流程起点）', async () => {
    for (const kind of ['api_key', 'local'] as const) {
      list.mockResolvedValue([connection({
        id: 'provider-codex',
        provider_kind: 'codex',
        connection_kind: kind,
        environment_mode: 'inherited',
      })])
      vi.resetModules()
      const wrapper = await mountPage()

      expect(wrapper.find('#config-source-path').exists()).toBe(true)
      expect(wrapper.find('[data-testid="preview-import"]').exists()).toBe(true)
      wrapper.unmount()
    }
  })

  it('Claude 与 inherited Codex 的差异：Claude 不显示配置导入入口', async () => {
    list.mockResolvedValue([connection({ provider_kind: 'claude' })])
    const wrapper = await mountPage()

    expect(wrapper.find('#config-source-path').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preview-import"]').exists()).toBe(false)
  })

  it('Codex isolated 待导入时仍保留配置导入入口（恢复路径）', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
    })])
    const wrapper = await mountPage()

    expect(wrapper.find('#config-source-path').exists()).toBe(true)
    expect(wrapper.text()).toContain('待导入')
  })

  it('apply 后变为待配置时导入入口仍可用，不隐藏恢复路径', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'inherited',
    })])
    previewConfigImport.mockResolvedValue({
      preview_id: 'preview-001',
      provider_id: 'provider-codex',
      workspace_id: 'workspace-001',
      source_name: 'config.toml',
      source_digest: 'a'.repeat(64),
      target_config_revision: 1,
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
      models: [{ model_id: 'gpt-test', display_name: 'gpt-test' }],
      warnings: [],
    })
    // apply 后仍缺凭据引用 → 待配置，而不是 ready。
    applyConfigImport.mockResolvedValue(connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
    }))
    const wrapper = await mountPage()

    await wrapper.get('#config-source-path').setValue('/tmp/codex/config.toml')
    await wrapper.get('[data-testid="preview-import"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="apply-import"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('待导入')
    expect(wrapper.find('#config-source-path').exists()).toBe(true)
  })

  it('Codex custom endpoint 不显示可操作的导入入口，且禁止测试与 Session', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'custom_endpoint',
      base_url: 'https://gateway.example.test/v1',
      environment_mode: 'inherited',
    })])
    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('认证未验证')
    expect(wrapper.find('[data-testid="preview-import"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="test-connection"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeDefined()
  })

  it('切换 Provider 时重置模型目录，旧模型不会被提交到新连接', async () => {
    const claude = connection({ id: 'provider-claude', provider_kind: 'claude' })
    const codex = connection({ id: 'provider-codex', provider_kind: 'codex', connection_kind: 'api_key' })
    list.mockResolvedValue([claude, codex])
    models.mockImplementation((providerId: string) => Promise.resolve(providerId === 'provider-claude'
      ? [{
          id: 'model-a',
          workspace_id: 'workspace-001',
          provider_connection_id: 'provider-claude',
          provider_kind: 'claude',
          model_id: 'claude-model',
          display_name: 'Claude Model',
          capabilities: {},
          observed_at: '2026-10-14T10:00:00.000Z',
        }]
      : []))
    const wrapper = await mountPage()

    // 第一个 Provider 已有可用模型。
    expect((wrapper.get('[aria-label="选择模型"]').element as HTMLSelectElement).value).toBe('claude-model')

    // 切换到模型目录为空的另一个 Provider。
    await wrapper.findAll('.workspace-item')[1]?.trigger('click')
    await flushPromises()

    // 旧模型必须被清空，不能继续满足 canStart。
    expect((wrapper.get('[aria-label="模型 ID"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeDefined()
  })

  it('切换 Provider 时忽略迟到的旧模型响应', async () => {
    const claude = connection({ id: 'provider-claude', provider_kind: 'claude' })
    const codex = connection({ id: 'provider-codex', provider_kind: 'codex', connection_kind: 'api_key' })
    list.mockResolvedValue([claude, codex])
    const pending: Array<() => void> = []
    models.mockImplementation((providerId: string) => new Promise((resolve) => {
      pending.push(() => resolve(providerId === 'provider-claude'
        ? [{
            id: 'model-a',
            workspace_id: 'workspace-001',
            provider_connection_id: 'provider-claude',
            provider_kind: 'claude',
            model_id: 'claude-model',
            display_name: 'Claude Model',
            capabilities: {},
            observed_at: '2026-10-14T10:00:00.000Z',
          }]
        : []))
    }))
    const wrapper = await mountPage()

    // 切换到第二个 Provider，再让第一个 Provider 的响应后到。
    await wrapper.findAll('.workspace-item')[1]?.trigger('click')
    await flushPromises()
    pending.reverse().forEach((resolve) => resolve())
    await flushPromises()

    // 迟到的旧响应不能覆盖当前 Provider 的空目录。
    expect(wrapper.find('[aria-label="选择模型"]').exists()).toBe(false)
    expect((wrapper.get('[aria-label="模型 ID"]').element as HTMLInputElement).value).toBe('')
  })

  it('模型加载失败时清空旧模型并显示可观察错误', async () => {
    const claude = connection({ id: 'provider-claude', provider_kind: 'claude' })
    const codex = connection({ id: 'provider-codex', provider_kind: 'codex', connection_kind: 'api_key' })
    list.mockResolvedValue([claude, codex])
    models.mockImplementation((providerId: string) => (providerId === 'provider-claude'
      ? Promise.resolve([{
          id: 'model-a',
          workspace_id: 'workspace-001',
          provider_connection_id: 'provider-claude',
          provider_kind: 'claude',
          model_id: 'claude-model',
          display_name: 'Claude Model',
          capabilities: {},
          observed_at: '2026-10-14T10:00:00.000Z',
        }])
      : Promise.reject(new ApiClientError('模型目录加载失败', 'internal_error', 500, null))))
    const wrapper = await mountPage()

    await wrapper.findAll('.workspace-item')[1]?.trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('模型目录加载失败')
    expect(wrapper.find('[aria-label="选择模型"]').exists()).toBe(false)
  })

  it('切换连接类型后不提交隐藏的 base_url', async () => {
    const wrapper = await mountPage()
    create.mockResolvedValue(connection({}))

    await wrapper.get('#connection-kind').setValue('custom_endpoint')
    await wrapper.get('#base-url').setValue('https://gateway.example.test/v1')
    await wrapper.get('#connection-kind').setValue('api_key')
    await wrapper.get('form').trigger('submit')

    const payload = create.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload.base_url).toBeUndefined()
  })

  it('切换连接后引用状态来自当前连接，不沿用上一条', async () => {
    const withRef = connection({
      id: 'provider-with-ref',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
    })
    const withoutRef = connection({ id: 'provider-without-ref' })
    list.mockResolvedValue([withRef, withoutRef])
    const wrapper = await mountPage()

    // 当前连接有引用：状态轨显示。
    const rail = () => wrapper.get('.status-rail').text()
    expect(rail()).toContain('引用已设置')

    await wrapper.findAll('.workspace-item')[1]?.trigger('click')
    await flushPromises()

    // 当前连接没有引用：状态轨不再沿用上一条的状态。
    expect(rail()).not.toContain('引用已设置')
  })

  it('更新连接成功后失效模型目录、选中模型与在途请求', async () => {
    const connectionDto = connection({
      id: 'provider-claude',
      connection_kind: 'local',
      environment_mode: 'inherited',
    })
    list.mockResolvedValue([connectionDto])
    // 首次 models 挂起，模拟更新之后才返回的旧响应。
    const pending: Array<() => void> = []
    models.mockImplementation(() => new Promise((resolve) => {
      pending.push(() => resolve([{
        id: 'model-old',
        workspace_id: 'workspace-001',
        provider_connection_id: 'provider-claude',
        provider_kind: 'claude',
        model_id: 'old-model',
        display_name: 'Old Model',
        capabilities: {},
        observed_at: '2026-10-14T10:00:00.000Z',
      }]))
    }))
    updateConnection.mockResolvedValue(connection({
      id: 'provider-claude',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      config_revision: 2,
    }))
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="edit-connection"]').trigger('click')
    await wrapper.get('#edit-connection-kind').setValue('api_key')
    await wrapper.get('#edit-environment-mode').setValue('isolated')
    await wrapper.get('#edit-credential-ref').setValue('credential-001')
    await wrapper.get('[data-testid="save-connection"]').trigger('click')
    await flushPromises()

    expect(updateConnection).toHaveBeenCalledWith('provider-claude', {
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      base_url: null,
      config_revision: 1,
    })
    // 更新后旧请求返回也不能复活目录。
    pending.forEach((resolve) => resolve())
    await flushPromises()
    expect(wrapper.find('[aria-label="选择模型"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeDefined()
  })

  it('custom_endpoint 切换为 api_key 时显式发送 base_url:null', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-claude',
      connection_kind: 'custom_endpoint',
      base_url: 'https://gateway.example.test/v1',
      environment_mode: 'inherited',
    })])
    updateConnection.mockResolvedValue(connection({ id: 'provider-claude', connection_kind: 'api_key' }))
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="edit-connection"]').trigger('click')
    await wrapper.get('#edit-connection-kind').setValue('api_key')
    await wrapper.get('[data-testid="save-connection"]').trigger('click')
    await flushPromises()

    expect(updateConnection).toHaveBeenCalledTimes(1)
    const payload = updateConnection.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload.base_url).toBeNull()
  })

  it('isolated api_key 切换为 inherited local 时显式清除 credential_ref', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-claude',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
    })])
    updateConnection.mockResolvedValue(connection({ id: 'provider-claude' }))
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="edit-connection"]').trigger('click')
    await wrapper.get('#edit-connection-kind').setValue('local')
    await wrapper.get('#edit-environment-mode').setValue('inherited')
    await wrapper.get('[data-testid="save-connection"]').trigger('click')
    await flushPromises()

    const payload = updateConnection.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload.credential_ref).toBeNull()
    expect(payload.base_url).toBeNull()
  })

  it('Claude 遗留 codex_config 时编辑保存显式清除它', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-legacy',
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'inherited',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
    })])
    updateConnection.mockResolvedValue(connection({ id: 'provider-legacy' }))
    const wrapper = await mountPage()

    // 遗留组合不能显示为可运行。
    expect(wrapper.text()).toContain('配置不合法')

    await wrapper.get('[data-testid="edit-connection"]').trigger('click')
    await wrapper.get('[data-testid="save-connection"]').trigger('click')
    await flushPromises()

    const payload = updateConnection.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload.codex_config).toBeNull()
  })

  it('已有 isolated api_key 留空引用、只改 base_url 时省略 credential_ref', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-claude',
      provider_kind: 'claude',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
    })])
    updateConnection.mockResolvedValue(connection({
      id: 'provider-claude',
      connection_kind: 'custom_endpoint',
      environment_mode: 'isolated',
      base_url: 'https://gateway.example.test/v1',
      credential_ref: 'credential-001',
    }))
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="edit-connection"]').trigger('click')
    await wrapper.get('#edit-connection-kind').setValue('custom_endpoint')
    await wrapper.get('#edit-base-url').setValue('https://gateway.example.test/v1')
    // 引用输入保持空白：必须保留已有引用，而不是清空。
    await wrapper.get('[data-testid="save-connection"]').trigger('click')
    await flushPromises()

    const payload = updateConnection.mock.calls[0]?.[1] as Record<string, unknown>
    expect(Object.hasOwn(payload, 'credential_ref')).toBe(false)
    expect(payload.base_url).toBe('https://gateway.example.test/v1')
  })

  it('已有 isolated custom_endpoint 留空引用并修改 URL 时省略 credential_ref', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-claude',
      provider_kind: 'claude',
      connection_kind: 'custom_endpoint',
      environment_mode: 'isolated',
      base_url: 'https://old.example.test/v1',
      credential_ref: 'credential-001',
    })])
    updateConnection.mockResolvedValue(connection({
      id: 'provider-claude',
      connection_kind: 'custom_endpoint',
      environment_mode: 'isolated',
      base_url: 'https://new.example.test/v1',
      credential_ref: 'credential-001',
    }))
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="edit-connection"]').trigger('click')
    await wrapper.get('#edit-base-url').setValue('https://new.example.test/v1')
    await wrapper.get('[data-testid="save-connection"]').trigger('click')
    await flushPromises()

    const payload = updateConnection.mock.calls[0]?.[1] as Record<string, unknown>
    expect(Object.hasOwn(payload, 'credential_ref')).toBe(false)
    expect(payload.base_url).toBe('https://new.example.test/v1')
  })

  it('已有 isolated 连接输入新引用时提交新值', async () => {
    list.mockResolvedValue([connection({
      id: 'provider-claude',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
    })])
    updateConnection.mockResolvedValue(connection({
      id: 'provider-claude',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-002',
    }))
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="edit-connection"]').trigger('click')
    await wrapper.get('#edit-credential-ref').setValue('credential-002')
    await wrapper.get('[data-testid="save-connection"]').trigger('click')
    await flushPromises()

    const payload = updateConnection.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload.credential_ref).toBe('credential-002')
  })

  it('更新失败显示可恢复错误且保留表单选择', async () => {
    list.mockResolvedValue([connection({ id: 'provider-claude' })])
    updateConnection.mockRejectedValue(new ApiClientError('凭据引用不存在', 'credential_not_found', 404, null))
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="edit-connection"]').trigger('click')
    await wrapper.get('#edit-connection-kind').setValue('api_key')
    await wrapper.get('#edit-environment-mode').setValue('isolated')
    await wrapper.get('#edit-credential-ref').setValue('missing-ref')
    await wrapper.get('[data-testid="save-connection"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('凭据引用不存在')
    expect((wrapper.get('#edit-credential-ref').element as HTMLInputElement).value).toBe('missing-ref')
    expect((wrapper.get('#edit-connection-kind').element as HTMLSelectElement).value).toBe('api_key')
  })

  it('apply 成功后清空旧模型目录与选中模型，不能直接用旧模型开 Session', async () => {
    const inherited = connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'inherited',
    })
    list.mockResolvedValue([inherited])
    models.mockResolvedValue([{
      id: 'model-old',
      workspace_id: 'workspace-001',
      provider_connection_id: 'provider-codex',
      provider_kind: 'codex',
      model_id: 'old-model',
      display_name: 'Old Model',
      capabilities: {},
      observed_at: '2026-10-14T10:00:00.000Z',
    }])
    previewConfigImport.mockResolvedValue({
      preview_id: 'preview-001',
      provider_id: 'provider-codex',
      workspace_id: 'workspace-001',
      source_name: 'config.toml',
      source_digest: 'a'.repeat(64),
      target_config_revision: 1,
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
      models: [{ model_id: 'gpt-test', display_name: 'gpt-test' }],
      warnings: [],
    })
    // 导入后仍可运行（有引用 + 可物化配置），但模型目录必须重新发现。
    applyConfigImport.mockResolvedValue(connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
    }))
    const wrapper = await mountPage()

    // 导入前：旧模型已就绪且可开 Session。
    await wrapper.get('[data-testid="test-connection"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[aria-label="选择模型"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('#config-source-path').setValue('/tmp/codex/config.toml')
    await wrapper.get('[data-testid="preview-import"]').trigger('click')
    await flushPromises()
    await wrapper.get('#import-credential-ref').setValue('credential-001')
    await wrapper.get('[data-testid="apply-import"]').trigger('click')
    await flushPromises()

    // 导入后：旧目录与选择被清空，必须重新发现模型。
    expect(wrapper.find('[aria-label="选择模型"]').exists()).toBe(false)
    expect((wrapper.get('[aria-label="模型 ID"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeDefined()
    // 引用状态与其他状态保持正常。
    expect(wrapper.text()).toContain('引用已设置')
    expect(wrapper.text()).toContain('Codex 配置已应用')
    // 没有自动用旧模型创建 Session。
    expect(createSession).not.toHaveBeenCalled()
  })

  it('apply 前发起的模型请求在 apply 后返回时被丢弃', async () => {
    const inherited = connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'inherited',
    })
    list.mockResolvedValue([inherited])
    // 首次 models 请求挂起，模拟 apply 之后才返回的旧响应。
    const pending: Array<() => void> = []
    models.mockImplementation(() => new Promise((resolve) => {
      pending.push(() => resolve([{
        id: 'model-old',
        workspace_id: 'workspace-001',
        provider_connection_id: 'provider-codex',
        provider_kind: 'codex',
        model_id: 'old-model',
        display_name: 'Old Model',
        capabilities: {},
        observed_at: '2026-10-14T10:00:00.000Z',
      }]))
    }))
    previewConfigImport.mockResolvedValue({
      preview_id: 'preview-001',
      provider_id: 'provider-codex',
      workspace_id: 'workspace-001',
      source_name: 'config.toml',
      source_digest: 'a'.repeat(64),
      target_config_revision: 1,
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
      models: [{ model_id: 'gpt-test', display_name: 'gpt-test' }],
      warnings: [],
    })
    applyConfigImport.mockResolvedValue(connection({
      id: 'provider-codex',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
    }))
    const wrapper = await mountPage()

    // 连接 id 从头到尾不变；旧请求在 apply 之前发出、之后才返回。
    await wrapper.get('[data-testid="test-connection"]').trigger('click')
    await flushPromises()
    expect(pending.length).toBeGreaterThan(0)

    await wrapper.get('#config-source-path').setValue('/tmp/codex/config.toml')
    await wrapper.get('[data-testid="preview-import"]').trigger('click')
    await flushPromises()
    await wrapper.get('#import-credential-ref').setValue('credential-001')
    await wrapper.get('[data-testid="apply-import"]').trigger('click')
    await flushPromises()

    // apply 之后旧请求才返回：不能让旧目录恢复。
    pending.forEach((resolve) => resolve())
    await flushPromises()

    expect(wrapper.find('[aria-label="选择模型"]').exists()).toBe(false)
    expect((wrapper.get('[aria-label="模型 ID"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeDefined()
    expect(createSession).not.toHaveBeenCalled()
  })

  it('成功握手后展示 ready 并允许开启 Session', async () => {
    list.mockResolvedValue([connection({ connection_kind: 'api_key', environment_mode: 'isolated', credential_ref: 'credential-001' })])
    models.mockResolvedValue([{
      id: 'model-001',
      workspace_id: 'workspace-001',
      provider_connection_id: 'provider-001',
      provider_kind: 'claude',
      model_id: 'model-a',
      display_name: 'Model A',
      capabilities: {},
      observed_at: '2026-10-14T10:00:00.000Z',
    }])
    createSession.mockResolvedValue({ session: { id: 'session-001' }, agentSlot: { id: 'slot-001' } })
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="test-connection"]').trigger('click')
    await flushPromises()

    expect(testConnection).toHaveBeenCalledWith('provider-001')
    expect(wrapper.text()).toContain('可运行')
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeUndefined()
  })

  it('在 Provider 页面列出当前 Workspace 的 Session 并链接到 Room', async () => {
    list.mockResolvedValue([connection({
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
    })])
    listSessions.mockResolvedValue([{
      id: 'session-existing',
      workspace_id: 'workspace-001',
      name: '已有 Session',
      status: 'completed',
      created_at: '2026-10-25T12:00:00.000Z',
      updated_at: '2026-10-26T12:00:00.000Z',
    }])
    const wrapper = await mountPage()

    expect(listSessions).toHaveBeenCalledWith('workspace-001')
    expect(wrapper.find('a[href="/sessions/session-existing"]').exists()).toBe(true)
  })

  it('同一 ProviderPage 实例切换 Workspace 后只显示新 Workspace 的 Session', async () => {
    const pendingA = deferred<SessionDto[]>()
    list.mockResolvedValue([])
    listSessions.mockImplementation((workspaceId: string) => (workspaceId === 'workspace-a'
      ? pendingA.promise
      : Promise.resolve([{
          id: 'session-b',
          workspace_id: 'workspace-b',
          name: 'B 的 Session',
          status: 'active',
          created_at: '2026-10-25T12:00:00.000Z',
          updated_at: '2026-10-26T12:00:00.000Z',
        }])))

    const ProviderPage = (await import('./ProviderPage.vue')).default
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/workspaces/:workspaceId/provider', component: ProviderPage }],
    })
    await router.push('/workspaces/workspace-a/provider')
    await router.isReady()
    const wrapper = mount(ProviderPage, {
      global: { plugins: [router], stubs: { RouterLink: RouterLinkStub } },
    })
    const pageInstance = wrapper.vm
    await flushPromises()

    expect(listSessions).toHaveBeenCalledExactlyOnceWith('workspace-a')
    await router.push('/workspaces/workspace-b/provider')
    await flushPromises()

    expect(wrapper.vm).toBe(pageInstance)
    expect(listSessions.mock.calls.map(([workspaceId]) => workspaceId)).toEqual(['workspace-a', 'workspace-b'])
    expect(wrapper.text()).toContain('B 的 Session')
    expect(wrapper.text()).not.toContain('A 的 Session')

    pendingA.resolve([{
      id: 'session-a',
      workspace_id: 'workspace-a',
      name: 'A 的迟到 Session',
      status: 'active',
      created_at: '2026-10-25T12:00:00.000Z',
      updated_at: '2026-10-26T12:00:00.000Z',
    }])
    await flushPromises()

    expect(wrapper.text()).toContain('B 的 Session')
    expect(wrapper.text()).not.toContain('A 的迟到 Session')
    expect(createSession).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
