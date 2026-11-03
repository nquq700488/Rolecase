import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AcpJsonRpcClient,
  AcpProcess,
  resolveAdapterCommand,
  type AcpProcessOptions,
  type AcpRequestHandler,
} from '@rolecast/server'

export type AcpProvider = 'claude' | 'codex'
export type AcpMessage = Record<string, unknown>

const sessionCloseTimeoutMs = 10_000

/** 一个只用于 Phase 0 集成测试的 Adapter 会话。 */
export class AcpTestHarness {
  private readonly sessionIds = new Set<string>()

  private constructor(
    readonly provider: AcpProvider,
    readonly workDir: string,
    private readonly process: AcpProcess,
    private readonly client: AcpJsonRpcClient,
    private readonly notifications: AcpMessage[],
  ) {}

  /** 启动当前 workspace 锁定的 Adapter。 */
  static async start(
    provider: AcpProvider,
    options: {
      cwd?: string
      env?: NodeJS.ProcessEnv
      isolated?: boolean
    } = {},
  ): Promise<AcpTestHarness> {
    const workDir = options.cwd ?? (await mkdtemp(join(tmpdir(), 'rolecast-acp-')))
    const providerConfigDirectory = join(workDir, '.provider-config')
    const isolatedEnv = options.isolated
      ? { [provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: providerConfigDirectory }
      : {}
    if (options.isolated) {
      await mkdir(providerConfigDirectory, { recursive: true })
    }
    const adapter = resolveAdapterCommand(
      provider,
      options.env?.[provider === 'claude' ? 'ROLECAST_CLAUDE_ADAPTER_COMMAND' : 'ROLECAST_CODEX_ADAPTER_COMMAND'],
    )
    const processOptions: AcpProcessOptions = {
      command: adapter.command,
      args: adapter.args,
      cwd: workDir,
      env: { ...process.env, ...isolatedEnv, ...options.env },
    }
    const adapterProcess = await AcpProcess.start(processOptions)
    const notifications: AcpMessage[] = []
    const client = new AcpJsonRpcClient(adapterProcess.stdout, adapterProcess.stdin)
    client.onNotification((message) => {
      notifications.push(message as unknown as AcpMessage)
    })

    return new AcpTestHarness(provider, workDir, adapterProcess, client, notifications)
  }

  /** 执行 ACP initialize。 */
  initialize(): Promise<AcpMessage> {
    return this.client.request<AcpMessage>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    })
  }

  /** 创建 ACP Session 并记录其 ID，供 close 时优雅收尾。 */
  async newSession(): Promise<AcpMessage> {
    const session = await this.client.request<AcpMessage>('session/new', {
      cwd: this.workDir,
      mcpServers: [],
    })
    const sessionId = session.sessionId
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      this.sessionIds.add(sessionId)
    }
    return session
  }

  /** 调用 ACP 方法。 */
  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    return this.client.request<T>(method, params, timeoutMs)
  }

  /** 注册 Adapter 反向请求处理器。 */
  onRequest(handler: AcpRequestHandler): () => void {
    return this.client.onRequest(handler)
  }

  /** 发送 ACP 通知。 */
  notify(method: string, params: unknown): void {
    this.client.notify(method, params)
  }

  /** 等待一个满足条件的服务端通知。 */
  async waitForNotification(
    predicate: (message: AcpMessage) => boolean,
    timeoutMs = 30_000,
  ): Promise<AcpMessage> {
    const existing = this.notifications.find(predicate)
    if (existing !== undefined) {
      return existing
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const match = this.notifications.find(predicate)
      if (match !== undefined) {
        return match
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`ACP notification timed out after ${timeoutMs}ms`)
  }

  /** 先优雅关闭 ACP Session，再回收 Adapter 和测试工作目录。 */
  async close(): Promise<void> {
    for (const sessionId of this.sessionIds) {
      try {
        await this.client.request('session/close', { sessionId }, sessionCloseTimeoutMs)
      } catch {
        // Adapter 已退出或不再响应时，继续使用进程组清理作为 fallback。
      }
    }
    this.client.close()
    await this.process.close()
    if (this.workDir.includes('rolecast-acp-')) {
      await rm(this.workDir, { recursive: true, force: true })
    }
  }
}
