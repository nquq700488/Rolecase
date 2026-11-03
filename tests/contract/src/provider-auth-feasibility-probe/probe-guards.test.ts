import { describe, expect, it } from 'vitest'

import { summarizeAuthStatusEnvelope } from './auth-summary.js'
import {
  classifyAdapterError,
  classifyAuthenticateFailure,
  classifyElicitation,
  observeAgentCapabilities,
} from './probe-guards.js'

const CANARY = 'CANARY_GUARD_7c1e'

describe('classifyElicitation', () => {
  const valid = { mode: 'url', url: 'https://chatgpt.com/device', elicitationId: 'elicit-001' }

  it('只接受 mode=url、URL 可解析且有 elicitationId 的请求', () => {
    const verdict = classifyElicitation(valid)
    expect(verdict.accepted).toBe(true)
    if (verdict.accepted) {
      expect(verdict.url.host_class).toBe('allowlisted')
      expect(JSON.stringify(verdict)).not.toContain('chatgpt.com/device')
      expect(JSON.stringify(verdict)).not.toContain('elicit-001')
    }
  })

  it('form 模式 fail-closed', () => {
    expect(classifyElicitation({ ...valid, mode: 'form' }))
      .toEqual({ accepted: false, reason: 'not_url_mode' })
    expect(classifyElicitation({ mode: 'openai/form', elicitationId: 'x' }))
      .toEqual({ accepted: false, reason: 'not_url_mode' })
  })

  it('缺 URL 或非字符串 fail-closed', () => {
    expect(classifyElicitation({ mode: 'url', elicitationId: 'x' }))
      .toEqual({ accepted: false, reason: 'missing_url' })
    expect(classifyElicitation({ ...valid, url: '' })).toEqual({ accepted: false, reason: 'missing_url' })
    expect(classifyElicitation({ ...valid, url: 42 })).toEqual({ accepted: false, reason: 'missing_url' })
  })

  it('缺 elicitationId、空 ID 或非字符串 fail-closed', () => {
    const { elicitationId: _ignored, ...withoutId } = valid
    expect(classifyElicitation(withoutId)).toEqual({ accepted: false, reason: 'missing_elicitation_id' })
    expect(classifyElicitation({ ...valid, elicitationId: '' }))
      .toEqual({ accepted: false, reason: 'missing_elicitation_id' })
    expect(classifyElicitation({ ...valid, elicitationId: 42 }))
      .toEqual({ accepted: false, reason: 'missing_elicitation_id' })
    expect(classifyElicitation({ ...valid, elicitationId: null }))
      .toEqual({ accepted: false, reason: 'missing_elicitation_id' })
  })

  it('非法 URL fail-closed 且不回显 canary', () => {
    const verdict = classifyElicitation({ ...valid, url: `not a url ${CANARY}` })
    expect(verdict).toEqual({ accepted: false, reason: 'invalid_url' })
    expect(JSON.stringify(verdict)).not.toContain(CANARY)
  })

  it('畸形 params fail-closed', () => {
    expect(classifyElicitation(null)).toEqual({ accepted: false, reason: 'not_url_mode' })
    expect(classifyElicitation('url')).toEqual({ accepted: false, reason: 'not_url_mode' })
  })
})

describe('summarizeAuthStatusEnvelope', () => {
  it('从包装结构提取 authStatus.kind', () => {
    expect(summarizeAuthStatusEnvelope([{ authStatus: { kind: 'account', account: { email: 'x@y.z' } } }]))
      .toEqual({ observed: true, kinds: ['account'] })
    expect(summarizeAuthStatusEnvelope([{ authStatus: { kind: 'none' } }, { authStatus: { kind: 'gateway' } }]))
      .toEqual({ observed: true, kinds: ['none', 'gateway'] })
  })

  it('账号与 vendor payload 不进入摘要', () => {
    const summary = summarizeAuthStatusEnvelope([
      { authStatus: { kind: 'account', account: { email: `${CANARY}@example.test` }, token: CANARY } },
      { authStatus: { kind: CANARY } },
    ])
    expect(summary.kinds).toEqual(['account', 'other'])
    expect(JSON.stringify(summary)).not.toContain(CANARY)
  })

  it('缺少 authStatus 包装时记为未观察，不回退到扁平 kind', () => {
    expect(summarizeAuthStatusEnvelope([{ kind: 'account' }]))
      .toEqual({ observed: false, kinds: [] })
    expect(summarizeAuthStatusEnvelope([])).toEqual({ observed: false, kinds: [] })
    expect(summarizeAuthStatusEnvelope([null])).toEqual({ observed: false, kinds: [] })
  })
})

describe('observeAgentCapabilities', () => {
  it('读取 agentCapabilities.auth.logout 的显式声明', () => {
    expect(observeAgentCapabilities({ agentCapabilities: { auth: { logout: {} } } }))
      .toEqual({ authDeclared: true, logoutDeclared: true })
  })

  it('缺失、null、非对象都不算声明 logout', () => {
    expect(observeAgentCapabilities({ agentCapabilities: {} }))
      .toEqual({ authDeclared: false, logoutDeclared: false })
    expect(observeAgentCapabilities({ agentCapabilities: { auth: { logout: null } } }))
      .toEqual({ authDeclared: true, logoutDeclared: false })
    expect(observeAgentCapabilities({ agentCapabilities: { auth: { logout: true } } }))
      .toEqual({ authDeclared: true, logoutDeclared: false })
    expect(observeAgentCapabilities({ agentCapabilities: { auth: null } }))
      .toEqual({ authDeclared: false, logoutDeclared: false })
  })

  it('logout 声明为数组不算支持', () => {
    expect(observeAgentCapabilities({ agentCapabilities: { auth: { logout: [] } } }))
      .toEqual({ authDeclared: true, logoutDeclared: false })
  })

  it('不因为 authMethods 数组推断 logout', () => {
    expect(observeAgentCapabilities({ authMethods: [{ id: 'api-key' }], agentCapabilities: {} }).logoutDeclared)
      .toBe(false)
  })

  it('畸形响应不抛错', () => {
    expect(observeAgentCapabilities(null)).toEqual({ authDeclared: false, logoutDeclared: false })
    expect(observeAgentCapabilities({ agentCapabilities: 'x' })).toEqual({ authDeclared: false, logoutDeclared: false })
  })
})

describe('classifyAuthenticateFailure', () => {
  it('真实 Codex request-cancelled（AcpRemoteError code -32800）识别为 cancelled', () => {
    // 锁定 Codex 2.2.2 的 RequestError.requestCancelled 形状。
    const cancelled = Object.assign(new Error('Request cancelled: ChatGPT device code sign-in was cancelled'), {
      name: 'AcpRemoteError',
      code: -32800,
      data: { methodId: 'chat-gpt-device-code', action: 'cancel' },
    })
    expect(classifyAuthenticateFailure(cancelled)).toBe('cancelled')
  })

  it('其他 JSON-RPC 错误码仍归为 remote，不能当作取消', () => {
    for (const code of [-32000, -32603, -32602, -32001]) {
      const remote = Object.assign(new Error('Request cancelled'), { name: 'AcpRemoteError', code })
      expect(classifyAuthenticateFailure(remote)).toBe('remote')
    }
  })

  it('timeout / transport / unknown 分类', () => {
    const timeout = Object.assign(new Error('ACP request timed out: authenticate'), { name: 'AcpRequestTimeoutError' })
    expect(classifyAuthenticateFailure(timeout)).toBe('timeout')

    const closed = Object.assign(new Error('ACP input closed'), { name: 'AcpInputClosedError' })
    expect(classifyAuthenticateFailure(closed)).toBe('transport')

    expect(classifyAuthenticateFailure('nope')).toBe('unknown')
    expect(classifyAuthenticateFailure(null)).toBe('unknown')
  })

  it('不靠 message 关键词把普通错误当成取消', () => {
    for (const error of [
      new Error('user cancelled the flow'),
      new Error('cancelled'),
      Object.assign(new Error('cancelled'), { name: 'AcpRemoteError', code: -32000 }),
    ]) {
      expect(classifyAuthenticateFailure(error)).not.toBe('cancelled')
    }
  })

  it('只有取消类错误可被视为客户端拒绝', () => {
    const nonCancelled = [
      Object.assign(new Error('timed out'), { name: 'AcpRequestTimeoutError' }),
      Object.assign(new Error('ACP input closed'), { name: 'AcpInputClosedError' }),
      Object.assign(new Error('boom'), { name: 'AcpRemoteError', code: -32000 }),
      new Error('unexpected'),
    ]
    for (const error of nonCancelled) {
      expect(classifyAuthenticateFailure(error)).not.toBe('cancelled')
    }
  })
})

describe('classifyAdapterError', () => {
  const CANARY = 'CANARY_ADAPTER_5d2b'

  it('映射为稳定分类且不含原始 message/data', () => {
    const error = Object.assign(new Error(`adapter echo ${CANARY}`), {
      name: 'AcpRemoteError',
      code: -32000,
      data: { url: `https://chatgpt.com/x?token=${CANARY}`, apiKey: CANARY },
    })
    const mapped = classifyAdapterError(error)
    expect(mapped.code).toBe('-32000')
    expect(mapped.message).not.toContain(CANARY)
    expect(JSON.stringify(mapped)).not.toContain(CANARY)
    expect(mapped.stage).toBe('remote')
  })

  it('transport / timeout 分类稳定', () => {
    expect(classifyAdapterError(Object.assign(new Error('ACP input closed'), { name: 'AcpInputClosedError' })).stage)
      .toBe('transport')
    expect(classifyAdapterError(Object.assign(new Error('timed out'), { name: 'AcpRequestTimeoutError' })).stage)
      .toBe('timeout')
    expect(classifyAdapterError(Object.assign(new Error('bad frame'), { name: 'AcpInvalidFrameError' })).stage)
      .toBe('transport')
  })

  it('未知错误不回显 message', () => {
    const mapped = classifyAdapterError(new Error(`weird ${CANARY}`))
    expect(mapped.stage).toBe('unknown')
    expect(mapped.message).not.toContain(CANARY)
  })
})
