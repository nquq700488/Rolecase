import type { SecretRedactionPort } from '../../application/ports/credential-store-port.js'
import type { AgentRuntimeConnectionInput } from '../../application/ports/agent-runtime-port.js'

import {
  CodexCustomEndpointUnverifiedError,
  ProviderNeedsConfigurationError,
} from './acp-runtime-errors.js'

/** 已确认的 Codex 配置是否包含至少一个可物化到 config.toml 的字段。 */
function formsRuntimeCodexConfig(config: AgentRuntimeConnectionInput['importedConfig']): boolean {
  if (config?.confirmed !== true) {
    return false
  }
  return config.baseUrl !== undefined
    || config.wireApi !== undefined
    || config.model !== undefined
    || config.reasoningEffort !== undefined
}

/**
 * @name assertRuntimeCombination
 * @description Runtime spawn 前的防御性组合校验，准备用于任何直接调用
 * @param {AgentRuntimeConnectionInput} input Runtime 连接输入
 * @return {void} 可运行时正常返回
 * @throws {ProviderNeedsConfigurationError | CodexCustomEndpointUnverifiedError} 不可运行的组合
 * @example
 * assertRuntimeCombination(input)
 */
export function assertRuntimeCombination(input: AgentRuntimeConnectionInput): void {
  // inherited 携带 credentialRef 在 resolveCredentialEnvironment 中处理（历史组合）。
  // 判据是「有没有 endpoint 覆盖」：旧数据可能把 base_url 留在 api_key / local 上。
  if (
    input.providerKind === 'codex'
    && (input.connectionKind === 'custom_endpoint' || input.baseUrl !== undefined)
  ) {
    // endpoint 覆盖已证实，但认证未证：不能 spawn。
    throw new CodexCustomEndpointUnverifiedError()
  }
  if (
    input.providerKind === 'codex'
    && input.environmentMode === 'isolated'
    && !formsRuntimeCodexConfig(input.importedConfig)
  ) {
    // 没有可物化字段时不能进入 spawn 与凭据读取；上层应已判待配置。
    throw new ProviderNeedsConfigurationError('codex')
  }
  if (input.connectionKind === 'custom_endpoint' && input.baseUrl === undefined) {
    throw new ProviderNeedsConfigurationError(input.providerKind)
  }
  if (input.environmentMode === 'isolated' && input.connectionKind === 'local') {
    throw new ProviderNeedsConfigurationError(input.providerKind)
  }
  if (
    input.environmentMode === 'isolated'
    && input.connectionKind !== 'local'
    && input.credentialRef === undefined
  ) {
    throw new ProviderNeedsConfigurationError(input.providerKind)
  }
}

/**
 * @name redactWithoutScope
 * @description 无 Secret scope 时的防御性脱敏；对象、数组和字符串都递归覆盖
 * @param {SecretRedactionPort} redaction 脱敏 Port
 * @param {unknown} value 任意 JSON（如 JSON-RPC error.data）
 * @return {unknown} 脱敏后的同形状值
 * @example
 * redactWithoutScope(redactor, [{ api_key: 'x' }])
 */
export function redactWithoutScope(redaction: SecretRedactionPort, value: unknown): unknown {
  if (typeof value === 'string') {
    return redaction.redact(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactWithoutScope(redaction, item))
  }
  if (typeof value === 'object' && value !== null) {
    return redaction.redactRecord(value as Record<string, unknown>)
  }
  return value
}
