import { describe, expect, it } from 'vitest'

import type { ProviderConnectionDto } from '@rolecast/contract'

import { resolveProviderCombination } from './provider-combination.js'

/** 构造最小 ProviderConnection，只覆盖本用例关心的字段。 */
const connection = (overrides: Partial<ProviderConnectionDto>): ProviderConnectionDto => ({
  id: 'provider-001',
  workspace_id: 'workspace-001',
  provider_kind: 'claude',
  connection_kind: 'local',
  environment_mode: 'inherited',
  config_revision: 1,
  ...overrides,
})

describe('resolveProviderCombination', () => {
  it('Claude inherited local 允许运行且不读凭据', () => {
    expect(resolveProviderCombination(connection({}))).toEqual({ status: 'ready', requiresCredential: false })
  })

  it('Claude inherited api_key 允许运行，认证只来自继承环境', () => {
    expect(resolveProviderCombination(connection({ connection_kind: 'api_key' })))
      .toEqual({ status: 'ready', requiresCredential: false })
  })

  it('Claude inherited custom_endpoint 必须有 base_url', () => {
    expect(resolveProviderCombination(connection({ connection_kind: 'custom_endpoint' })))
      .toEqual({ status: 'needs_configuration', reason: 'missing_base_url' })
    expect(resolveProviderCombination(connection({
      connection_kind: 'custom_endpoint',
      base_url: 'https://gateway.example.test/v1',
    }))).toEqual({ status: 'ready', requiresCredential: false })
  })

  it('Claude isolated local 保存可接受但运行一律待配置', () => {
    expect(resolveProviderCombination(connection({ environment_mode: 'isolated' })))
      .toEqual({ status: 'needs_configuration', reason: 'isolated_local' })
  })

  it('Claude isolated api_key 与 custom_endpoint 需要凭据引用', () => {
    expect(resolveProviderCombination(connection({ environment_mode: 'isolated', connection_kind: 'api_key' })))
      .toEqual({ status: 'needs_configuration', reason: 'missing_credential' })
    expect(resolveProviderCombination(connection({
      environment_mode: 'isolated',
      connection_kind: 'api_key',
      credential_ref: 'credential-001',
    }))).toEqual({ status: 'ready', requiresCredential: true })
    expect(resolveProviderCombination(connection({
      environment_mode: 'isolated',
      connection_kind: 'custom_endpoint',
      credential_ref: 'credential-001',
    }))).toEqual({ status: 'needs_configuration', reason: 'missing_base_url' })
  })

  it('inherited 携带 credential_ref 一律拒绝，不能静默忽略', () => {
    expect(resolveProviderCombination(connection({ credential_ref: 'credential-001' })))
      .toEqual({ status: 'invalid', reason: 'inherited_with_credential' })
    expect(resolveProviderCombination(connection({
      connection_kind: 'api_key',
      credential_ref: 'credential-001',
    }))).toEqual({ status: 'invalid', reason: 'inherited_with_credential' })
  })

  it('Claude 携带 codex_config 一律拒绝', () => {
    expect(resolveProviderCombination(connection({
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
    }))).toEqual({ status: 'invalid', reason: 'claude_with_codex_config' })
  })

  it('custom_endpoint 缺少 base_url 时统一待配置（含 inherited 与 isolated）', () => {
    for (const environmentMode of ['inherited', 'isolated'] as const) {
      expect(resolveProviderCombination(connection({
        connection_kind: 'custom_endpoint',
        environment_mode: environmentMode,
        ...(environmentMode === 'isolated' ? { credential_ref: 'credential-001' } : {}),
      }))).toEqual({ status: 'needs_configuration', reason: 'missing_base_url' })
    }
  })

  it('Codex inherited local 允许运行', () => {
    expect(resolveProviderCombination(connection({ provider_kind: 'codex' })))
      .toEqual({ status: 'ready', requiresCredential: false })
  })

  it('Codex inherited custom_endpoint 认证未证，不得标记 ready', () => {
    expect(resolveProviderCombination(connection({
      provider_kind: 'codex',
      connection_kind: 'custom_endpoint',
      base_url: 'https://gateway.example.test/v1',
    }))).toEqual({ status: 'unverified', reason: 'codex_custom_endpoint_unverified' })
  })

  it('Codex isolated local 一律待配置', () => {
    expect(resolveProviderCombination(connection({ provider_kind: 'codex', environment_mode: 'isolated' })))
      .toEqual({ status: 'needs_configuration', reason: 'codex_isolated_unconfigured' })
  })

  it('Codex isolated api_key 需要非空 codex_config 与凭据引用', () => {
    expect(resolveProviderCombination(connection({
      provider_kind: 'codex',
      environment_mode: 'isolated',
      connection_kind: 'api_key',
      credential_ref: 'credential-001',
    }))).toEqual({ status: 'needs_configuration', reason: 'missing_codex_config' })
    expect(resolveProviderCombination(connection({
      provider_kind: 'codex',
      environment_mode: 'isolated',
      connection_kind: 'api_key',
      credential_ref: 'credential-001',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
    }))).toEqual({ status: 'ready', requiresCredential: true })
  })

  it('历史 codex api_key + base_url 也必须按未证处理', () => {
    // 旧 apply 可能留下该形状：connection_kind 仍是 api_key，但已有 base_url。
    expect(resolveProviderCombination(connection({
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'inherited',
      base_url: 'https://gateway.example.test/v1',
    }))).toEqual({ status: 'unverified', reason: 'codex_custom_endpoint_unverified' })
    expect(resolveProviderCombination(connection({
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      base_url: 'https://gateway.example.test/v1',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
    }))).toEqual({ status: 'unverified', reason: 'codex_custom_endpoint_unverified' })
    // local + base_url 同样不能当作可运行组合。
    expect(resolveProviderCombination(connection({
      provider_kind: 'codex',
      connection_kind: 'local',
      environment_mode: 'inherited',
      base_url: 'https://gateway.example.test/v1',
    }))).toEqual({ status: 'unverified', reason: 'codex_custom_endpoint_unverified' })
  })

  it('历史 codex_config 只有 model_provider 时判待配置，而不是 ready', () => {
    expect(resolveProviderCombination(connection({
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      codex_config: { model_provider: 'rolecast' },
    }))).toEqual({ status: 'needs_configuration', reason: 'missing_codex_config' })
  })

  it('Codex isolated custom_endpoint 认证未证，不得标记 ready', () => {
    expect(resolveProviderCombination(connection({
      provider_kind: 'codex',
      environment_mode: 'isolated',
      connection_kind: 'custom_endpoint',
      credential_ref: 'credential-001',
      base_url: 'https://gateway.example.test/v1',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
    }))).toEqual({ status: 'unverified', reason: 'codex_custom_endpoint_unverified' })
  })
})
