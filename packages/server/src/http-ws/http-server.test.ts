import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import {
  apiFailureEnvelopeSchema,
  type CapabilitySnapshot,
  type RuntimeEvent,
} from '@rolecast/contract'

import type {
  AgentRuntimeConnection,
  AgentRuntimePort,
  AgentRuntimeSession,
} from '../application/ports/agent-runtime-port.js'
import { ArtifactService } from '../application/artifacts/artifact-service.js'
import { ConversationService } from '../application/conversation/conversation-service.js'
import { CredentialService } from '../application/credentials/credential-service.js'
import { MailboxService } from '../application/mailbox/mailbox-service.js'
import { PermissionScheduler } from '../application/permission/permission-scheduler.js'
import type { CredentialStorePort } from '../application/ports/credential-store-port.js'
import type { WorkspaceRootPathPort } from '../application/ports/workspace-root-path-port.js'
import {
  CredentialDeniedError,
  CredentialIdempotencyConflictError,
  CredentialInvalidError,
  CredentialNotFoundError,
  CredentialStoreUnavailableError,
  isCredentialValueValid,
} from '../application/ports/credential-store-port.js'

import { systemClock } from '../application/ports/clock-port.js'
import type { CapabilityDiscoveryPort } from '../application/ports/capability-discovery-port.js'
import { ProviderService } from '../application/providers/provider-service.js'
import { RoleService } from '../application/roles/role-service.js'
import { SessionService } from '../application/sessions/session-service.js'
import { WorkspaceService } from '../application/workspace/workspace-service.js'
import { CodexConfigImport } from '../infrastructure/config/codex-config-import.js'
import { SecretRedactor } from '../infrastructure/credentials/file-credential-store.js'
import { InProcessEventBus } from '../infrastructure/events/in-process-event-bus.js'
import { JsonRoleConfigRepository } from '../infrastructure/config/json-role-config-repository.js'
import { JsonWorkspaceConfig } from '../infrastructure/config/json-workspace-config.js'
import { SqliteDatabase } from '../infrastructure/persistence/sqlite-database.js'
import { SqliteArtifactStore } from '../infrastructure/persistence/sqlite-artifact-store.js'
import { SqliteMailboxStore } from '../infrastructure/persistence/sqlite-mailbox-store.js'
import { SqliteRepository } from '../infrastructure/persistence/sqlite-repository.js'
import { createHttpApp } from './http-server.js'
import { LocalTokenService } from './local-token.js'

class TestIds {
  private sequence = 0

  next(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }
}

class TestRuntime implements AgentRuntimePort, CapabilityDiscoveryPort {
  readonly contexts: unknown[] = []

  constructor(private readonly connectionError?: Error) {}

  private readonly connection: AgentRuntimeConnection = {
    connectionId: 'connection-001',
    providerKind: 'claude',
    adapterVersion: 'test',
    capabilities: {
      provider_kind: 'claude',
      adapter_version: 'test',
      source: 'manual',
      observed_at: '2026-10-14T10:00:00.000Z',
      capabilities: { models: ['test-model'] },
    },
  }

  async connect(): Promise<AgentRuntimeConnection> {
    if (this.connectionError !== undefined) {
      throw this.connectionError
    }
    return this.connection
  }

  async createSession(connection: AgentRuntimeConnection): Promise<AgentRuntimeSession> {
    return {
      sessionId: 'acp-session-001',
      connection,
      configOptions: [{
        id: 'model',
        category: 'model',
        currentValue: 'test-model',
        options: [{ value: 'test-model', name: 'Test Model' }],
      }],
    }
  }

  async *sendTurn(input: { session: AgentRuntimeSession; contextBundle?: unknown }): AsyncIterable<RuntimeEvent> {
    this.contexts.push(input.contextBundle)
    yield {
      session_id: 'acp-session-001',
      kind: 'agent_message_chunk',
      payload: { content: { type: 'text', text: '收到' } },
    }
    yield {
      session_id: 'acp-session-001',
      kind: 'turn_completed',
      payload: {},
    }
  }

  async respondPermission(): Promise<void> {}
  async cancelTurn(): Promise<void> {}
  async resumeSession(): Promise<AgentRuntimeSession> {
    return this.createSession(this.connection)
  }
  async closeSession(): Promise<void> {}
  async closeConnection(): Promise<void> {}

  async discover(): Promise<CapabilitySnapshot> {
    return this.connection.capabilities
  }
}

/** 内存凭据实现，语义与真实 Store 一致：同键同值幂等，同键异值冲突。 */
class TestCredentialStore implements CredentialStorePort {
  readonly saves: Array<{ operationKey: string; secret: string }> = []
  private readonly values = new Map<string, string>()

  async save(operationKey: string, secret: string): Promise<string> {
    this.saves.push({ operationKey, secret })
    if (!isCredentialValueValid(secret)) {
      throw new CredentialInvalidError()
    }
    const reference = `credential-${operationKey}`
    const existing = this.values.get(reference)
    if (existing !== undefined) {
      if (existing !== secret) {
        throw new CredentialIdempotencyConflictError(reference)
      }
      return reference
    }
    this.values.set(reference, secret)
    return reference
  }

  async get(reference: string): Promise<string | null> {
    return this.values.get(reference) ?? null
  }

  async validate(reference: string): Promise<boolean> {
    return this.values.has(reference)
  }

  async rotate(reference: string, secret: string): Promise<void> {
    if (!this.values.has(reference)) {
      throw new CredentialNotFoundError()
    }
    this.values.set(reference, secret)
  }

  async delete(reference: string): Promise<void> {
    this.values.delete(reference)
  }
}

/** 始终不可用的凭据实现，用于验证 503 映射。 */
class UnavailableCredentialStore implements CredentialStorePort {
  async save(): Promise<string> {
    throw new CredentialStoreUnavailableError()
  }

  async get(): Promise<string | null> {
    throw new CredentialStoreUnavailableError()
  }

  async validate(): Promise<boolean> {
    throw new CredentialStoreUnavailableError()
  }

  async rotate(): Promise<void> {
    throw new CredentialStoreUnavailableError()
  }

  async delete(): Promise<void> {
    throw new CredentialStoreUnavailableError()
  }
}

async function createTestApp(
  capabilityDiscovery?: CapabilityDiscoveryPort,
  configImportRoot?: string,
  runtimeError?: Error,
  credentialStore: CredentialStorePort = new TestCredentialStore(),
  rootPathPort: WorkspaceRootPathPort = {
    resolveExistingDirectory: async (path: string): Promise<string> => path,
  },
): Promise<{
  app: Awaited<ReturnType<typeof createHttpApp>>
  token: LocalTokenService
  repository: SqliteRepository
  database: SqliteDatabase
  conversationService: ConversationService
  credentialStore: CredentialStorePort
  runtime: TestRuntime
}> {
  const database = new SqliteDatabase(':memory:')
  const repository = new SqliteRepository(database)
  const ids = new TestIds()
  const runtime = new TestRuntime(runtimeError)
  const environment = {
    cwd: process.cwd(),
    environment: {},
    runtimeDirectory: (connectionId: string) => `/tmp/rolecast-${connectionId}`,
  }
  const definitions = {
    get: () => ({ adapterCommand: 'test-adapter', adapterArgs: [], adapterVersion: 'test' }),
  }
  const workspaceService = new WorkspaceService(repository, ids, systemClock, rootPathPort)
  const roleConfigRepository = new JsonRoleConfigRepository(
    new JsonWorkspaceConfig(join(tmpdir(), `rolecast-http-${randomUUID()}`)),
  )
  const roleService = new RoleService(roleConfigRepository, repository, ids, systemClock)
  const providerService = new ProviderService(
    repository,
    capabilityDiscovery ?? runtime,
    ids,
    systemClock,
    definitions,
    environment,
    new CodexConfigImport(configImportRoot),
  )

  const sessionService = new SessionService(repository, runtime, ids, systemClock, definitions, environment, roleService)
  const eventBus = new InProcessEventBus()
  const permissionScheduler = new PermissionScheduler(repository, runtime, systemClock)
  const redactor = new SecretRedactor()
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
  const artifactService = new ArtifactService(
    repository,
    new SqliteArtifactStore(database),
    rootPathPort,
    redactor,
    ids,
    systemClock,
    eventBus,
  )
  const token = new LocalTokenService('test-local-token')
  const app = await createHttpApp({
    artifactService,
    mailboxService: new MailboxService(new SqliteMailboxStore(database), ids, systemClock, eventBus),
    workspaceService,
    providerService,
    credentialService: new CredentialService(credentialStore),
    roleService,
    sessionService,
    conversationService,
    repository,
    eventBus,
    localToken: token,
  })
  return { app, token, repository, database, conversationService, credentialStore, runtime }
}

describe('HTTP 控制面', () => {
  it('Artifact 创建路由拒绝缺字段请求并返回统一校验错误', async () => {
    const { app, token, repository } = await createTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/artifacts',
      headers: { authorization: `Bearer ${token.value()}` },
      payload: {},
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    await app.close()
    await repository.close()
  })

  it('Artifact 跨 Session metadata/content 读取统一隐藏为 artifact_unavailable', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const metadata = await app.inject({
      method: 'GET',
      url: '/api/sessions/other-session/artifacts/artifact-1',
      headers,
    })
    const content = await app.inject({
      method: 'GET',
      url: '/api/sessions/other-session/artifacts/artifact-1/content',
      headers,
    })

    expect(metadata.statusCode).toBe(404)
    expect(metadata.json()).toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } })
    expect(content.statusCode).toBe(404)
    expect(content.json()).toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } })
    await app.close()
    await repository.close()
  })

  it('创建 inline Artifact、分离读取正文并幂等重放', async () => {
    const { app, token, repository, database, conversationService } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspace = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { name: 'Artifact HTTP 测试', root_path: '/tmp/rolecast-artifact-http-root' },
    })
    const workspaceId = workspace.json().data.id as string
    const provider = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/providers`,
      headers,
      payload: { provider_kind: 'claude', connection_kind: 'local', environment_mode: 'inherited' },
    })
    const providerId = provider.json().data.id as string
    await app.inject({ method: 'POST', url: `/api/providers/${providerId}/discover`, headers })
    const session = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/sessions`,
      headers,
      payload: { name: 'Artifact 来源', provider_connection_id: providerId, model_id: 'test-model' },
    })
    const sessionId = session.json().data.session.id as string
    const message = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      headers,
      payload: { content: '请生成 Artifact 来源文本' },
    })
    const runId = message.json().data.run.id as string
    await conversationService.waitForTurn(runId)

    const createPayload = { source_run_id: runId, request_id: 'artifact-http-create-001' }
    const created = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/artifacts`,
      headers,
      payload: createPayload,
    })
    expect(created.statusCode).toBe(201)
    const artifact = created.json().data as { id: string; size_bytes: number; sha256: string }
    expect(artifact).toMatchObject({ size_bytes: 6 })
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(created.json().data).not.toHaveProperty('content')
    expect(created.json().data).not.toHaveProperty('content_ref')

    const metadata = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/artifacts/${artifact.id}`,
      headers,
    })
    const content = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/artifacts/${artifact.id}/content`,
      headers,
    })
    expect(metadata.json().data.id).toBe(artifact.id)
    expect(metadata.json().data).not.toHaveProperty('content')
    expect(content.json().data).toMatchObject({ artifact_id: artifact.id, content: '收到' })

    const listed = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/artifacts?limit=1`,
      headers,
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().data).toMatchObject({ items: [{ id: artifact.id }], next_cursor: null })
    expect(listed.json().data.items[0]).not.toHaveProperty('content')
    const invalidCursor = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/artifacts?cursor=not-an-artifact`,
      headers,
    })
    expect(invalidCursor.statusCode).toBe(404)
    expect(invalidCursor.json()).toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } })
    const missingSession = await app.inject({
      method: 'GET',
      url: '/api/sessions/missing-session/artifacts',
      headers,
    })
    expect(missingSession.statusCode).toBe(404)
    expect(missingSession.json()).toMatchObject({ ok: false, error: { code: 'not_found' } })
    const invalidLimit = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/artifacts?limit=101`,
      headers,
    })
    expect(invalidLimit.statusCode).toBe(400)
    expect(invalidLimit.json()).toMatchObject({ ok: false, error: { code: 'invalid_request' } })

    const replay = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/artifacts`,
      headers,
      payload: createPayload,
    })
    expect(replay.statusCode).toBe(201)
    expect(replay.json().data.id).toBe(artifact.id)
    const otherSession = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/sessions`,
      headers,
      payload: { name: '其他 Artifact Session', provider_connection_id: providerId, model_id: 'test-model' },
    })
    const hiddenContent = await app.inject({
      method: 'GET',
      url: `/api/sessions/${otherSession.json().data.session.id}/artifacts/${artifact.id}/content`,
      headers,
    })
    expect(hiddenContent.statusCode).toBe(404)
    expect(hiddenContent.json()).toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } })

    const artifactCount = database.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as { count: number }
    const events = await repository.replayEvents(runId, 0)
    expect(artifactCount.count).toBe(1)
    expect(events.filter((event) => event.type === 'artifact.created')).toHaveLength(1)
    await app.close()
    await repository.close()
  })

  it('健康检查无需 Token，REST 其他接口必须认证', async () => {
    const { app, token, repository } = await createTestApp()
    await expect(app.inject({ method: 'GET', url: '/healthz' })).resolves.toMatchObject({ statusCode: 200 })
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/workspaces' })
    expect(unauthenticated.statusCode).toBe(401)
    expect(unauthenticated.json()).toMatchObject({ ok: false, error: { code: 'unauthorized' } })

    const authenticated = await app.inject({
      method: 'GET',
      url: '/api/workspaces?token=must-not-authenticate',
      headers: { authorization: `Bearer ${token.value()}` },
    })
    expect(authenticated.statusCode).toBe(200)
    await app.close()
    await repository.close()
  })

  it('拒绝非本地 Host/Origin，并返回统一错误信封', async () => {
    const { app, token, repository } = await createTestApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/workspaces',
      headers: {
        host: 'evil.example.test',
        origin: 'https://evil.example.test',
        authorization: `Bearer ${token.value()}`,
      },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    await app.close()
    await repository.close()
  })

  it('新建 Workspace 缺少 root_path 时返回稳定 422 且不写入', async () => {
    const { app, token, repository } = await createTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: { authorization: `Bearer ${token.value()}` },
      payload: { name: '缺少根路径' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'workspace_root_required' } })
    await expect(repository.listWorkspaces()).resolves.toHaveLength(0)
    await app.close()
    await repository.close()
  })

  it('新建 Workspace 显式提交空字符串根路径时返回 422 workspace_root_invalid 且不写入', async () => {
    const { app, token, repository } = await createTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: { authorization: `Bearer ${token.value()}` },
      payload: { name: '空根路径', root_path: '' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'workspace_root_invalid' } })
    await expect(repository.listWorkspaces()).resolves.toHaveLength(0)
    await app.close()
    await repository.close()
  })

  it('创建 Workspace 后读取独立 canonical root-path DTO，并拒绝重复路径', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const rootPath = '/tmp/rolecast-http-root-path'
    const created = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { name: '配置根路径', root_path: rootPath },
    })
    const workspaceId = created.json().data.id as string

    const rootPathResponse = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/root-path`,
      headers,
    })
    expect(rootPathResponse.statusCode).toBe(200)
    expect(rootPathResponse.json()).toMatchObject({
      ok: true,
      data: { workspace_id: workspaceId, root_path: rootPath },
    })

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { name: '重复根路径', root_path: rootPath },
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toMatchObject({ ok: false, error: { code: 'workspace_root_duplicate' } })
    expect(duplicate.body).not.toContain(rootPath)
    await expect(repository.listWorkspaces()).resolves.toHaveLength(1)
    await app.close()
    await repository.close()
  })

  it('旧 Workspace GET 返回 null，且 root-path 只能补设一次', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceId = 'legacy-workspace'
    await repository.createWorkspace({
      id: workspaceId,
      name: '旧 Workspace',
      created_at: '2026-11-04T00:00:00.000Z',
      updated_at: '2026-11-04T00:00:00.000Z',
    })

    const initial = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/root-path`,
      headers,
    })
    expect(initial.statusCode).toBe(200)
    expect(initial.json()).toMatchObject({ ok: true, data: { workspace_id: workspaceId, root_path: null } })

    const configuredPath = '/tmp/rolecast-legacy-root-path'
    const configured = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/root-path`,
      headers,
      payload: { root_path: configuredPath },
    })
    expect(configured.statusCode).toBe(200)
    expect(configured.json()).toMatchObject({
      ok: true,
      data: { workspace_id: workspaceId, root_path: configuredPath },
    })

    const overwrite = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/root-path`,
      headers,
      payload: { root_path: '/tmp/rolecast-forbidden-overwrite' },
    })
    expect(overwrite.statusCode).toBe(409)
    expect(overwrite.json()).toMatchObject({
      ok: false,
      error: { code: 'workspace_root_already_configured' },
    })
    const finalState = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/root-path`,
      headers,
    })
    expect(finalState.json().data.root_path).toBe(configuredPath)
    await app.close()
    await repository.close()
  })

  it('补设显式空字符串根路径时返回 422 workspace_root_invalid 且保持未配置', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceId = 'legacy-workspace'
    await repository.createWorkspace({
      id: workspaceId,
      name: '旧 Workspace',
      created_at: '2026-11-04T00:00:00.000Z',
      updated_at: '2026-11-04T00:00:00.000Z',
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/root-path`,
      headers,
      payload: { root_path: '' },
    })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'workspace_root_invalid' } })

    const state = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/root-path`,
      headers,
    })
    expect(state.json()).toMatchObject({ ok: true, data: { workspace_id: workspaceId, root_path: null } })
    await app.close()
    await repository.close()
  })

  it('未知 Workspace 的 root-path GET 和 POST 返回 404 且不写入', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/workspaces/missing-workspace/root-path',
      headers,
    })
    const postResponse = await app.inject({
      method: 'POST',
      url: '/api/workspaces/missing-workspace/root-path',
      headers,
      payload: { root_path: '/tmp/rolecast-missing-workspace-root' },
    })

    expect(getResponse.statusCode).toBe(404)
    expect(getResponse.json()).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(postResponse.statusCode).toBe(404)
    expect(postResponse.json()).toMatchObject({ ok: false, error: { code: 'not_found' } })
    await expect(repository.listWorkspaces()).resolves.toHaveLength(0)
    await app.close()
    await repository.close()
  })

  it('root-path 路由继续要求有效 Local Token', async () => {
    const { app, repository } = await createTestApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/workspaces/legacy-workspace/root-path',
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    await app.close()
    await repository.close()
  })

  it('root-path 写入仍受 Host/Origin 保护', async () => {
    const { app, token, repository } = await createTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces/legacy-workspace/root-path',
      headers: {
        host: 'evil.example.test',
        origin: 'https://evil.example.test',
        authorization: `Bearer ${token.value()}`,
      },
      payload: { root_path: '/tmp/rolecast-forbidden-root' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    await expect(repository.listWorkspaces()).resolves.toHaveLength(0)
    await app.close()
    await repository.close()
  })

  it('根路径验证失败映射为稳定 422，且不回显路径或部分写入', async () => {
    const rootPathPort: WorkspaceRootPathPort = {
      resolveExistingDirectory: async () => {
        throw new Error('private filesystem detail')
      },
    }
    const { app, token, repository } = await createTestApp(undefined, undefined, undefined, undefined, rootPathPort)
    const inputPath = '/private/user/path-do-not-echo'
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: { authorization: `Bearer ${token.value()}` },
      payload: { name: '无效根路径', root_path: inputPath },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'workspace_root_invalid' } })
    expect(response.body).not.toContain(inputPath)
    expect(response.body).not.toContain('private filesystem detail')
    await expect(repository.listWorkspaces()).resolves.toHaveLength(0)
    await app.close()
    await repository.close()
  })

  it('PATCH Provider 只接受非秘密字段并返回更新后的连接', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceResponse = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { name: '更新工作区', root_path: '/tmp/rolecast-http-test-root' },
    })
    const workspaceId = workspaceResponse.json().data.id as string
    const providerResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/providers`,
      headers,
      payload: { provider_kind: 'claude', connection_kind: 'local', environment_mode: 'inherited' },
    })
    const providerId = providerResponse.json().data.id as string

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/providers/${providerId}`,
      headers,
      payload: {
        connection_kind: 'custom_endpoint',
        base_url: 'https://gateway.example.test/v1',
        config_revision: 1,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        connection_kind: 'custom_endpoint',
        base_url: 'https://gateway.example.test/v1',
        config_revision: 2,
      },
    })
    await app.close()
    await repository.close()
  })

  it('PATCH 用 null 清除 custom_endpoint 的 base_url 后可切换为 api_key', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceId = (await app.inject({
      method: 'POST', url: '/api/workspaces', headers, payload: { name: '清除 URL 工作区', root_path: '/tmp/rolecast-http-test-root' },
    })).json().data.id as string
    const providerId = (await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/providers`,
      headers,
      payload: {
        provider_kind: 'claude',
        connection_kind: 'custom_endpoint',
        base_url: 'https://gateway.example.test/v1',
        environment_mode: 'inherited',
      },
    })).json().data.id as string

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/providers/${providerId}`,
      headers,
      payload: {
        connection_kind: 'api_key',
        environment_mode: 'inherited',
        base_url: null,
        config_revision: 1,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({ connection_kind: 'api_key', config_revision: 2 })
    expect(response.json().data.base_url).toBeUndefined()
    await app.close()
    await repository.close()
  })

  it('PATCH 用 null 清除引用后可切换到 inherited local', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceId = (await app.inject({
      method: 'POST', url: '/api/workspaces', headers, payload: { name: '清除引用工作区', root_path: '/tmp/rolecast-http-test-root' },
    })).json().data.id as string
    // 直接落一条 isolated api_key 记录（引用为合成值，非真实凭据）。
    const created = await repository.createProviderConnection({
      id: 'provider-seeded',
      workspace_id: workspaceId,
      provider_kind: 'claude',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      config_revision: 1,
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/providers/${created.id}`,
      headers,
      payload: {
        connection_kind: 'local',
        environment_mode: 'inherited',
        credential_ref: null,
        config_revision: 1,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({ connection_kind: 'local', environment_mode: 'inherited' })
    expect(response.json().data.credential_ref).toBeUndefined()
    await app.close()
    await repository.close()
  })

  it('PATCH Provider 拒绝 Secret 形状字段与过期 revision', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceResponse = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { name: '更新拒绝工作区', root_path: '/tmp/rolecast-http-test-root' },
    })
    const workspaceId = workspaceResponse.json().data.id as string
    const providerResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/providers`,
      headers,
      payload: { provider_kind: 'claude', connection_kind: 'local', environment_mode: 'inherited' },
    })
    const providerId = providerResponse.json().data.id as string

    const secretPayload = await app.inject({
      method: 'PATCH',
      url: `/api/providers/${providerId}`,
      headers,
      payload: { api_key: 'not-a-real-secret', config_revision: 1 },
    })
    expect(secretPayload.statusCode).toBe(400)
    expect(secretPayload.body).not.toContain('not-a-real-secret')

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/providers/${providerId}`,
      headers,
      payload: { connection_kind: 'api_key', config_revision: 99 },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ ok: false, error: { code: 'state_conflict' } })

    await app.close()
    await repository.close()
  })

  it('Run 命令路由要求 request_id 并对未知 Run 返回 404', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }

    const missing = await app.inject({
      method: 'POST', url: '/api/runs/run-missing/cancel', headers, payload: {},
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toMatchObject({ ok: false, error: { code: 'invalid_request' } })

    const notFound = await app.inject({
      method: 'POST', url: '/api/runs/run-missing/cancel', headers, payload: { request_id: 'req-1' },
    })
    expect(notFound.statusCode).toBe(404)
    expect(notFound.json()).toMatchObject({ ok: false, error: { code: 'not_found' } })

    await app.close()
    await repository.close()
  })

  it('将 Adapter 的非稳定 error.code 收敛为 internal_error', async () => {
    const discovery: CapabilityDiscoveryPort = {
      discover: async () => {
        throw Object.assign(new Error('adapter executable missing'), { code: 'ENOENT' })
      },
    }
    const { app, token, repository } = await createTestApp(discovery)
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceResponse = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { name: '错误映射测试', root_path: '/tmp/rolecast-http-test-root' },
    })
    const workspaceId = workspaceResponse.json().data.id as string
    const providerResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/providers`,
      headers,
      payload: {
        provider_kind: 'claude',
        connection_kind: 'local',
        environment_mode: 'inherited',
      },
    })
    const providerId = providerResponse.json().data.id as string
    const response = await app.inject({
      method: 'POST',
      url: `/api/providers/${providerId}/test`,
      headers,
    })

    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('adapter executable missing')
    expect(() => apiFailureEnvelopeSchema.parse(response.json())).not.toThrow()
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: 'internal_error', message: '服务内部错误', details: {} },
    })
    await app.close()
    await repository.close()
  })

  it('Codex custom endpoint 经 HTTP 返回未证错误且响应不含合成 Secret', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceResponse = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { name: '未证组合工作区', root_path: '/tmp/rolecast-http-test-root' },
    })
    const workspaceId = workspaceResponse.json().data.id as string
    const providerResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/providers`,
      headers,
      payload: {
        provider_kind: 'codex',
        connection_kind: 'custom_endpoint',
        base_url: 'https://gateway.example.test/v1',
        environment_mode: 'inherited',
      },
    })
    const providerId = providerResponse.json().data.id as string
    const response = await app.inject({
      method: 'POST',
      url: `/api/providers/${providerId}/test`,
      headers,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: 'codex_custom_endpoint_unverified' },
    })
    expect(() => apiFailureEnvelopeSchema.parse(response.json())).not.toThrow()
    expect(response.body).not.toContain('synthetic-')
    await app.close()
    await repository.close()
  })

  it('custom_endpoint 缺少 base_url 经 HTTP 返回结构化 422', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceResponse = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { name: '缺 URL 工作区', root_path: '/tmp/rolecast-http-test-root' },
    })
    const workspaceId = workspaceResponse.json().data.id as string
    const response = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/providers`,
      headers,
      payload: {
        provider_kind: 'claude',
        connection_kind: 'custom_endpoint',
        environment_mode: 'inherited',
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    await app.close()
    await repository.close()
  })

  it('将 Runtime 的凭据拒绝映射为 403 credential_denied', async () => {
    const runtimeError = Object.assign(new Error('Keychain access denied'), { code: 'credential_denied' })
    const { app, token, repository } = await createTestApp(undefined, undefined, runtimeError)
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceResponse = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { name: '凭据拒绝映射测试', root_path: '/tmp/rolecast-http-test-root' },
    })
    const workspaceId = workspaceResponse.json().data.id as string
    const providerResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/providers`,
      headers,
      payload: {
        provider_kind: 'claude',
        connection_kind: 'local',
        environment_mode: 'inherited',
      },
    })
    const providerId = providerResponse.json().data.id as string

    const response = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/sessions`,
      headers,
      payload: { name: '拒绝的会话', provider_connection_id: providerId, model_id: 'test-model' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'credential_denied' } })
    expect(response.body).not.toContain('Keychain access denied')
    await app.close()
    await repository.close()
  })

  it('完成 Workspace、Provider、Session 创建并提供综合快照', async () => {
    const { app, token, repository, conversationService } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceResponse = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { name: '测试工作区', root_path: '/tmp/rolecast-http-test-root' },
    })
    expect(workspaceResponse.statusCode).toBe(201)
    const workspaceId = workspaceResponse.json().data.id as string
    const providerResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/providers`,
      headers,
      payload: {
        provider_kind: 'claude',
        connection_kind: 'local',
        environment_mode: 'inherited',
      },
    })
    expect(providerResponse.statusCode).toBe(201)
    const providerId = providerResponse.json().data.id as string
    const sessionResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/sessions`,
      headers,
      payload: { name: '第一次对话', provider_connection_id: providerId, model_id: 'test-model' },
    })
    expect(sessionResponse.statusCode).toBe(201)
    const sessionId = sessionResponse.json().data.session.id as string
    const snapshot = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/snapshot`,
      headers,
    })
    expect(snapshot.statusCode).toBe(200)
    expect(snapshot.json().data.agent_slots).toHaveLength(1)
    const messageResponse = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      headers,
      payload: { content: '请回复我' },
    })
    expect(messageResponse.statusCode).toBe(202)
    await conversationService.waitForTurn(messageResponse.json().data.run.id as string)
    const completedSnapshot = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/snapshot`,
      headers,
    })
    expect(completedSnapshot.json().data.runs[0].status).toBe('completed')
    expect(completedSnapshot.json().data.messages.at(-1).content).toBe('收到')
    await app.close()
    await repository.close()
  })

  it('通过 RoleBinding 创建 Session 的唯一初始 Slot 并拒绝混合请求', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceResponse = await app.inject({
      method: 'POST', url: '/api/workspaces', headers, payload: { name: '绑定初始 Slot', root_path: '/tmp/rolecast-http-test-root' },
    })
    const workspaceId = workspaceResponse.json().data.id as string
    const providerResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/providers`,
      headers,
      payload: { provider_kind: 'claude', connection_kind: 'local', environment_mode: 'inherited' },
    })
    const providerId = providerResponse.json().data.id as string
    await app.inject({ method: 'POST', url: `/api/providers/${providerId}/discover`, headers })
    const roleResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/roles`,
      headers,
      payload: {
        name: '初始执行者',
        system_prompt: '只作为私有快照保存',
        required_guidelines: ['遵循任务范围'],
        output_contract: '给出结果',
        selectable: true,
        dispatchable: true,
      },
    })
    const roleId = roleResponse.json().data.id as string
    const bindingResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/bindings`,
      headers,
      payload: { role_id: roleId, provider_connection_id: providerId, model_id: 'test-model' },
    })
    const bindingId = bindingResponse.json().data.id as string

    const created = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/sessions`,
      headers,
      payload: { name: '绑定 Session', role_binding_id: bindingId },
    })
    expect(created.statusCode).toBe(201)
    const sessionId = created.json().data.session.id as string
    const snapshot = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
    expect(snapshot.statusCode).toBe(200)
    expect(snapshot.json().data.agent_slots).toHaveLength(1)
    expect(snapshot.json().data.agent_slots[0]).toMatchObject({ role_binding_id: bindingId, model_id: 'test-model' })
    expect(JSON.stringify(snapshot.json().data)).not.toContain('只作为私有快照保存')

    const mixed = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/sessions`,
      headers,
      payload: {
        name: '混合请求',
        role_binding_id: bindingId,
        provider_connection_id: providerId,
        model_id: 'test-model',
      },
    })
    expect(mixed.statusCode).toBe(400)
    await expect(repository.listSessions(workspaceId)).resolves.toHaveLength(1)
    await app.close()
    await repository.close()
  })

  it('使用 Workspace RoleBinding 为 Session 创建额外 AgentSlot', async () => {
    const { app, token, repository, conversationService, runtime } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceResponse = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { name: '多 Slot 测试', root_path: '/tmp/rolecast-http-test-root' },
    })
    const workspaceId = workspaceResponse.json().data.id as string
    const providerResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/providers`,
      headers,
      payload: { provider_kind: 'claude', connection_kind: 'local', environment_mode: 'inherited' },
    })
    const providerId = providerResponse.json().data.id as string
    await app.inject({ method: 'POST', url: `/api/providers/${providerId}/discover`, headers })

    const roleResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/roles`,
      headers,
      payload: {
        name: '审查者',
        system_prompt: '指出可复现的问题。',
        required_guidelines: ['只报告有证据的问题'],
        output_contract: '给出文件和行号',
        selectable: true,
        dispatchable: true,
      },
    })
    const role = roleResponse.json().data as { id: string; version: number }
    const bindingResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/bindings`,
      headers,
      payload: { role_id: role.id, provider_connection_id: providerId, model_id: 'test-model' },
    })
    const binding = bindingResponse.json().data as { id: string }
    const sessionResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/sessions`,
      headers,
      payload: { name: '多 Slot Session', provider_connection_id: providerId, model_id: 'test-model' },
    })
    const sessionId = sessionResponse.json().data.session.id as string

    const addedSlot = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/agents`,
      headers,
      payload: { role_binding_id: binding.id, request_id: 'add-slot-idempotency' },
    })

    expect(addedSlot.statusCode).toBe(201)
    expect(addedSlot.json().data).toMatchObject({ role_binding_id: binding.id, model_id: 'test-model' })
    const addedSlotId = addedSlot.json().data.id as string
    const replayAdd = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/agents`,
      headers,
      payload: { role_binding_id: binding.id, request_id: 'add-slot-idempotency' },
    })
    expect(replayAdd.statusCode).toBe(201)
    expect(replayAdd.json().data.id).toBe(addedSlotId)
    const conflictingAdd = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/agents`,
      headers,
      payload: { role_binding_id: 'binding-other', request_id: 'add-slot-idempotency' },
    })
    expect(conflictingAdd.statusCode).toBe(409)
    expect(conflictingAdd.json()).toMatchObject({ ok: false, error: { code: 'state_conflict' } })
    const roleUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/roles/${role.id}`,
      headers,
      payload: {
        version: role.version,
        system_prompt: '只关注后续新增的 Slot。',
        required_guidelines: ['这是新版本规则'],
        output_contract: '新版本输出合同',
      },
    })
    expect(roleUpdate.statusCode).toBe(200)
    const snapshot = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
    expect(snapshot.json().data.agent_slots).toHaveLength(2)
    const defaultSlotId = snapshot.json().data.agent_slots.find((slot: { role_binding_id?: string }) =>
      slot.role_binding_id === undefined).id as string

    const targetedMessage = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      headers,
      payload: { content: '审查这段实现', request_id: 'target-slot-request', agent_slot_id: addedSlotId },
    })
    expect(targetedMessage.statusCode).toBe(202)
    expect(targetedMessage.json().data.task.slot_id).toBe(addedSlotId)
    await conversationService.waitForTurn(targetedMessage.json().data.run.id as string)
    const context = runtime.contexts.at(-1) as {
      system_instructions: string
      task_input: string
      output_contract: string
    } | undefined
    expect(context?.system_instructions).toContain('指出可复现的问题。')
    expect(context?.system_instructions).toContain('只报告有证据的问题')
    expect(context?.system_instructions).not.toContain('这是新版本规则')
    expect(context?.task_input).toBe('审查这段实现')
    expect(context?.output_contract).toBe('给出文件和行号')
    expect(context?.output_contract).not.toBe('新版本输出合同')
    const finalSnapshot = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
    expect(finalSnapshot.json().data.messages.map((message: { content: string }) => message.content))
      .toContain('审查这段实现')
    const replay = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      headers,
      payload: { content: '审查这段实现', request_id: 'target-slot-request', agent_slot_id: addedSlotId },
    })
    expect(replay.statusCode).toBe(202)
    expect(replay.json().data.run.id).toBe(targetedMessage.json().data.run.id)
    const wrongTarget = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      headers,
      payload: { content: '审查这段实现', request_id: 'target-slot-request', agent_slot_id: defaultSlotId },
    })
    expect(wrongTarget.statusCode).toBe(409)
    expect(wrongTarget.json()).toMatchObject({ ok: false, error: { code: 'state_conflict' } })
    expect(runtime.contexts).toHaveLength(1)
    const otherSessionResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/sessions`,
      headers,
      payload: { name: '其他会话', provider_connection_id: providerId, model_id: 'test-model' },
    })
    const otherSessionId = otherSessionResponse.json().data.session.id as string
    const crossSessionDelete = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${otherSessionId}/agents/${addedSlotId}`,
      headers,
    })
    expect(crossSessionDelete.statusCode).toBe(404)
    expect(crossSessionDelete.json()).toMatchObject({ ok: false, error: { code: 'not_found' } })
    const deletedSlot = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/agents/${addedSlotId}`,
      headers,
    })
    expect(deletedSlot.statusCode).toBe(200)
    expect(deletedSlot.json()).toMatchObject({ ok: true, data: null })
    const deleteReplay = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/agents/${addedSlotId}`,
      headers,
    })
    expect(deleteReplay.statusCode).toBe(200)
    const afterDelete = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
    expect(afterDelete.json().data.agent_slots.map((slot: { id: string }) => slot.id)).not.toContain(addedSlotId)
    const deleteDefault = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/agents/${defaultSlotId}`,
      headers,
    })
    expect(deleteDefault.statusCode).toBe(409)
    expect(deleteDefault.json()).toMatchObject({ ok: false, error: { code: 'state_conflict' } })
    await app.close()
    await repository.close()
  })

  it('完成 Role/RoleBinding CRUD，并拒绝版本冲突和悬空 Role', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const workspaceResponse = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { name: 'Role 配置测试', root_path: '/tmp/rolecast-http-test-root' },
    })
    const workspaceId = workspaceResponse.json().data.id as string
    const providerResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/providers`,
      headers,
      payload: { provider_kind: 'claude', connection_kind: 'local', environment_mode: 'inherited' },
    })
    const providerId = providerResponse.json().data.id as string
    await app.inject({ method: 'POST', url: `/api/providers/${providerId}/discover`, headers })

    const roleResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/roles`,
      headers,
      payload: { name: '执行者', dispatchable: true },
    })
    expect(roleResponse.statusCode).toBe(201)
    const role = roleResponse.json().data as { id: string; version: number }
    const roles = await app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/roles`, headers })
    expect(roles.statusCode).toBe(200)
    expect(roles.json().data).toHaveLength(1)

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/roles/${role.id}`,
      headers,
      payload: { version: role.version, name: '审查者' },
    })
    expect(updateResponse.statusCode).toBe(200)
    const updatedRole = updateResponse.json().data as { version: number }
    const staleUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/roles/${role.id}`,
      headers,
      payload: { version: role.version, name: '过期更新' },
    })
    expect(staleUpdate.statusCode).toBe(409)
    expect(staleUpdate.json()).toMatchObject({ ok: false, error: { code: 'state_conflict' } })

    const bindingResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/bindings`,
      headers,
      payload: {
        role_id: role.id,
        provider_connection_id: providerId,
        model_id: 'test-model',
      },
    })
    expect(bindingResponse.statusCode).toBe(201)
    const binding = bindingResponse.json().data as { id: string; version: number }
    const blockedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/roles/${role.id}?version=${updatedRole.version}`,
      headers,
    })
    expect(blockedDelete.statusCode).toBe(409)
    expect(blockedDelete.json()).toMatchObject({ ok: false, error: { code: 'resource_in_use' } })

    const bindingDelete = await app.inject({
      method: 'DELETE',
      url: `/api/bindings/${binding.id}?version=${binding.version}`,
      headers,
    })
    expect(bindingDelete.statusCode).toBe(200)
    const roleDelete = await app.inject({
      method: 'DELETE',
      url: `/api/roles/${role.id}?version=${updatedRole.version}`,
      headers,
    })
    expect(roleDelete.statusCode).toBe(200)
    await app.close()
    await repository.close()
  })

  it('完成 Codex 配置导入 preview/apply，并拒绝重复使用 preview', async () => {
    const sourceDirectory = await mkdtemp(join(process.cwd(), `.rolecast-codex-http-${randomUUID()}`))
    const sourcePath = join(sourceDirectory, 'config.toml')
    const { app, token, repository } = await createTestApp(undefined, sourceDirectory)
    const headers = { authorization: `Bearer ${token.value()}` }
    await writeFile(sourcePath, `model = "gpt-test"\nmodel_provider = "rolecast"\nmodel_reasoning_effort = "medium"\n\n[model_providers.rolecast]\nbase_url = "https://gateway.example.test/v1"\nwire_api = "responses"\napi_key = "not-test-secret"\n`, 'utf8')
    try {
      const workspaceResponse = await app.inject({
        method: 'POST',
        url: '/api/workspaces',
        headers,
        payload: { name: 'Codex 导入测试', root_path: '/tmp/rolecast-http-test-root' },
      })
      const workspaceId = workspaceResponse.json().data.id as string
      const providerResponse = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/providers`,
        headers,
        payload: { provider_kind: 'codex', connection_kind: 'local', environment_mode: 'inherited' },
      })
      const providerId = providerResponse.json().data.id as string

      const previewResponse = await app.inject({
        method: 'POST',
        url: `/api/providers/${providerId}/config-import/preview`,
        headers,
        payload: { source_path: sourcePath },
      })
      expect(previewResponse.statusCode).toBe(200)
      expect(previewResponse.body).not.toContain('not-test-secret')
      const preview = previewResponse.json().data as {
        preview_id: string
        target_config_revision: number
      }

      const applyResponse = await app.inject({
        method: 'POST',
        url: `/api/providers/${providerId}/config-import/apply`,
        headers,
        payload: {
          preview_id: preview.preview_id,
          confirmed: true,
          target_config_revision: preview.target_config_revision,
        },
      })
      expect(applyResponse.statusCode).toBe(200)
      expect(applyResponse.json().data).toMatchObject({
        environment_mode: 'isolated',
        config_revision: 2,
        codex_config: { model: 'gpt-test', wire_api: 'responses' },
      })

      const repeatedApply = await app.inject({
        method: 'POST',
        url: `/api/providers/${providerId}/config-import/apply`,
        headers,
        payload: {
          preview_id: preview.preview_id,
          confirmed: true,
          target_config_revision: preview.target_config_revision,
        },
      })
      expect(repeatedApply.statusCode).toBe(409)
      expect(repeatedApply.json()).toMatchObject({ ok: false, error: { code: 'config_import_target_conflict' } })
    } finally {
      await app.close()
      await repository.close()
      await rm(sourceDirectory, { recursive: true, force: true })
    }
  })

  it('WebSocket 必须先完成首帧认证，认证后才允许 resume', async () => {
    const { app, token, repository } = await createTestApp()
    for (const workspaceId of ['workspace-001', 'workspace-002']) {
      await repository.createWorkspace({
        id: workspaceId,
        name: workspaceId,
        created_at: '2026-10-14T10:00:00.000Z',
        updated_at: '2026-10-14T10:00:00.000Z',
      })
      await repository.createSession({
        id: `${workspaceId}-session`,
        workspace_id: workspaceId,
        name: '会话',
        status: 'active',
        created_at: '2026-10-14T10:00:00.000Z',
        updated_at: '2026-10-14T10:00:00.000Z',
      })
      await repository.createAgentSlot({
        id: `${workspaceId}-slot`,
        session_id: `${workspaceId}-session`,
        model_id: 'model-001',
        status: 'idle',
        created_at: '2026-10-14T10:00:00.000Z',
      })
      await repository.saveRun({
        id: `${workspaceId}-run`,
        workspace_id: workspaceId,
        session_id: `${workspaceId}-session`,
        status: 'running',
        attempt: 1,
      })
      await repository.appendEvent({
        event_id: `${workspaceId}-event`,
        schema_version: 1,
        workspace_id: workspaceId,
        session_id: `${workspaceId}-session`,
        run_id: `${workspaceId}-run`,
        type: 'run.started',
        source: 'test',
        occurred_at: '2026-10-14T10:00:00.000Z',
        payload: {},
      })
    }
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo
    const baseUrl = `ws://127.0.0.1:${address.port}/api/ws`
    const unauthenticated = new WebSocket(baseUrl, { headers: { origin: 'http://127.0.0.1' } })
    const closeCode = await new Promise<number>((resolve) => {
      unauthenticated.once('close', (code: number) => resolve(code))
    })
    expect(closeCode).toBe(1008)

    const authenticated = new WebSocket(baseUrl, { headers: { origin: 'http://127.0.0.1' } })
    const controlMessage = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket 认证超时')), 2_000)
      authenticated.once('open', () => {
        authenticated.send(JSON.stringify({ type: 'auth', token: token.value(), workspace_id: 'workspace-001' }))
      })
      authenticated.on('message', (data: Buffer) => {
        const text = data.toString('utf8')
        if (text.includes('authenticated')) {
          clearTimeout(timeout)
          resolve(text)
        }
      })
    })
    expect(controlMessage).toContain('authenticated')
    authenticated.send(JSON.stringify({
      type: 'resume',
      runs: [{ run_id: 'workspace-001-run', last_sequence: 2 }],
    }))
    const snapshotRequired = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('未收到 snapshot_required')), 2_000)
      authenticated.on('message', (data: Buffer) => {
        const text = data.toString('utf8')
        if (text.includes('snapshot_required')) {
          clearTimeout(timeout)
          resolve(text)
        }
      })
    })
    expect(snapshotRequired).toContain('workspace-001-session')
    authenticated.send(JSON.stringify({
      type: 'resume',
      runs: [{ run_id: 'workspace-002-run', last_sequence: 0 }],
    }))
    const deniedCode = await new Promise<number>((resolve) => {
      authenticated.once('close', (code: number) => resolve(code))
    })
    expect(deniedCode).toBe(1008)
    await app.close()
    await repository.close()
  }, 15_000)

  it('创建凭据需要认证，成功返回 201、引用与 no-store', async () => {
    const { app, token, repository } = await createTestApp()
    const payload = {
      idempotency_key: '7d444840-9dc0-11d1-b245-5ffdce74fad2',
      secret: 'sk-synthetic-http-value',
    }
    const unauthenticated = await app.inject({ method: 'POST', url: '/api/credentials', payload })
    expect(unauthenticated.statusCode).toBe(401)
    expect(JSON.stringify(unauthenticated.json())).not.toContain(payload.secret)

    const response = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: { authorization: `Bearer ${token.value()}` },
      payload,
    })
    expect(response.statusCode).toBe(201)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toMatchObject({
      ok: true,
      data: { credential_ref: `credential-${payload.idempotency_key}` },
    })
    expect(response.body).not.toContain(payload.secret)
    await app.close()
    await repository.close()
  })

  it('凭据创建按幂等键复现同一引用，不同 Secret 返回 409', async () => {
    const { app, token, repository, credentialStore } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    const idempotencyKey = '7d444840-9dc0-11d1-b245-5ffdce74fad2'
    const first = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers,
      payload: { idempotency_key: idempotencyKey, secret: 'sk-first' },
    })
    const retry = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers,
      payload: { idempotency_key: idempotencyKey, secret: 'sk-first' },
    })
    expect(first.statusCode).toBe(201)
    expect(retry.json()).toEqual(first.json())

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers,
      payload: { idempotency_key: idempotencyKey, secret: 'sk-second' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({
      ok: false,
      error: {
        code: 'credential_idempotency_conflict',
        // 引用不是 Secret：回传它，调用方才能继续使用已保存的凭据。
        details: { credential_ref: `credential-${idempotencyKey}` },
      },
    })
    expect(conflict.body).not.toContain('sk-second')

    const other = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers,
      payload: { idempotency_key: '11111111-1111-4111-8111-111111111111', secret: 'sk-first' },
    })
    expect(other.statusCode).toBe(201)
    expect(other.json().data.credential_ref).not.toBe(first.json().data.credential_ref)
    expect(credentialStore instanceof TestCredentialStore ? credentialStore.saves.length : 0).toBe(4)
    await app.close()
    await repository.close()
  })

  it('非法凭据请求返回 400 且不调用 Store', async () => {
    const store = new TestCredentialStore()
    const { app, token, repository } = await createTestApp(undefined, undefined, undefined, store)
    const headers = { authorization: `Bearer ${token.value()}` }
    for (const payload of [
      { idempotency_key: 'not-a-uuid', secret: 'sk-test' },
      { idempotency_key: '7d444840-9dc0-11d1-b245-5ffdce74fad2', secret: '' },
      { idempotency_key: '7d444840-9dc0-11d1-b245-5ffdce74fad2', secret: 'line1\nline2' },
      { idempotency_key: '7d444840-9dc0-11d1-b245-5ffdce74fad2', secret: 'sk-test', request_id: 'x' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/credentials', headers, payload })
      expect(response.statusCode).toBe(400)
      expect(response.body).not.toContain('sk-test')
    }
    expect(store.saves).toHaveLength(0)
    await app.close()
    await repository.close()
  })

  it('凭据存储不可用映射为 503，拒绝映射 403，无效映射 422', async () => {
    const unavailable = await createTestApp(undefined, undefined, undefined, new UnavailableCredentialStore())
    const headers = { authorization: `Bearer ${unavailable.token.value()}` }
    const payload = { idempotency_key: '7d444840-9dc0-11d1-b245-5ffdce74fad2', secret: 'sk-test' }
    const failed = await unavailable.app.inject({ method: 'POST', url: '/api/credentials', headers, payload })
    expect(failed.statusCode).toBe(503)
    expect(failed.json()).toMatchObject({ ok: false, error: { code: 'credentials_unavailable' } })
    await unavailable.app.close()
    await unavailable.repository.close()

    for (const [error, status, code] of [
      [new CredentialDeniedError(), 403, 'credential_denied'],
      [new CredentialInvalidError(), 422, 'credential_invalid'],
    ] as const) {
      const store = new TestCredentialStore()
      store.save = async () => {
        throw error
      }
      const created = await createTestApp(undefined, undefined, undefined, store)
      const response = await created.app.inject({
        method: 'POST',
        url: '/api/credentials',
        headers: { authorization: `Bearer ${created.token.value()}` },
        payload,
      })
      expect(response.statusCode).toBe(status)
      expect(response.json()).toMatchObject({ ok: false, error: { code } })
      expect(response.body).not.toContain(payload.secret)
      await created.app.close()
      await created.repository.close()
    }
  })

  it('handoff route 持久化 Message、幂等重放并映射稳定错误', async () => {
    const { app, token, repository } = await createTestApp()
    const headers = { authorization: `Bearer ${token.value()}` }
    await repository.createWorkspace({ id: 'w', name: 'w', created_at: 't', updated_at: 't' })
    await repository.createSession({
      id: 's', workspace_id: 'w', name: 's', status: 'active', created_at: 't', updated_at: 't',
    })
    await repository.createAgentSlot({ id: 'slot-1', session_id: 's', model_id: 'm', status: 'idle', created_at: 't' })
    await repository.createAgentSlot({ id: 'slot-2', session_id: 's', model_id: 'm', status: 'idle', created_at: 't' })
    const run = {
      id: 'run-1', workspace_id: 'w', session_id: 's', status: 'running' as const, attempt: 1,
      created_at: 't', updated_at: 't',
    }
    const task = {
      id: 'task-1', workspace_id: 'w', session_id: 's', run_id: 'run-1', slot_id: 'slot-1',
      title: 't', status: 'running' as const, created_at: 't', updated_at: 't',
    }
    await repository.createTurn(run, task, {
      id: 'msg-user', session_id: 's', run_id: 'run-1', sender_kind: 'user', sender_id: null,
      content: 'prompt', created_at: 't',
    })
    await repository.appendEvent({
      event_id: 'e1', schema_version: 1, workspace_id: 'w', session_id: 's', run_id: 'run-1',
      type: 'agent.message', source: 'acp-runtime', occurred_at: 't', payload: { text: 'hello' },
    })
    const revision = await repository.getRunStateRevision('run-1')
    await repository.finalizeRun({
      run: { ...run, status: 'completed' }, expectedStateRevision: revision ?? 1,
      taskId: 'task-1', taskStatus: 'completed', slotId: 'slot-1', releaseClaim: false,
    })

    const payload = { source_run_id: 'run-1', target_slot_id: 'slot-2', request_id: 'key-1' }
    const first = await app.inject({ method: 'POST', url: '/api/sessions/s/handoffs', headers, payload })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({
      ok: true, data: { kind: 'handoff', to_slot_id: 'slot-2', content: 'hello' },
    })
    const replay = await app.inject({ method: 'POST', url: '/api/sessions/s/handoffs', headers, payload })
    expect(replay.statusCode).toBe(201)
    expect(replay.json().data.id).toBe(first.json().data.id)

    const conflict = await app.inject({
      method: 'POST', url: '/api/sessions/s/handoffs', headers,
      payload: { ...payload, target_slot_id: 'slot-1' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ ok: false, error: { code: 'state_conflict' } })

    const missingRun = await app.inject({
      method: 'POST', url: '/api/sessions/s/handoffs', headers,
      payload: { source_run_id: 'run-missing', target_slot_id: 'slot-2', request_id: 'key-2' },
    })
    expect(missingRun.statusCode).toBe(409)
    expect(missingRun.json()).toMatchObject({
      ok: false, error: { code: 'source_history_unavailable' },
    })
    await app.close()
    await repository.close()
  })

  it('Mailbox 列表、详情与显式已读经 HTTP 保持 Session+Slot 隔离', async () => {
    const { app, token, repository, database } = await createTestApp()
    seedMailboxRows(database)
    const headers = { authorization: `Bearer ${token.value()}` }

    const list = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/mailbox?slot_id=slot-1', headers,
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().data.items).toEqual([{
      id: 'message-1',
      session_id: 'session-1',
      sender_id: 'slot-sender',
      to_slot_id: 'slot-1',
      created_at: '2026-11-05T09:00:00.000Z',
      status: 'unread',
      read_at: null,
    }])
    expect(list.json().data.items[0]).not.toHaveProperty('content')

    const detail = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/mailbox/message-1?slot_id=slot-1', headers,
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().data).toMatchObject({
      status: 'unread',
      message: { id: 'message-1', content: 'handoff body', kind: 'handoff', to_slot_id: 'slot-1' },
    })

    const read = await app.inject({
      method: 'POST', url: '/api/sessions/session-1/mailbox/message-1/read', headers, payload: { slot_id: 'slot-1' },
    })
    expect(read.statusCode).toBe(200)
    expect(read.json().data).toMatchObject({ message_id: 'message-1', status: 'read', event_bus_status: 'published' })

    const after = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/mailbox?slot_id=slot-1', headers,
    })
    expect(after.json().data.items[0]).toMatchObject({ status: 'read' })
    await app.close()
    await repository.close()
  })

  it('Mailbox 越权、未知 Slot 与非法分页统一拒绝且不泄露正文', async () => {
    const { app, token, repository, database } = await createTestApp()
    seedMailboxRows(database)
    const headers = { authorization: `Bearer ${token.value()}` }

    const otherSlot = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/mailbox?slot_id=slot-missing', headers,
    })
    expect(otherSlot.statusCode).toBe(404)
    expect(otherSlot.json()).toMatchObject({ ok: false, error: { code: 'mailbox_message_unavailable' } })
    expect(otherSlot.body).not.toContain('handoff body')

    const missingMessage = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/mailbox/missing-message?slot_id=slot-1', headers,
    })
    expect(missingMessage.statusCode).toBe(404)
    expect(missingMessage.json()).toMatchObject({ ok: false, error: { code: 'mailbox_message_unavailable' } })

    const invalidLimit = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/mailbox?slot_id=slot-1&limit=0', headers,
    })
    expect(invalidLimit.statusCode).toBe(400)

    const invalidCursor = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/mailbox?slot_id=slot-1&cursor=missing-message', headers,
    })
    expect(invalidCursor.statusCode).toBe(404)

    const invalidBody = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/mailbox/message-1/read',
      headers,
      payload: { slot_id: 'slot-1', content: 'leak' },
    })
    expect(invalidBody.statusCode).toBe(400)

    const unauthenticated = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/mailbox?slot_id=slot-1',
    })
    expect(unauthenticated.statusCode).toBe(401)
    await app.close()
    await repository.close()
  })
})

/** 直接写入 Mailbox HTTP 测试所需的最小已完成 Run 与 handoff Message。 */
function seedMailboxRows(database: SqliteDatabase): void {
  const timestamp = '2026-11-05T08:00:00.000Z'
  database.prepare('INSERT INTO workspaces(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('workspace-1', 'Workspace 1', timestamp, timestamp)
  database
    .prepare('INSERT INTO sessions(id, workspace_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('session-1', 'workspace-1', 'Session 1', 'active', timestamp, timestamp)
  for (const slotId of ['slot-1', 'slot-other']) {
    database
      .prepare('INSERT INTO agent_slots(id, session_id, model_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(slotId, 'session-1', 'model-1', 'idle', timestamp)
  }
  database
    .prepare(
      `INSERT INTO runs(
        id, workspace_id, session_id, status, attempt, created_at, updated_at,
        event_sequence, completed_sequence
      ) VALUES (?, ?, ?, 'completed', 1, ?, ?, 2, 2)`,
    )
    .run('run-1', 'workspace-1', 'session-1', timestamp, timestamp)
  database
    .prepare(
      `INSERT INTO messages(
        id, session_id, run_id, sender_kind, sender_id, content, created_at, kind, to_slot_id
      ) VALUES (?, ?, ?, 'agent', 'slot-sender', ?, ?, 'handoff', ?)`,
    )
    .run('message-1', 'session-1', 'run-1', 'handoff body', '2026-11-05T09:00:00.000Z', 'slot-1')
}
