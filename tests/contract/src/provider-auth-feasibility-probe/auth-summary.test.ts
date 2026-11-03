import { describe, expect, it } from 'vitest'

import {
  summarizeAuthMethod,
  summarizeAuthMethods,
  summarizeAuthStatus,
  summarizeUrl,
} from './auth-summary.js'

const CANARY = 'CANARY_DO_NOT_LEAK_9f3a'

/** canary 命中数；用于断言任何原始值都没有进入摘要。 */
const occurrences = (value: unknown): number => JSON.stringify(value).split(CANARY).length - 1

describe('summarizeAuthMethod', () => {
  it('只保留白名单字段', () => {
    const summary = summarizeAuthMethod({
      id: 'chat-gpt-device-code',
      type: 'url',
      args: { a: 1, b: 2 },
      env: { X: 'y' },
      name: 'Device code',
      description: 'Sign in',
      _meta: { nested: true },
    })

    expect(summary).toEqual({
      method_id: 'chat-gpt-device-code',
      type: 'url',
      args_present: true,
      args_count: 2,
      env_present: true,
      env_count: 1,
    })
    // 原始字段一个都不能出现。
    expect(JSON.stringify(summary)).not.toContain('Device code')
    expect(JSON.stringify(summary)).not.toContain('Sign in')
    expect(JSON.stringify(summary)).not.toContain('nested')
  })

  it('未知 method ID 与类型收敛为 other', () => {
    const summary = summarizeAuthMethod({ id: `tenant-${CANARY}`, type: 'magic-link' })
    expect(summary.method_id).toBe('other')
    expect(summary.type).toBe('other')
    expect(occurrences(summary)).toBe(0)
  })

  it('canary 放进 args/env/name/description/_meta 都不进入摘要', () => {
    const summary = summarizeAuthMethod({
      id: 'api-key',
      type: 'api-key',
      args: { key: CANARY },
      env: { SECRET: CANARY },
      name: CANARY,
      description: CANARY,
      _meta: { account: { email: CANARY } },
    })

    expect(occurrences(summary)).toBe(0)
    expect(summary).toEqual({
      method_id: 'api-key',
      type: 'api-key',
      args_present: true,
      args_count: 1,
      env_present: true,
      env_count: 1,
    })
  })

  it('args 为字符串数组时只记数量（terminal 命令行形状）', () => {
    const summary = summarizeAuthMethod({
      id: 'claude-ai-login',
      type: 'terminal',
      args: ['--cli', 'auth', 'login', '--claudeai'],
      env: { CANARY_ENV: 'x' },
    })

    expect(summary).toEqual({
      method_id: 'claude-ai-login',
      type: 'terminal',
      args_present: true,
      args_count: 4,
      env_present: true,
      env_count: 1,
    })
    // 原始命令行参数不得出现在摘要里。
    expect(JSON.stringify(summary)).not.toContain('--claudeai')
  })

  it('畸形输入返回空摘要而不是抛错', () => {
    expect(summarizeAuthMethod(null)).toEqual({
      method_id: 'other',
      type: 'other',
      args_present: false,
      args_count: 0,
      env_present: false,
      env_count: 0,
    })
    expect(summarizeAuthMethod('terminal')).toMatchObject({ method_id: 'other', type: 'other' })
  })

  it('保留 terminal 类型供调用方区分（不得送去 authenticate）', () => {
    expect(summarizeAuthMethod({ id: 'claude-ai-login', type: 'terminal' }).type).toBe('terminal')
  })

  it('summarizeAuthMethods 只接受数组', () => {
    expect(summarizeAuthMethods(undefined)).toEqual([])
    expect(summarizeAuthMethods({})).toEqual([])
    expect(summarizeAuthMethods([{ id: 'chat-gpt', type: 'url' }])).toHaveLength(1)
  })
})

describe('summarizeAuthStatus', () => {
  it('只记录出现标记与 allowlist kind', () => {
    expect(summarizeAuthStatus([])).toEqual({ observed: false, kinds: [] })
    expect(summarizeAuthStatus([{ kind: 'none' }, { kind: 'account' }]))
      .toEqual({ observed: true, kinds: ['none', 'account'] })
  })

  it('保留锁定版本真实出现的 status kind', () => {
    // Claude 0.90.0: none / account / api_key / gateway / external
    // Codex 2.2.2:   none / account / api_key / gateway / external
    const real = summarizeAuthStatus([
      { kind: 'none' },
      { kind: 'account', account: { email: 'user@example.test', plan: 'pro' } },
      { kind: 'api_key' },
      { kind: 'gateway', detail: 'rolecast' },
      { kind: 'external' },
    ])
    expect(real.kinds).toEqual(['none', 'account', 'api_key', 'gateway', 'external'])
    // 账号与细节仍然不出界。
    expect(JSON.stringify(real)).not.toContain('user@example.test')
    expect(JSON.stringify(real)).not.toContain('rolecast')
  })

  it('shape 合法但未列入 allowlist 的小写租户值归为 other', () => {
    const summary = summarizeAuthStatus([
      { kind: 'acme-tenant' },
      { kind: 'user-42' },
      { kind: 'none' },
    ])
    expect(summary.kinds).toEqual(['other', 'other', 'none'])
    expect(JSON.stringify(summary)).not.toContain('acme-tenant')
  })

  it('账号、Token 与非法 kind 不进入摘要', () => {
    const summary = summarizeAuthStatus([
      { kind: 'account', account: { email: `${CANARY}@example.test` }, token: CANARY },
      { kind: CANARY },
    ])
    expect(occurrences(summary)).toBe(0)
    expect(summary.kinds).toEqual(['account', 'other'])
  })
})

describe('summarizeUrl', () => {
  it('allowlisted HTTPS 只给模板 ID 与分类', () => {
    const summary = summarizeUrl('https://claude.ai/oauth/authorize?code=abc')
    expect(summary).toEqual({
      scheme: 'https',
      path_template: 'oauth_authorize',
      path_segment_count: 2,
      host_class: 'allowlisted',
      has_userinfo: false,
      has_query: true,
      has_fragment: false,
    })
  })

  it('loopback http 单独分类', () => {
    const summary = summarizeUrl('http://127.0.0.1:8080/callback')
    expect(summary.scheme).toBe('http-loopback')
    expect(summary.host_class).toBe('loopback')
    expect(summary.path_template).toBeNull()
    expect(summary.path_segment_count).toBe(1)
  })

  it('未知 host 与 path 只给分类和 segment 数', () => {
    const summary = summarizeUrl(`https://${CANARY}.example.test/a/${CANARY}/c`)
    expect(summary.host_class).toBe('other')
    expect(summary.path_segment_count).toBe(3)
    expect(summary.path_template).toBeNull()
    expect(occurrences(summary)).toBe(0)
  })

  it('userinfo / query / fragment 只记存在标记，canary 不出界', () => {
    const summary = summarizeUrl(
      `https://${CANARY}:${CANARY}@claude.ai/oauth/authorize?token=${CANARY}#${CANARY}`,
    )
    expect(summary.has_userinfo).toBe(true)
    expect(summary.has_query).toBe(true)
    expect(summary.has_fragment).toBe(true)
    expect(summary.host_class).toBe('allowlisted')
    expect(occurrences(summary)).toBe(0)
  })

  it('非法 URL 不回显原始输入', () => {
    const summary = summarizeUrl(`not a url ${CANARY}`)
    expect(summary.scheme).toBe('invalid')
    expect(summary.host_class).toBe('invalid')
    expect(occurrences(summary)).toBe(0)
  })

  it('空值与非字符串返回 invalid', () => {
    expect(summarizeUrl('').scheme).toBe('invalid')
    expect(summarizeUrl(null).scheme).toBe('invalid')
    expect(summarizeUrl(undefined).scheme).toBe('invalid')
  })

  it('非 http(s) scheme 归为 other 且不保留内容', () => {
    const summary = summarizeUrl(`vscode://${CANARY}/callback`)
    expect(summary.scheme).toBe('other')
    expect(occurrences(summary)).toBe(0)
  })
})
