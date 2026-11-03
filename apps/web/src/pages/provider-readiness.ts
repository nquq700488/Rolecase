import type { ProviderConnectionDto } from '@rolecast/contract'

/** Provider 连接在 UI 上的可运行状态。 */
export type ProviderReadiness =
  /** 可以测试连接、发现模型、开 Session。 */
  | { readonly status: 'ready'; readonly label: string }
  /** 可以保存，但运行入口会统一返回 provider_needs_configuration。 */
  | { readonly status: 'needs_configuration'; readonly label: string; readonly detail: string }
  /** endpoint 已记录但认证未证：禁止测试/发现/Session。 */
  | { readonly status: 'unverified'; readonly label: string; readonly detail: string }
  /** 需要先完成 Codex 配置导入。 */
  | { readonly status: 'needs_import'; readonly label: string; readonly detail: string }

/**
 * @name resolveProviderReadiness
 * @description 把 ProviderConnection 映射为页面展示与可操作状态
 * @param {ProviderConnectionDto} connection 连接记录
 * @return {ProviderReadiness} UI 状态
 * @example
 * resolveProviderReadiness({ ...codex, base_url: 'https://x' }).status // 'unverified'
 */
export function resolveProviderReadiness(connection: ProviderConnectionDto): ProviderReadiness {
  // 结构性拒绝先于 Provider 分支：这些组合后端判 invalid / needs_configuration，
  // 旧数据可能在 DTO 里保留它们，UI 绝不能显示 ready。
  if (connection.environment_mode !== 'isolated' && connection.credential_ref !== undefined) {
    return {
      status: 'needs_configuration',
      label: '配置不合法',
      detail: 'inherited 连接不能携带凭据引用，请重新创建或修正该连接。',
    }
  }
  if (connection.provider_kind === 'claude' && connection.codex_config !== undefined) {
    // 历史数据可能残留 Claude + codex_config；后端判 invalid，UI 不能显示 ready。
    return {
      status: 'needs_configuration',
      label: '配置不合法',
      detail: 'Claude 连接不能携带 Codex 配置，该连接需要重新创建或从配置导入重建。',
    }
  }
  if (connection.connection_kind === 'local' && connection.credential_ref !== undefined) {
    return {
      status: 'needs_configuration',
      label: '配置不合法',
      detail: 'local 连接不能携带凭据引用，请重新创建或修正该连接。',
    }
  }
  if (connection.connection_kind === 'custom_endpoint' && connection.base_url === undefined) {
    // Codex 的 endpoint 覆盖即使缺 URL 也不能按普通连接运行，统一归到待配置。
    return {
      status: 'needs_configuration',
      label: '待配置',
      detail: 'custom endpoint 连接需要非秘密 URL。',
    }
  }

  if (connection.provider_kind === 'codex') {
    // 与后端同一条判据：看有没有 endpoint 覆盖，而不是 connection_kind。
    if (connection.connection_kind === 'custom_endpoint' || connection.base_url !== undefined) {
      return {
        status: 'unverified',
        label: '认证未验证',
        detail: '该 endpoint 的 Codex 认证尚未证明，不能测试连接、发现模型或启动 Session。',
      }
    }
    if (connection.environment_mode === 'isolated') {
      if (connection.connection_kind === 'local') {
        return {
          status: 'needs_configuration',
          label: '待配置',
          detail: 'Codex isolated 需要先完成配置导入并提供凭据引用。请使用下方配置导入面板。',
        }
      }
      if (connection.credential_ref === undefined || !formsPersisted(connection)) {
        return {
          status: 'needs_import',
          label: '待导入',
          detail: '请先预览并应用 Codex config.toml，再绑定外部预置的凭据引用。',
        }
      }
      return { status: 'ready', label: '可运行' }
    }
    return { status: 'ready', label: '可运行' }
  }

  if (connection.environment_mode === 'isolated') {
    if (connection.connection_kind === 'local') {
      return {
        status: 'needs_configuration',
        label: '待配置',
        detail: 'Claude isolated 目前没有可用的隔离认证路径，可以保存但暂时不能运行。',
      }
    }
    if (connection.credential_ref === undefined) {
      return {
        status: 'needs_configuration',
        label: '待配置',
        detail: 'isolated 连接需要外部预置的凭据引用。请用「编辑连接」绑定已有引用，或先通过外部流程预置。',
      }
    }
  }
  return { status: 'ready', label: '可运行' }
}

/** 持久化 codex_config 是否含可物化字段。 */
function formsPersisted(connection: ProviderConnectionDto): boolean {
  const config = connection.codex_config
  return config !== undefined
    && (config.model !== undefined || config.wire_api !== undefined || config.reasoning_effort !== undefined)
}

/** 该连接是否允许触发 test / discover / Session。 */
export function canRunProvider(connection: ProviderConnectionDto): boolean {
  return resolveProviderReadiness(connection).status === 'ready'
}

/** 该连接是否只能走 Codex 配置导入。 */
export function needsCodexImport(connection: ProviderConnectionDto): boolean {
  return resolveProviderReadiness(connection).status === 'needs_import'
}

/**
 * @name showsCodexImportPanel
 * @description 该连接是否应展示 Codex 配置导入面板
 *
 * Codex isolated 不能通过创建接口建立，既定流程是「先建 inherited Codex，
 * 再 preview/apply 转成 isolated」。因此 inherited 的 local / api_key 也必须显示
 * 导入入口，否则用户无路可走；待导入与待配置状态同样保留入口作为恢复路径。
 * custom_endpoint 的认证未证，只给只读状态，不给可操作的导入入口以免误导。
 * @param {ProviderConnectionDto} connection 连接记录
 * @return {boolean} 是否显示导入面板
 * @example
 * showsCodexImportPanel({ ...codex, environment_mode: 'inherited' }) // true
 */
export function showsCodexImportPanel(connection: ProviderConnectionDto): boolean {
  if (connection.provider_kind !== 'codex') {
    return false
  }
  if (connection.connection_kind === 'custom_endpoint' || connection.base_url !== undefined) {
    return false
  }
  return connection.connection_kind === 'local' || connection.connection_kind === 'api_key'
}
