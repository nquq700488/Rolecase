// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiClientError } from '@/api/httpClient.js'

const create = vi.fn()

vi.mock('@/api/endpoints.js', () => ({
  credentialEndpoints: {
    create: (...args: unknown[]) => create(...args),
  },
}))

const PENDING_KEY = 'rolecast.credential.pending:create'

let uuidSequence = 0

const mountField = async (operationScope = 'create', inputId = 'credential-ref') => {
  const CredentialRefField = (await import('./CredentialRefField.vue')).default
  return mount(CredentialRefField, {
    props: { credentialRef: '', operationScope, inputId },
  })
}

const submit = async (
  wrapper: Awaited<ReturnType<typeof mountField>>,
  testId = 'credential-ref-create',
): Promise<void> => {
  await wrapper.get(`[data-testid="${testId}"]`).trigger('click')
  await flushPromises()
}

describe('CredentialRefField', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    uuidSequence = 0
    vi.stubGlobal('crypto', {
      randomUUID: () => {
        uuidSequence += 1
        return `uuid-${uuidSequence}`
      },
    })
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('提交只发送幂等键与 Secret，成功后清空 Secret 并回填引用', async () => {
    create.mockResolvedValue({ credential_ref: 'credential-001' })
    const wrapper = await mountField()

    await wrapper.get('#credential-ref-secret').setValue('sk-synthetic')
    await submit(wrapper)

    expect(create).toHaveBeenCalledWith({ idempotency_key: 'uuid-1', secret: 'sk-synthetic' })
    expect(wrapper.emitted('update:credentialRef')?.at(-1)).toEqual(['credential-001'])
    expect((wrapper.get('#credential-ref-secret').element as HTMLInputElement).value).toBe('')
    expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull()
    expect(wrapper.text()).toContain('引用已创建')
  })

  it('失败保留 Secret 与同一幂等键，错误不显示 Secret', async () => {
    create.mockRejectedValueOnce(new ApiClientError('凭据存储不可用', 'credentials_unavailable', 503, null))
    const wrapper = await mountField()

    await wrapper.get('#credential-ref-secret').setValue('sk-synthetic')
    await submit(wrapper)

    expect(window.sessionStorage.getItem(PENDING_KEY)).toBe('uuid-1')
    expect((wrapper.get('#credential-ref-secret').element as HTMLInputElement).value).toBe('sk-synthetic')
    expect(wrapper.text()).toContain('系统凭据存储暂时不可用')
    expect(wrapper.text()).not.toContain('sk-synthetic')

    create.mockResolvedValueOnce({ credential_ref: 'credential-001' })
    await submit(wrapper)
    expect(create).toHaveBeenLastCalledWith({ idempotency_key: 'uuid-1', secret: 'sk-synthetic' })
  })

  it('修改 Secret 后重试仍复用同一幂等键', async () => {
    create.mockRejectedValueOnce(new ApiClientError('凭据存储不可用', 'credentials_unavailable', 503, null))
    const wrapper = await mountField()

    await wrapper.get('#credential-ref-secret').setValue('sk-first')
    await submit(wrapper)
    await wrapper.get('#credential-ref-secret').setValue('sk-second')
    create.mockResolvedValueOnce({ credential_ref: 'credential-001' })
    await submit(wrapper)

    expect(create).toHaveBeenLastCalledWith({ idempotency_key: 'uuid-1', secret: 'sk-second' })
  })

  it('同一幂等键遇到不同 Secret 时显示冲突提示且不覆盖', async () => {
    create.mockRejectedValueOnce(new ApiClientError(
      '同一幂等键已保存过不同的凭据',
      'credential_idempotency_conflict',
      409,
      null,
    ))
    const wrapper = await mountField()

    await wrapper.get('#credential-ref-secret').setValue('sk-second')
    await submit(wrapper)

    expect(wrapper.text()).toContain('已用不同的 API key 创建过')
    expect(wrapper.emitted('update:credentialRef')).toBeUndefined()
  })

  it('冲突时可用服务端回传的既有引用结束待确认操作', async () => {
    create.mockRejectedValueOnce(new ApiClientError(
      '同一幂等键已保存过不同的凭据',
      'credential_idempotency_conflict',
      409,
      null,
      { credential_ref: 'credential-existing' },
    ))
    const wrapper = await mountField()

    await wrapper.get('#credential-ref-secret').setValue('sk-second')
    await submit(wrapper)

    expect(wrapper.text()).toContain('当前没有轮换入口')
    await wrapper.get('[data-testid="credential-ref-use-existing"]').trigger('click')

    expect(wrapper.emitted('update:credentialRef')?.at(-1)).toEqual(['credential-existing'])
    expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull()
    expect((wrapper.get('#credential-ref-secret').element as HTMLInputElement).value).toBe('')
  })

  it('重新挂载时从 sessionStorage 恢复待确认幂等键', async () => {
    window.sessionStorage.setItem(PENDING_KEY, 'uuid-restored')
    const wrapper = await mountField()

    expect(wrapper.text()).toContain('上次创建结果未确认')

    create.mockResolvedValue({ credential_ref: 'credential-001' })
    await wrapper.get('#credential-ref-secret').setValue('sk-synthetic')
    await submit(wrapper)

    expect(create).toHaveBeenCalledWith({ idempotency_key: 'uuid-restored', secret: 'sk-synthetic' })
    expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull()
  })

  it('显式清除会删除待确认幂等键并清空 Secret', async () => {
    window.sessionStorage.setItem(PENDING_KEY, 'uuid-restored')
    const wrapper = await mountField()
    await wrapper.get('#credential-ref-secret').setValue('sk-synthetic')

    await wrapper.get('[data-testid="credential-ref-clear"]').trigger('click')

    expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull()
    expect((wrapper.get('#credential-ref-secret').element as HTMLInputElement).value).toBe('')
    expect(wrapper.text()).not.toContain('上次创建结果未确认')
  })

  it('禁用时不能提交', async () => {
    const CredentialRefField = (await import('./CredentialRefField.vue')).default
    const wrapper = mount(CredentialRefField, {
      props: { credentialRef: '', operationScope: 'create', inputId: 'credential-ref', disabled: true },
    })
    await wrapper.get('#credential-ref-secret').setValue('sk-synthetic')
    await submit(wrapper)

    expect(create).not.toHaveBeenCalled()
  })
})
