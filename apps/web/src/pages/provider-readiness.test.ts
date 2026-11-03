import { describe, expect, it } from 'vitest'

import type { ProviderConnectionDto } from '@rolecast/contract'

import {
  canRunProvider,
  needsCodexImport,
  resolveProviderReadiness,
  showsCodexImportPanel,
} from './provider-readiness.js'

const connection = (overrides: Partial<ProviderConnectionDto>): ProviderConnectionDto => ({
  id: 'provider-001',
  workspace_id: 'workspace-001',
  provider_kind: 'claude',
  connection_kind: 'local',
  environment_mode: 'inherited',
  config_revision: 1,
  ...overrides,
})

describe('resolveProviderReadiness', () => {
  it('Claude inherited 各连接类型均可运行', () => {
    for (const kind of ['local', 'api_key', 'custom_endpoint'] as const) {
      const provider = connection({
        connection_kind: kind,
        ...(kind === 'custom_endpoint' ? { base_url: 'https://gateway.example.test/v1' } : {}),
      })
      expect(resolveProviderReadiness(provider)).toEqual({ status: 'ready', label: '可运行' })
      expect(canRunProvider(provider)).toBe(true)
    }
  })

  it('Claude isolated local 可保存但待配置', () => {
    const readiness = resolveProviderReadiness(connection({ environment_mode: 'isolated' }))
    expect(readiness.status).toBe('needs_configuration')
    expect(canRunProvider(connection({ environment_mode: 'isolated' }))).toBe(false)
  })

  it('Claude isolated 有引用时视为可运行，缺引用待配置', () => {
    const withRef = connection({
      environment_mode: 'isolated',
      connection_kind: 'api_key',
      credential_ref: 'credential-001',
    })
    expect(resolveProviderReadiness(withRef)).toEqual({ status: 'ready', label: '可运行' })
    expect(resolveProviderReadiness(connection({
      environment_mode: 'isolated',
      connection_kind: 'api_key',
    })).status).toBe('needs_configuration')
  })

  it('Codex inherited baseline 可运行', () => {
    expect(resolveProviderReadiness(connection({ provider_kind: 'codex' })))
      .toEqual({ status: 'ready', label: '可运行' })
  })

  it('Codex 任何带 base_url 的连接都标为认证未验证（含旧 api_key 形状）', () => {
    for (const kind of ['api_key', 'local', 'custom_endpoint'] as const) {
      const readiness = resolveProviderReadiness(connection({
        provider_kind: 'codex',
        connection_kind: kind,
        base_url: 'https://gateway.example.test/v1',
      }))
      expect(readiness.status).toBe('unverified')
      expect(canRunProvider(connection({
        provider_kind: 'codex',
        connection_kind: kind,
        base_url: 'https://gateway.example.test/v1',
      }))).toBe(false)
    }
  })

  it('Codex isolated api_key 缺引用或配置时待导入', () => {
    const provider = connection({
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
    })
    expect(resolveProviderReadiness(provider).status).toBe('needs_import')
    expect(needsCodexImport(provider)).toBe(true)
  })

  it('Codex isolated 配置与引用齐备时可运行', () => {
    expect(resolveProviderReadiness(connection({
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
    }))).toEqual({ status: 'ready', label: '可运行' })
  })

  it('Codex isolated 只有 model_provider 时仍待导入', () => {
    expect(resolveProviderReadiness(connection({
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      codex_config: { model_provider: 'rolecast' },
    })).status).toBe('needs_import')
  })

  it('Claude 携带遗留 codex_config 时 fail-closed', () => {
    const provider = connection({
      provider_kind: 'claude',
      environment_mode: 'inherited',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
    })
    const readiness = resolveProviderReadiness(provider)
    expect(readiness.status).not.toBe('ready')
    expect(readiness.label).toContain('不合法')
    expect(canRunProvider(provider)).toBe(false)
  })

  describe('后端结构性拒绝在 UI 上同样不可运行', () => {
    it('inherited + credential_ref 不能 ready', () => {
      const readiness = resolveProviderReadiness(connection({ credential_ref: 'credential-001' }))
      expect(readiness.status).not.toBe('ready')
      expect(canRunProvider(connection({ credential_ref: 'credential-001' }))).toBe(false)
    })

    it('local + credential_ref 不能 ready（含 isolated local）', () => {
      for (const environmentMode of ['inherited', 'isolated'] as const) {
        const provider = connection({ connection_kind: 'local', environment_mode: environmentMode, credential_ref: 'credential-001' })
        expect(resolveProviderReadiness(provider).status).not.toBe('ready')
        expect(canRunProvider(provider)).toBe(false)
      }
    })

    it('custom_endpoint 缺 base_url 不能 ready', () => {
      for (const providerKind of ['claude', 'codex'] as const) {
        const provider = connection({ provider_kind: providerKind, connection_kind: 'custom_endpoint' })
        expect(resolveProviderReadiness(provider).status).not.toBe('ready')
        expect(canRunProvider(provider)).toBe(false)
      }
    })

    it('Codex 带 base_url 仍按认证未验证处理（优先于结构性缺 URL 判断）', () => {
      expect(resolveProviderReadiness(connection({
        provider_kind: 'codex',
        connection_kind: 'custom_endpoint',
        base_url: 'https://gateway.example.test/v1',
      })).status).toBe('unverified')
    })
  })

  describe('showsCodexImportPanel', () => {
    it('inherited Codex local / api_key 显示导入入口（既定流程起点）', () => {
      for (const kind of ['local', 'api_key'] as const) {
        expect(showsCodexImportPanel(connection({
          provider_kind: 'codex',
          connection_kind: kind,
          environment_mode: 'inherited',
        }))).toBe(true)
      }
    })

    it('Codex isolated 待导入仍保留入口', () => {
      expect(showsCodexImportPanel(connection({
        provider_kind: 'codex',
        connection_kind: 'api_key',
        environment_mode: 'isolated',
      }))).toBe(true)
    })

    it('Claude 任何组合都不显示', () => {
      for (const kind of ['local', 'api_key', 'custom_endpoint'] as const) {
        for (const mode of ['inherited', 'isolated'] as const) {
          expect(showsCodexImportPanel(connection({ connection_kind: kind, environment_mode: mode }))).toBe(false)
        }
      }
    })

    it('Codex custom endpoint 或任何带 base_url 的连接不显示可操作入口', () => {
      expect(showsCodexImportPanel(connection({
        provider_kind: 'codex',
        connection_kind: 'custom_endpoint',
      }))).toBe(false)
      // 历史 api_key + base_url 同样不能当作普通连接。
      expect(showsCodexImportPanel(connection({
        provider_kind: 'codex',
        connection_kind: 'api_key',
        base_url: 'https://gateway.example.test/v1',
      }))).toBe(false)
    })
  })
})
