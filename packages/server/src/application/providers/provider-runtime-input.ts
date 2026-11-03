import { isSensitiveRuntimeOptionKey, type ProviderConnectionDto } from '@rolecast/contract'

import type { AgentRuntimeConnectionInput } from '../ports/agent-runtime-port.js'
import type {
  ProviderDefinitionPort,
  RuntimeEnvironmentPort,
} from '../ports/id-generator-port.js'

/**
 * @name createProviderRuntimeInput
 * @description 将持久化 ProviderConnection 映射为 Runtime 启动输入，供测试连接和 Session 共用
 * @param {ProviderConnectionDto} connection ProviderConnection 配置
 * @param {ProviderDefinitionPort} definitions Adapter 定义 Port
 * @param {RuntimeEnvironmentPort} environment Runtime 环境 Port
 * @return {AgentRuntimeConnectionInput} 受控 Runtime 启动输入
 */
export function createProviderRuntimeInput(
  connection: ProviderConnectionDto,
  definitions: ProviderDefinitionPort,
  environment: RuntimeEnvironmentPort,
): AgentRuntimeConnectionInput {
  const definition = definitions.get(connection.provider_kind)
  const importedConfig = connection.codex_config === undefined
    ? undefined
    : {
        confirmed: true,
        ...(connection.base_url === undefined ? {} : { baseUrl: connection.base_url }),
        ...(connection.codex_config.wire_api === undefined ? {} : { wireApi: connection.codex_config.wire_api }),
        ...(connection.codex_config.model === undefined ? {} : { model: connection.codex_config.model }),
        ...(connection.codex_config.reasoning_effort === undefined
          ? {}
          : { reasoningEffort: connection.codex_config.reasoning_effort }),
      }
  return {
    providerKind: connection.provider_kind,
    connectionKind: connection.connection_kind,
    ...(connection.base_url === undefined ? {} : { baseUrl: connection.base_url }),
    adapterCommand: definition.adapterCommand,
    adapterArgs: definition.adapterArgs,
    cwd: environment.cwd,
    env: filterRuntimeEnvironment(environment.environment, connection.environment_mode),
    adapterVersion: definition.adapterVersion,
    environmentMode: connection.environment_mode,
    runtimeDirectory: environment.runtimeDirectory(connection.id),
    ...(connection.credential_ref === undefined ? {} : { credentialRef: connection.credential_ref }),
    ...(definition.credentialEnvironmentKey === undefined
      ? {}
      : { credentialEnvironmentKey: definition.credentialEnvironmentKey }),
    ...(importedConfig === undefined ? {} : { importedConfig }),
  }
}

function filterRuntimeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  mode: ProviderConnectionDto['environment_mode'],
): Readonly<Record<string, string | undefined>> {
  if (mode !== 'isolated') {
    return environment
  }
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !isSensitiveRuntimeOptionKey(key)))
}

