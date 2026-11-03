import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { EnvironmentMode } from '@rolecast/contract'

/** 已由用户确认的 Codex 非秘密配置草稿。 */
export interface ConfirmedCodexConfig {
  confirmed: boolean
  baseUrl?: string
  wireApi?: string
  model?: string
  reasoningEffort?: string
}

/** Provider Runtime 环境解析输入。 */
export interface ProviderEnvironmentInput {
  providerKind: 'claude' | 'codex'
  /** 连接类型；custom_endpoint 需要把 base_url 翻译给 Adapter。 */
  connectionKind?: 'local' | 'api_key' | 'custom_endpoint'
  environmentMode: EnvironmentMode
  runtimeDirectory: string
  /** 非秘密 base URL；只有 custom_endpoint 会使用。 */
  baseUrl?: string
  importedConfig?: ConfirmedCodexConfig
}

/** Provider Runtime 环境解析结果。 */
export type ProviderEnvironmentResolution =
  | {
      status: 'ready'
      env: Readonly<Record<string, string>>
      config?: Readonly<{
        baseUrl?: string
        wireApi?: string
        model?: string
        reasoningEffort?: string
      }>
    }
  | {
      status: 'needs_configuration'
      env: Readonly<Record<string, string>>
    }

/**
 * 把 Rolecast 的环境策略转换为 Adapter 启动覆盖项。
 *
 * Codex isolated 缺少已确认非秘密配置时 fail-closed，不静默继承全局环境。
 */
export function resolveProviderEnvironment(
  input: ProviderEnvironmentInput,
): ProviderEnvironmentResolution {
  if (input.runtimeDirectory.length === 0) {
    throw new Error('Runtime directory is required')
  }
  if (input.environmentMode === 'inherited') {
    // Claude 的 custom endpoint 由 Probe 证实走 ANTHROPIC_BASE_URL，inherited 同样生效。
    return { status: 'ready', env: claudeEndpointEnv(input) }
  }

  const envKey = input.providerKind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
  const env = { [envKey]: input.runtimeDirectory, ...claudeEndpointEnv(input) }
  if (input.providerKind === 'claude') {
    return { status: 'ready', env }
  }

  const importedConfig = input.importedConfig
  if (importedConfig?.confirmed !== true) {
    return { status: 'needs_configuration', env }
  }

  const config = {
    ...(importedConfig.baseUrl === undefined ? {} : { baseUrl: importedConfig.baseUrl }),
    ...(importedConfig.wireApi === undefined ? {} : { wireApi: importedConfig.wireApi }),
    ...(importedConfig.model === undefined ? {} : { model: importedConfig.model }),
    ...(importedConfig.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: importedConfig.reasoningEffort }),
  }
  const hasNonSecretConfig = Object.keys(config).length > 0
  if (!hasNonSecretConfig) {
    return { status: 'needs_configuration', env }
  }

  return { status: 'ready', env, config }
}

/**
 * Claude custom endpoint 的环境覆盖。
 *
 * Probe 实测：`claude-agent-acp@0.90.0` 读取 `ANTHROPIC_BASE_URL`，对 inherited 与
 * isolated 都生效，业务请求为 `POST /v1/messages`。只有 custom_endpoint 才注入，
 * 避免污染普通连接的端点选择。
 */
function claudeEndpointEnv(input: ProviderEnvironmentInput): Record<string, string> {
  if (input.providerKind !== 'claude' || input.connectionKind !== 'custom_endpoint') {
    return {}
  }
  if (input.baseUrl === undefined || input.baseUrl.length === 0) {
    return {}
  }
  return { ANTHROPIC_BASE_URL: input.baseUrl }
}

/** 将已确认的 Codex 非秘密配置写入隔离运行时目录。 */
export async function materializeProviderEnvironment(
  input: ProviderEnvironmentInput,
  resolution: ProviderEnvironmentResolution,
): Promise<void> {
  if (input.providerKind !== 'codex' || resolution.status !== 'ready' || resolution.config === undefined) {
    return
  }

  const lines: string[] = []
  if (resolution.config.model !== undefined) {
    lines.push(`model = ${JSON.stringify(resolution.config.model)}`)
  }
  if (resolution.config.reasoningEffort !== undefined) {
    lines.push(`model_reasoning_effort = ${JSON.stringify(resolution.config.reasoningEffort)}`)
  }
  if (resolution.config.baseUrl !== undefined || resolution.config.wireApi !== undefined) {
    lines.push('model_provider = "rolecast"')
    lines.push('')
    lines.push('[model_providers.rolecast]')
    lines.push('name = "Rolecast"')
    if (resolution.config.baseUrl !== undefined) {
      lines.push(`base_url = ${JSON.stringify(resolution.config.baseUrl)}`)
    }
    if (resolution.config.wireApi !== undefined) {
      lines.push(`wire_api = ${JSON.stringify(resolution.config.wireApi)}`)
    }
  }

  if (lines.length === 0) {
    return
  }
  await mkdir(input.runtimeDirectory, { recursive: true })
  await writeFile(join(input.runtimeDirectory, 'config.toml'), `${lines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}
