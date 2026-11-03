import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ProviderKind } from '@rolecast/contract'

import { AcpAgentRuntime } from './infrastructure/acp/acp-agent-runtime.js'
import { createCredentialStore } from './infrastructure/credentials/credential-store-factory.js'
import { SecretRedactor } from './infrastructure/credentials/file-credential-store.js'
import { migrateLegacyFileCredentials } from './infrastructure/credentials/legacy-credential-migration.js'
import { InProcessEventBus } from './infrastructure/events/in-process-event-bus.js'
import { CodexConfigImport } from './infrastructure/config/codex-config-import.js'
import { JsonRoleConfigRepository } from './infrastructure/config/json-role-config-repository.js'
import { JsonWorkspaceConfig } from './infrastructure/config/json-workspace-config.js'
import { SqliteDatabase } from './infrastructure/persistence/sqlite-database.js'
import { SqliteRepository } from './infrastructure/persistence/sqlite-repository.js'
import { ConversationService } from './application/conversation/conversation-service.js'
import { CredentialService } from './application/credentials/credential-service.js'
import { PermissionScheduler } from './application/permission/permission-scheduler.js'
import { systemClock } from './application/ports/clock-port.js'
import { ProviderService } from './application/providers/provider-service.js'
import { RoleService } from './application/roles/role-service.js'
import { SessionService } from './application/sessions/session-service.js'
import { WorkspaceService } from './application/workspace/workspace-service.js'
import { createHttpApp } from './http-ws/http-server.js'
import { LocalTokenService } from './http-ws/local-token.js'
import type { IdGeneratorPort, ProviderDefinitionPort, RuntimeEnvironmentPort } from './application/ports/id-generator-port.js'
import { computeAdapterFingerprint } from './infrastructure/acp/adapter-fingerprint.js'

/** composition root 可配置输入。 */
export interface ServerConfig {
  readonly mode: 'development' | 'production'
  readonly databasePath: string
  readonly credentialsDirectory: string
  /** 旧版单文件凭据存储；仅在开发模式启动时尝试迁移。 */
  readonly legacyCredentialsPath: string
  readonly host: '127.0.0.1'
  readonly port: number
  readonly webOrigin: string
  readonly cwd: string
  readonly environment: Readonly<Record<string, string | undefined>>
}

/** Adapter 启动命令和参数。 */
export interface ResolvedAdapterCommand {
  readonly command: string
  readonly args: readonly string[]
}

const adapterPackageEntries: Record<ProviderKind, string> = {
  claude: '@agentclientprotocol/claude-agent-acp/dist/index.js',
  codex: '@agentclientprotocol/codex-acp/dist/index.js',
}
const requireFromServer = createRequire(import.meta.url)

/**
 * @name resolveAdapterCommand
 * @description 解析 Server 自带的 ACP Adapter 入口，或保留用户显式提供的外部命令
 * @param {ProviderKind} providerKind Provider 类型
 * @param {string | undefined} override 外部 Adapter 命令覆盖
 * @return {ResolvedAdapterCommand} 可直接交给 AgentRuntime 的命令和参数
 * @example resolveAdapterCommand('claude', undefined)
 */
export function resolveAdapterCommand(
  providerKind: ProviderKind,
  override: string | undefined,
): ResolvedAdapterCommand {
  if (override !== undefined && override.trim().length > 0) {
    return { command: override, args: [] }
  }
  return {
    command: process.execPath,
    args: [requireFromServer.resolve(adapterPackageEntries[providerKind])],
  }
}

/** 从环境变量读取本地 Server 配置。 */
export function readServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const mode = environment.ROLECAST_ENV === 'production' ? 'production' : 'development'
  const runtimeRoot = resolve(environment.ROLECAST_RUNTIME_DIR ?? '.rolecast/runtime')
  const databasePath = resolve(environment.ROLECAST_DB_PATH ?? `${runtimeRoot}/rolecast.sqlite`)
  return {
    mode,
    databasePath,
    credentialsDirectory: resolve(environment.ROLECAST_CREDENTIALS_DIR ?? `${runtimeRoot}/credentials`),
    legacyCredentialsPath: resolve(environment.ROLECAST_CREDENTIALS_PATH ?? `${runtimeRoot}/credentials.json`),
    host: '127.0.0.1',
    port: parsePort(environment.ROLECAST_PORT),
    webOrigin: environment.ROLECAST_WEB_ORIGIN ?? 'http://127.0.0.1:5173/',
    cwd: resolve(environment.ROLECAST_CWD ?? process.cwd()),
    environment,
  }
}

/** 创建尚未监听端口的完整 Server。 */
export async function buildServer(config: ServerConfig = readServerConfig()): Promise<{
  app: Awaited<ReturnType<typeof createHttpApp>>
  close: () => Promise<void>
  localToken: LocalTokenService
}> {
  await mkdir(dirname(config.databasePath), { recursive: true, mode: 0o700 })
  if (config.mode === 'development') {
    // 旧版单文件 Store 的引用保存在 SQLite 中，必须迁移而不是静默失效。
    await migrateLegacyFileCredentials({
      legacyFilePath: config.legacyCredentialsPath,
      directoryPath: config.credentialsDirectory,
    })
  }
  await mkdir(config.credentialsDirectory, { recursive: true, mode: 0o700 })
  const credentialStore = createCredentialStore({
    mode: config.mode,
    developmentDirectory: config.credentialsDirectory,
  })
  const redactor = new SecretRedactor()

  const database = new SqliteDatabase(config.databasePath)
  const eventBus = new InProcessEventBus()
  const repository = new SqliteRepository(database, eventBus)
  await repository.reconcileUnattachedPermissions(new Date())
  const runtime = new AcpAgentRuntime(credentialStore, redactor)
  const ids: IdGeneratorPort = { next: (prefix) => `${prefix}-${randomUUID()}` }
  const workspaceConfig = new JsonWorkspaceConfig(dirname(config.databasePath))
  const roleConfigRepository = new JsonRoleConfigRepository(workspaceConfig)
  const roleService = new RoleService(roleConfigRepository, repository, ids, systemClock)
  const definitions: ProviderDefinitionPort = {
    get: (providerKind) => {
      const resolved = resolveAdapterCommand(
        providerKind,
        providerKind === 'claude'
          ? config.environment.ROLECAST_CLAUDE_ADAPTER_COMMAND
          : config.environment.ROLECAST_CODEX_ADAPTER_COMMAND,
      )
      return {
        adapterCommand: resolved.command,
        adapterArgs: resolved.args,
        adapterVersion: providerKind === 'claude' ? '0.90.0' : '2.2.2',
        credentialEnvironmentKey: providerKind === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',

      }
    },
    fingerprint: (providerKind) => {
      const resolved = resolveAdapterCommand(
        providerKind,
        providerKind === 'claude'
          ? config.environment.ROLECAST_CLAUDE_ADAPTER_COMMAND
          : config.environment.ROLECAST_CODEX_ADAPTER_COMMAND,
      )
      return computeAdapterFingerprint({
        providerKind,
        command: resolved.command,
        args: resolved.args,
      })
    },
  }
  const runtimeEnvironment: RuntimeEnvironmentPort = {
    cwd: config.cwd,
    environment: config.environment,
    runtimeDirectory: (connectionId) => resolve(dirname(config.databasePath), `provider-${connectionId}`),
  }
  const workspaceService = new WorkspaceService(repository, ids, systemClock)
  const providerService = new ProviderService(
    repository,
    runtime,
    ids,
    systemClock,
    definitions,
    runtimeEnvironment,
    new CodexConfigImport(),
    credentialStore,
  )
  const credentialService = new CredentialService(credentialStore)
  const sessionService = new SessionService(repository, runtime, ids, systemClock, definitions, runtimeEnvironment, roleService)
  // 启动恢复先于 HTTP listen：单个 attachment 失败只收敛自身状态，不阻断启动。
  await sessionService.recover().catch(() => undefined)
  const permissionScheduler = new PermissionScheduler(repository, runtime, systemClock)
  permissionScheduler.start()
  const conversationService = new ConversationService(
    repository,
    runtime,
    sessionService,
    ids,
    systemClock,
    eventBus,
    permissionScheduler,
    redactor,
  )
  const localToken = new LocalTokenService()
  const app = await createHttpApp({
    workspaceService,
    providerService,
    credentialService,
    roleService,
    sessionService,
    conversationService,
    repository,
    eventBus,
    localToken,
  })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) {
      return
    }
    closed = true
    permissionScheduler.stop()
    await app.close()
    await sessionService.closeAll()
    await repository.close()
  }
  return { app, close, localToken }
}

/** 启动本地 Fastify Server。 */
export async function startServer(config: ServerConfig = readServerConfig()): Promise<void> {
  const server = await buildServer(config)
  const shutdown = (): void => {
    void server.close().finally(() => process.exitCode = 0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await server.app.listen({ host: config.host, port: config.port })
  process.stdout.write(`Rolecast Web 入口: ${server.localToken.webEntryUrl(config.webOrigin)}\n`)
}

const parsePort = (value: string | undefined): number => {
  const parsed = value === undefined ? 4317 : Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : 4317
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '未知启动错误'
    process.stderr.write(`Rolecast Server 启动失败: ${message}\n`)
    process.exitCode = 1
  })
}
