import type {
  CapabilitySnapshot,
  EnvironmentMode,
  RuntimeEvent,
} from '@rolecast/contract'

import type { ContextBundle } from '../context/context-builder.js'

/** 已确认的 Codex 非秘密配置输入。 */
export interface ConfirmedCodexConfigInput {
  confirmed: boolean
  baseUrl?: string
  wireApi?: string
  model?: string
  reasoningEffort?: string
}

/** Provider Runtime 的连接启动配置。 */
export interface AgentRuntimeConnectionInput {
  providerKind: 'claude' | 'codex'
  /** 连接类型；决定 custom_endpoint 是否翻译 endpoint。非秘密。 */
  connectionKind?: 'local' | 'api_key' | 'custom_endpoint'
  /** 非秘密 base URL；只有 custom_endpoint 使用。 */
  baseUrl?: string
  adapterCommand: string
  adapterArgs: readonly string[]
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  adapterVersion: string
  environmentMode: EnvironmentMode
  runtimeDirectory: string
  /** 受控 CredentialStore 引用，不携带 Secret。 */
  credentialRef?: string
  /** 只允许 ProviderDefinition 声明的凭据环境变量名。 */
  credentialEnvironmentKey?: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'
  importedConfig?: ConfirmedCodexConfigInput
}

/** 已建立的 Runtime 连接。 */
export interface AgentRuntimeConnection {
  connectionId: string
  providerKind: AgentRuntimeConnectionInput['providerKind']
  adapterVersion: string
  capabilities: CapabilitySnapshot
}

/** ACP 会话配置项。 */
export interface RuntimeConfigOption {
  id: string
  category: string
  currentValue: string
  options: readonly {
    value: string
    name?: string
    description?: string
  }[]
}

/** 已创建的 Runtime Session。 */
export interface AgentRuntimeSession {
  sessionId: string
  connection: AgentRuntimeConnection
  configOptions: readonly RuntimeConfigOption[]
}

/** 向 Agent 发送的一轮输入。 */
export interface AgentTurnInput {
  session: AgentRuntimeSession
  contextBundle: ContextBundle
}

/**
 * sendTurn 的派发边界信号。
 *
 * Runtime 只在真正把 `session/prompt` 写给 Adapter 之后调用 `onDispatched`；
 * 调用前的失败可证明未派发，调用后的失败只能视为结果不确定。
 */
export interface AgentTurnDispatchSignal {
  onDispatched?: () => void
}

/** ACP 权限请求的最小应答。 */
export interface PermissionResponseInput {
  session: AgentRuntimeSession
  requestId: string | number
  optionId?: string
  cancelled?: boolean
}

/**
 * Agent Runtime 稳定 Port。
 *
 * Provider 和 Adapter 的差异必须隐藏在 infrastructure/acp 中。
 */
export interface AgentRuntimePort {
  /** 建立 Adapter 连接并完成 initialize。 */
  connect(input: AgentRuntimeConnectionInput): Promise<AgentRuntimeConnection>
  /** 创建 ACP Session。 */
  createSession(connection: AgentRuntimeConnection, cwd: string): Promise<AgentRuntimeSession>
  /** 发送一轮输入并流式返回归一化 Runtime Event。 */
  sendTurn(input: AgentTurnInput, dispatch?: AgentTurnDispatchSignal): AsyncIterable<RuntimeEvent>
  /** 按 ACP config option 应用用户选中的模型或推理配置。 */
  setConfigOption?(
    session: AgentRuntimeSession,
    configId: string,
    value: string,
  ): Promise<AgentRuntimeSession>
  /** 回传 Adapter 权限决定。 */
  respondPermission(input: PermissionResponseInput): Promise<void>
  /** 取消当前轮次。 */
  cancelTurn(session: AgentRuntimeSession): Promise<void>
  /** 恢复已有 ACP Session。 */
  resumeSession(
    connection: AgentRuntimeConnection,
    sessionId: string,
    cwd: string,
  ): Promise<AgentRuntimeSession>
  /** 关闭 ACP Session 和底层 Adapter。 */
  closeSession(session: AgentRuntimeSession): Promise<void>
  /** 可选地关闭一个独立 Adapter 连接。 */
  closeConnection?(connectionId: string): Promise<void>
}
