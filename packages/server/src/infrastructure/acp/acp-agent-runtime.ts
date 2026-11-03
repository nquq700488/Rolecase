import { isJsonRpcRequestId } from '@rolecast/contract'
import type {
  CapabilitySnapshot,
  RuntimeEvent,
} from '@rolecast/contract'

import type {
  AgentRuntimeConnection,
  AgentRuntimeConnectionInput,
  AgentRuntimePort,
  AgentRuntimeSession,
  AgentTurnDispatchSignal,
  AgentTurnInput,
  PermissionResponseInput,
  RuntimeConfigOption,
} from '../../application/ports/agent-runtime-port.js'
import type { CapabilityDiscoveryPort } from '../../application/ports/capability-discovery-port.js'
import type {
  CredentialStorePort,
  SecretRedactionPort,
  SecretRedactionScope,
} from '../../application/ports/credential-store-port.js'
import {
  CredentialDeniedError,
  CredentialStoreUnavailableError,
} from '../../application/ports/credential-store-port.js'
import {
  materializeProviderEnvironment,
  resolveProviderEnvironment,
} from './config-translator.js'
import { AcpJsonRpcClient, AcpRemoteError, type AcpRequestHandler } from './acp-client.js'
import { AcpProcess } from './acp-process.js'
import { SecretRedactor } from '../credentials/file-credential-store.js'

interface JsonRecord {
  [key: string]: unknown
}

interface CredentialEnvironmentResolution {
  readonly env: Readonly<Record<string, string>>
  /** 只在连接期间持有 Secret 的脱敏 scope；无 Secret 注入时为 null。 */
  readonly scope: SecretRedactionScope | null
}

interface PendingPermission {
  resolve: (value: JsonRecord) => void
  reject: (reason: Error) => void
}

interface AdapterContext {
  connection: AgentRuntimeConnection
  client: AcpJsonRpcClient
  process: AcpProcess
  pendingPermissions: Map<string, PendingPermission>
  eventSinks: Map<string, RuntimeEventQueue>
  scope: SecretRedactionScope | null
}

import {
  AcpConnectionClosedError,
  AcpPermissionIdConflictError,
  AcpPermissionIdInvalidError,
  AcpPermissionNotFoundError,
  CodexCustomEndpointUnverifiedError,
  CredentialEnvironmentMismatchError,
  ProviderNeedsConfigurationError,
} from './acp-runtime-errors.js'
import { assertRuntimeCombination, redactWithoutScope } from './runtime-input-guard.js'

export {
  AcpConnectionClosedError,
  AcpPermissionIdConflictError,
  AcpPermissionIdInvalidError,
  AcpPermissionNotFoundError,
  CodexCustomEndpointUnverifiedError,
  CredentialEnvironmentMismatchError,
  ProviderNeedsConfigurationError,
} from './acp-runtime-errors.js'

/** 参与跨 chunk 窗口的字段路径，与 scope 内的约定一致。 */
const TEXT_STREAM_PATH = 'text'

/** 将通用 ContextBundle 确定性渲染为 ACP 唯一支持的文本 prompt。 */
function renderContextBundle(bundle: AgentTurnInput['contextBundle']): string {
  const hasSupplementalContext = bundle.system_instructions.length > 0
    || bundle.referenced_artifacts.length > 0
    || bundle.session_summary.length > 0
    || bundle.constraints.length > 0
    || bundle.output_contract.length > 0
  if (!hasSupplementalContext) {
    return bundle.task_input
  }

  const sections = [
    ...(bundle.system_instructions.length === 0
      ? []
      : [`Role instructions:\n${bundle.system_instructions}`]),
    ...(bundle.session_summary.length === 0 ? [] : [`Session summary:\n${bundle.session_summary}`]),
    ...(bundle.constraints.length === 0
      ? []
      : [`Constraints:\n${bundle.constraints.map((constraint) => `- ${constraint}`).join('\n')}`]),
    ...(bundle.referenced_artifacts.length === 0
      ? []
      : [`Referenced artifacts:\n${bundle.referenced_artifacts.map((artifact) => `- ${artifact}`).join('\n')}`]),
    `Task input:\n${bundle.task_input}`,
    ...(bundle.output_contract.length === 0 ? [] : [`Output contract:\n${bundle.output_contract}`]),
  ]
  return sections.join('\n\n')
}

const RUNTIME_EVENT_KINDS: readonly RuntimeEvent['kind'][] = [
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'available_commands_update',
  'permission_requested',
  'turn_completed',
  'turn_cancelled',
  'adapter_crashed',
]

function isRuntimeEventKind(value: string): value is RuntimeEvent['kind'] {
  return (RUNTIME_EVENT_KINDS as readonly string[]).includes(value)
}

/**
 * 权限请求 ID 的 Map 键：带类型标签。
 *
 * JSON-RPC 的 number `1` 与 string `"1"` 是两个不同请求，不能折叠成同一键，
 * 否则数字 pending 会被字符串应答错误命中。标签格式与 SQLite 持久化一致。
 */
function permissionRequestKey(id: string | number): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`
}

/**
 * 把 Adapter 抛出的错误转换为不含 Adapter 原文的稳定错误。
 *
 * 非 JSON-RPC 远端错误保持原样（本地错误不含 Adapter 原文）；远端错误的
 * message 与 data 都按当前连接的 scope 脱敏。
 */
function redactAdapterError(
  scope: SecretRedactionScope | null,
  redaction: SecretRedactionPort,
  error: unknown,
): Error {
  if (!(error instanceof AcpRemoteError)) {
    return error instanceof Error ? error : new Error('ACP request failed')
  }
  const message = scope === null ? redaction.redact(error.message) : scope.redact(error.message)
  const data = scope === null
    ? redactWithoutScope(redaction, error.data)
    : scope.redactValue(error.data)
  return new AcpRemoteError({
    code: error.code,
    message,
    ...(data === undefined ? {} : { data }),
  })
}

/**
 * 基于 ACP stdio Adapter 的 Runtime 实现。
 *
 * Provider 差异只在 initialize、配置选项和权限报文的归一化处处理。
 */
export class AcpAgentRuntime implements AgentRuntimePort, CapabilityDiscoveryPort {
  private readonly contexts = new Map<string, AdapterContext>()
  private nextConnectionId = 1

  constructor(
    private readonly credentials?: CredentialStorePort,
    private readonly redaction: SecretRedactionPort = new SecretRedactor(),
  ) {}

  /** 启动 Adapter 并完成 initialize。 */
  async connect(input: AgentRuntimeConnectionInput): Promise<AgentRuntimeConnection> {
    // 组合前置校验必须在读取 CredentialStore / spawn 之前完成。
    assertRuntimeCombination(input)
    const credentialEnvironment = await this.resolveCredentialEnvironment(input)
    const scope = credentialEnvironment.scope
    const connectionId = `acp-${this.nextConnectionId++}`
    let handedOff = false
    try {
      const environment = resolveProviderEnvironment({
        providerKind: input.providerKind,
        ...(input.connectionKind === undefined ? {} : { connectionKind: input.connectionKind }),
        environmentMode: input.environmentMode,
        runtimeDirectory: input.runtimeDirectory,
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        ...(input.importedConfig === undefined ? {} : { importedConfig: input.importedConfig }),
      })
      if (environment.status === 'needs_configuration') {
        throw new ProviderNeedsConfigurationError(input.providerKind)
      }
      await materializeProviderEnvironment(
        {
          providerKind: input.providerKind,
          ...(input.connectionKind === undefined ? {} : { connectionKind: input.connectionKind }),
          environmentMode: input.environmentMode,
          runtimeDirectory: input.runtimeDirectory,
          ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
          ...(input.importedConfig === undefined ? {} : { importedConfig: input.importedConfig }),
        },
        environment,
      )

      const adapterProcess = await AcpProcess.start({
        command: input.adapterCommand,
        args: input.adapterArgs,
        cwd: input.cwd,
        env: { ...input.env, ...environment.env, ...credentialEnvironment.env },
      })
      const client = new AcpJsonRpcClient(adapterProcess.stdout, adapterProcess.stdin, {
        onFatalError: () => {
          void this.disposeConnection(connectionId).catch(() => undefined)
        },
      })

      try {
        const initialize = await client.request<JsonRecord>('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
        }).catch((error: unknown) => {
          throw redactAdapterError(scope, this.redaction, error)
        })
        const connection: AgentRuntimeConnection = {
          connectionId,
          providerKind: input.providerKind,
          adapterVersion: input.adapterVersion,
          // 成功响应同样可能回显 Secret，进入 CapabilitySnapshot 前必须脱敏。
          capabilities: mapCapabilitySnapshot(input, this.redactResponse(scope, initialize)),
        }
        const context: AdapterContext = {
          connection,
          client,
          process: adapterProcess,
          pendingPermissions: new Map(),
          eventSinks: new Map(),
          scope,
        }
        client.onRequest(this.createRequestHandler(context))
        this.contexts.set(connection.connectionId, context)
        // Adapter 崩溃或空闲退出也走统一清理路径，避免 Context / scope 残留。
        void adapterProcess.exited.then(() => this.disposeConnection(connectionId)).catch(() => undefined)
        // 成功交接后 scope 归 Context 所有，由连接失效清理关闭。
        handedOff = true
        return connection
      } catch (error: unknown) {
        client.close()
        await adapterProcess.close()
        throw error
      }
    } finally {
      // 配置解析、目录物化、spawn、initialize 任一步失败都必须清空未交接的 Secret 引用。
      if (!handedOff) {
        scope?.close()
      }
    }
  }

  /** 通过 initialize 返回规范化能力快照。 */
  async discover(input: AgentRuntimeConnectionInput): Promise<CapabilitySnapshot> {
    const connection = await this.connect(input)
    let temporarySession: AgentRuntimeSession | null = null
    try {
      temporarySession = await this.createSession(connection, input.cwd)
      return {
        ...connection.capabilities,
        capabilities: {
          ...connection.capabilities.capabilities,
          config_options: temporarySession.configOptions,
        },
      }
    } finally {
      if (temporarySession !== null) {
        await this.closeSession(temporarySession).catch(() => undefined)
      }
      await this.closeConnection(connection.connectionId)
    }
  }

  /** 创建 ACP Session。 */
  async createSession(
    connection: AgentRuntimeConnection,
    cwd: string,
  ): Promise<AgentRuntimeSession> {
    const context = this.requireContext(connection)
    const result = await this.requestAdapter<JsonRecord>(context, 'session/new', {
      cwd,
      mcpServers: [],
    })
    return mapSession(connection, this.redactResponse(context.scope, result))
  }

  /** 发送一轮输入并归一化事件流。 */
  async *sendTurn(
    input: AgentTurnInput,
    dispatch?: AgentTurnDispatchSignal,
  ): AsyncIterable<RuntimeEvent> {
    const context = this.requireContext(input.session.connection)
    const sessionId = input.session.sessionId
    const queue = new RuntimeEventQueue()
    context.eventSinks.set(sessionId, queue)
    const removeNotification = context.client.onNotification((message) => {
      const params = asRecord(message.params)
      if (message.method !== 'session/update' || params.sessionId !== sessionId) {
        return
      }
      const update = asRecord(params.update)
      const kind = stringValue(update.sessionUpdate)
      if (kind === undefined) {
        return
      }
      const eventKind = normalizeRuntimeEventKind(kind)
      queue.push({
        session_id: sessionId,
        kind: eventKind,
        payload: this.redactStreamPayload(context, sessionId, eventKind, update),
      })
    })

    const abortController = new AbortController()
    let turnSettled = false
    // onSent 只在 `session/prompt` 已写给 Adapter 后触发：这是可证明的 dispatch 边界。
    const turn = this.requestAdapter<JsonRecord>(context, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: renderContextBundle(input.contextBundle) }],
    }, 10 * 60 * 1000, abortController.signal, () => dispatch?.onDispatched?.())
      .then((result) => {
        const stopReason = stringValue(result.stopReason)
        const cancelled = stopReason === 'cancelled'
        if (cancelled) {
          // 取消的轮次丢弃窗口，不交还任何片段。
          context.scope?.dropStream(sessionId)
        } else {
          const tail = this.restorableTail(context, sessionId)
          if (tail !== undefined) {
            queue.push({ session_id: sessionId, kind: tail.kind, payload: { text: tail.text } })
          }
        }
        queue.push({
          session_id: sessionId,
          kind: cancelled ? 'turn_cancelled' : 'turn_completed',
          payload: this.redactPayload(context, result),
        })
        queue.close()
      })
      .catch((error: unknown) => {
        context.scope?.dropStream(sessionId)
        queue.fail(error)
      })
      .finally(() => {
        turnSettled = true
      })

    try {
      for await (const event of queue) {
        yield event
      }
      await turn
    } finally {
      removeNotification()
      context.eventSinks.delete(sessionId)
      if (!turnSettled) {
        context.scope?.dropStream(sessionId)
        abortController.abort()
        await this.cancelTurn(input.session).catch(() => undefined)
        await turn.catch(() => undefined)
      }
    }
  }

  /** 应用 ACP Session 的动态配置选项。 */
  async setConfigOption(
    session: AgentRuntimeSession,
    configId: string,
    value: string,
  ): Promise<AgentRuntimeSession> {
    const context = this.requireContext(session.connection)
    const result = await this.requestAdapter<JsonRecord>(context, 'session/set_config_option', {
      sessionId: session.sessionId,
      configId,
      value,
    })
    return {
      ...session,
      configOptions: mapConfigOptions(this.redactResponse(context.scope, result).configOptions),
    }
  }

  /** 回传 Adapter 的权限选项；request ID 的类型是身份的一部分。 */
  async respondPermission(input: PermissionResponseInput): Promise<void> {
    const context = this.requireContext(input.session.connection)
    const key = permissionRequestKey(input.requestId)
    const pending = context.pendingPermissions.get(key)
    if (pending === undefined) {
      throw new AcpPermissionNotFoundError()
    }
    context.pendingPermissions.delete(key)
    pending.resolve(
      input.cancelled === true || input.optionId === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: input.optionId } },
    )
  }

  /** ACP 的取消操作是 notification，不等待 RPC 响应。 */
  async cancelTurn(session: AgentRuntimeSession): Promise<void> {
    const context = this.requireContext(session.connection)
    context.client.notify('session/cancel', { sessionId: session.sessionId })
  }

  /** 恢复一个已有 ACP Session。 */
  async resumeSession(
    connection: AgentRuntimeConnection,
    sessionId: string,
    cwd: string,
  ): Promise<AgentRuntimeSession> {
    const context = this.requireContext(connection)
    const result = await this.requestAdapter<JsonRecord>(context, 'session/resume', {
      sessionId,
      cwd,
      mcpServers: [],
    })
    return mapSession(connection, { ...this.redactResponse(context.scope, result), sessionId })
  }

  /** 关闭 ACP Session；调用者随后可关闭连接。 */
  async closeSession(session: AgentRuntimeSession): Promise<void> {
    const context = this.requireContext(session.connection)
    await this.requestAdapter(context, 'session/close', { sessionId: session.sessionId })
  }

  /** 关闭一个 Adapter 连接并回收其进程。 */
  async closeConnection(connectionId: string): Promise<void> {
    await this.disposeConnection(connectionId)
  }

  /**
   * 幂等的连接失效清理：显式 closeConnection、ACP fatal 错误和 Adapter 异常退出共用。
   *
   * 先同步占用 `contexts` 条目，保证同一连接只有一个清理者，避免异常清理与
   * closeConnection 竞态；随后关闭 scope、收敛未决权限、回收进程。
   */
  private async disposeConnection(connectionId: string): Promise<void> {
    const context = this.contexts.get(connectionId)
    if (context === undefined) {
      return
    }
    this.contexts.delete(connectionId)
    // 先清空 Secret 引用，再回收进程，避免关闭期间继续用旧 Secret 匹配。
    context.scope?.close()
    context.client.close()
    // 收敛未决权限请求；handleRequest 在 closed 后不会再向 Adapter 写响应。
    for (const pending of context.pendingPermissions.values()) {
      pending.reject(new AcpConnectionClosedError())
    }
    context.pendingPermissions.clear()
    await context.process.close()
  }

  private async resolveCredentialEnvironment(
    input: AgentRuntimeConnectionInput,
  ): Promise<CredentialEnvironmentResolution> {
    if (input.environmentMode !== 'isolated') {
      // 历史组合在读取 CredentialStore 之前 fail-closed，不 spawn、不读 Secret。
      if (input.credentialRef !== undefined) {
        throw new CredentialEnvironmentMismatchError()
      }
      return { env: {}, scope: null }
    }
    if (input.credentialRef === undefined) {
      if (input.providerKind === 'codex') {
        throw new ProviderNeedsConfigurationError('codex')
      }
      return { env: {}, scope: null }
    }
    const expectedKey = input.providerKind === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
    if (input.credentialEnvironmentKey !== expectedKey || this.credentials === undefined) {
      throw new CredentialStoreUnavailableError()
    }
    let secret: string | null
    try {
      secret = await this.credentials.get(input.credentialRef)
    } catch (error: unknown) {
      if (error instanceof CredentialDeniedError) {
        throw error
      }
      throw new CredentialStoreUnavailableError()
    }
    if (secret === null) {
      throw new ProviderNeedsConfigurationError(input.providerKind)
    }
    return {
      env: { [expectedKey]: secret },
      // scope 只在连接期间持有 Secret，用于精确子串脱敏。
      scope: this.redaction.createScope(secret),
    }
  }

  /**
   * 取出可以安全还原的 turn 尾部。
   *
   * 只有同时满足以下条件才还原：恰好一条窗口、字段路径就是 `text`、归属唯一且是
   * 已知事件 kind。否则丢弃——改写成别的 kind / 字段（例如把 thought 或 tool 的
   * 尾部变成普通 Agent 消息）比丢文本更危险。
   */
  private restorableTail(
    context: AdapterContext,
    sessionId: string,
  ): { kind: RuntimeEvent['kind']; text: string } | undefined {
    const tails = context.scope?.flushStream(sessionId) ?? []
    const onlyTail = tails.length === 1 ? tails[0] : undefined
    if (
      onlyTail === undefined
      || onlyTail.text.length === 0
      || onlyTail.path !== TEXT_STREAM_PATH
      || onlyTail.owner === null
      || !isRuntimeEventKind(onlyTail.owner)
    ) {
      return undefined
    }
    return { kind: onlyTail.owner, text: onlyTail.text }
  }

  /** 不参与流窗口的结构脱敏，用于权限请求和 turn 完成 payload。 */
  private redactPayload(context: AdapterContext, value: unknown): JsonRecord {
    return this.redactResponse(context.scope, value)
  }

  /** 成功响应结构也必须经过当前连接 scope 递归脱敏后才能离开 Runtime。 */
  private redactResponse(scope: SecretRedactionScope | null, value: unknown): JsonRecord {
    const redacted = scope === null ? redactWithoutScope(this.redaction, value) : scope.redactValue(value)
    return { ...asRecord(redacted) }
  }

  /** 参与跨 chunk 窗口的流脱敏，用于 session/update payload；owner 记录事件 kind。 */
  private redactStreamPayload(
    context: AdapterContext,
    sessionId: string,
    owner: string,
    value: unknown,
  ): JsonRecord {
    if (context.scope === null) {
      return this.redactPayload(context, value)
    }
    return { ...asRecord(context.scope.redactStreamRecord(value, sessionId, owner)) }
  }

  /** 统一把 Adapter 请求错误转换为不含 Adapter 原文的稳定错误。 */
  private async requestAdapter<T>(
    context: AdapterContext,
    method: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
    onSent?: () => void,
  ): Promise<T> {
    try {
      return await context.client.request<T>(method, params, timeoutMs, signal, onSent)
    } catch (error: unknown) {
      throw redactAdapterError(context.scope, this.redaction, error)
    }
  }

  private requireContext(connection: AgentRuntimeConnection): AdapterContext {
    const context = this.contexts.get(connection.connectionId)
    if (context === undefined) {
      throw new Error(`ACP connection is not active: ${connection.connectionId}`)
    }
    return context
  }

  private createRequestHandler(context: AdapterContext): AcpRequestHandler {
    return async (request) => {
      if (request.method !== 'session/request_permission') {
        return {}
      }
      // 防御性校验：ACP ingress 已经拒绝非法 ID，这里保证任何调用路径都不会
      // 登记一个后续 DTO / SQLite 无法表达的 pending（那会永远无法应答）。
      if (!isJsonRpcRequestId(request.id)) {
        throw new AcpPermissionIdInvalidError()
      }
      const key = permissionRequestKey(request.id)
      // 只有同类型同值的重复 ID 才是冲突：number 1 与 string "1" 是两个独立请求。
      // 覆盖已有 pending 会让原请求永久悬空，因此 fail-closed 拒绝新请求。
      if (context.pendingPermissions.has(key)) {
        throw new AcpPermissionIdConflictError()
      }
      const params = asRecord(request.params)
      const sessionId = stringValue(params.sessionId)
      if (sessionId !== undefined) {
        context.eventSinks.get(sessionId)?.push({
          session_id: sessionId,
          kind: 'permission_requested',
          payload: {
            ...this.redactPayload(context, params),
            request_id: request.id,
          },
        })
      }
      return new Promise<JsonRecord>((resolve, reject) => {
        context.pendingPermissions.set(key, { resolve, reject })
      })
    }
  }
}

/** 异步事件队列，避免用固定 sleep 判断 ACP 事件。 */
class RuntimeEventQueue {
  private readonly values: RuntimeEvent[] = []
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<RuntimeEvent>) => void
    reject: (error: unknown) => void
  }> = []
  private closed = false
  private failure: unknown = null

  push(event: RuntimeEvent): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: event })
      return
    }
    this.values.push(event)
  }

  close(): void {
    this.closed = true
    this.flush()
  }

  fail(error: unknown): void {
    this.failure = error
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error)
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<RuntimeEvent> {
    while (true) {
      if (this.values.length > 0) {
        const value = this.values.shift()
        if (value !== undefined) {
          yield value
        }
        continue
      }
      if (this.failure !== null) {
        throw this.failure
      }
      if (this.closed) {
        return
      }
      const next = await new Promise<IteratorResult<RuntimeEvent>>((resolve, reject) => {
        this.waiters.push({ resolve, reject })
      })
      if (next.done) {
        return
      }
      yield next.value
    }
  }

  private flush(): void {
    if (!this.closed || this.values.length > 0) {
      return
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined })
    }
  }
}

function mapCapabilitySnapshot(
  input: AgentRuntimeConnectionInput,
  initialize: JsonRecord,
): CapabilitySnapshot {
  const agentInfo = asRecord(initialize.agentInfo)
  return {
    provider_kind: input.providerKind,
    adapter_version: stringValue(agentInfo.version) ?? input.adapterVersion,
    source: 'acp_handshake',
    observed_at: new Date().toISOString(),
    capabilities: {
      agent_capabilities: initialize.agentCapabilities ?? {},
      auth_methods: initialize.authMethods ?? [],
    },
  }
}

function mapSession(
  connection: AgentRuntimeConnection,
  result: JsonRecord,
): AgentRuntimeSession {
  const sessionId = stringValue(result.sessionId)
  if (sessionId === undefined) {
    throw new Error('ACP session response did not contain sessionId')
  }
  return {
    sessionId,
    connection,
    configOptions: mapConfigOptions(result.configOptions),
  }
}

function mapConfigOptions(value: unknown): RuntimeConfigOption[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item) => {
    const option = asRecord(item)
    const id = stringValue(option.id)
    const category = stringValue(option.category)
    const currentValue = stringValue(option.currentValue)
    if (id === undefined || category === undefined || currentValue === undefined) {
      return []
    }
    const options = Array.isArray(option.options)
      ? option.options.flatMap((candidate) => {
          const record = asRecord(candidate)
          const value = stringValue(record.value)
          const name = stringValue(record.name)
          const description = stringValue(record.description)
          return value === undefined
            ? []
            : [{
                value,
                ...(name === undefined ? {} : { name }),
                ...(description === undefined ? {} : { description }),
              }]
        })
      : []
    return [{ id, category, currentValue, options }]
  })
}

function normalizeRuntimeEventKind(kind: string): RuntimeEvent['kind'] {
  return isRuntimeEventKind(kind) ? kind : 'tool_call_update'
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  return value as JsonRecord
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
