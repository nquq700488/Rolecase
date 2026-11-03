import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parse } from 'smol-toml'
import { describe, expect, it } from 'vitest'

import {
  materializeProviderEnvironment,
  resolveProviderEnvironment,
} from './config-translator.js'

describe('resolveProviderEnvironment', () => {
  it('Claude custom endpoint 通过 ANTHROPIC_BASE_URL 生效（inherited 与 isolated）', () => {
    for (const environmentMode of ['inherited', 'isolated'] as const) {
      const result = resolveProviderEnvironment({
        providerKind: 'claude',
        connectionKind: 'custom_endpoint',
        environmentMode,
        runtimeDirectory: '/tmp/rolecast-claude',
        baseUrl: 'https://gateway.example.test/v1',
      })

      expect(result.status).toBe('ready')
      expect(result.env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.test/v1')
    }
  })

  it('Claude non-custom 连接不注入 ANTHROPIC_BASE_URL', () => {
    const result = resolveProviderEnvironment({
      providerKind: 'claude',
      connectionKind: 'api_key',
      environmentMode: 'isolated',
      runtimeDirectory: '/tmp/rolecast-claude',
    })

    expect(result.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('inherited 模式不注入 Provider 配置目录', () => {
    const result = resolveProviderEnvironment({
      providerKind: 'codex',
      environmentMode: 'inherited',
      runtimeDirectory: '/tmp/rolecast-runtime',
    })

    expect(result).toEqual({ status: 'ready', env: {} })
  })

  it('Claude isolated 模式只设置 CLAUDE_CONFIG_DIR', () => {
    const result = resolveProviderEnvironment({
      providerKind: 'claude',
      environmentMode: 'isolated',
      runtimeDirectory: '/tmp/rolecast-claude',
    })

    expect(result).toEqual({
      status: 'ready',
      env: { CLAUDE_CONFIG_DIR: '/tmp/rolecast-claude' },
    })
  })

  it('Codex isolated 缺少确认配置时 fail-closed', () => {
    const result = resolveProviderEnvironment({
      providerKind: 'codex',
      environmentMode: 'isolated',
      runtimeDirectory: '/tmp/rolecast-codex',
    })

    expect(result).toEqual({
      status: 'needs_configuration',
      env: { CODEX_HOME: '/tmp/rolecast-codex' },
    })
  })

  it('将已确认的 Codex 配置写入隔离目录且不写入凭据', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-config-'))
    const input = {
      providerKind: 'codex' as const,
      environmentMode: 'isolated' as const,
      runtimeDirectory,
      importedConfig: {
        confirmed: true,
        baseUrl: 'https://gateway.example.test/v1',
        wireApi: 'responses',
        model: 'gpt-test',
        reasoningEffort: 'medium',
      },
    }
    try {
      const resolution = resolveProviderEnvironment(input)
      await materializeProviderEnvironment(input, resolution)
      const config = await readFile(join(runtimeDirectory, 'config.toml'), 'utf8')

      const parsed = parse(config) as Record<string, unknown>
      expect(parsed.model).toBe('gpt-test')
      expect(config).toContain('base_url = "https://gateway.example.test/v1"')
      expect(config).toContain('wire_api = "responses"')
      expect(config).toContain('model = "gpt-test"')
      expect(config).not.toContain('api_key')
      expect(config).not.toContain('access_token')
    } finally {
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('Codex 只有选择名、没有可物化字段时判定为待配置', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-codex-provider-only-'))
    try {
      // `model_provider` 只是选择名，不在 ConfirmedCodexConfig 的可物化字段里；
      // 只有 confirmed 时 translator 无法产出 config.toml 内容，必须判待配置。
      const resolution = resolveProviderEnvironment({
        providerKind: 'codex',
        environmentMode: 'isolated',
        runtimeDirectory,
        importedConfig: { confirmed: true },
      })

      expect(resolution).toMatchObject({ status: 'needs_configuration' })
    } finally {
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('Codex isolated 只接受已确认的非秘密配置', () => {
    const result = resolveProviderEnvironment({
      providerKind: 'codex',
      environmentMode: 'isolated',
      runtimeDirectory: '/tmp/rolecast-codex',
      importedConfig: {
        confirmed: true,
        baseUrl: 'https://gateway.example.test/v1',
        model: 'gpt-test',
        reasoningEffort: 'medium',
      },
    })

    expect(result).toEqual({
      status: 'ready',
      env: { CODEX_HOME: '/tmp/rolecast-codex' },
      config: {
        baseUrl: 'https://gateway.example.test/v1',
        model: 'gpt-test',
        reasoningEffort: 'medium',
      },
    })
  })
})
