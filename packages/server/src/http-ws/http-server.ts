import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import type { WebSocket } from 'ws'

import {
  addAgentSlotRequestSchema,
  apiSuccessEnvelopeSchema,
  capabilitySnapshotSchema,
  codexConfigImportApplyRequestSchema,
  codexConfigImportPreviewRequestSchema,
  codexConfigImportPreviewSchema,
  createCredentialRequestSchema,
  createProviderConnectionRequestSchema,
  createRoleBindingRequestSchema,
  createRoleRequestSchema,
  createSessionRequestSchema,
  handoffRequestSchema,
  createWorkspaceRequestSchema,
  credentialReferenceDtoSchema,
  permissionAnswerRequestSchema,
  providerConnectionDtoSchema,
  roleBindingDtoSchema,
  roleDtoSchema,
  runCommandReceiptSchema,
  runCommandRequestSchema,
  sendMessageRequestSchema,
  setWorkspaceRootPathRequestSchema,
  updateProviderConnectionRequestSchema,
  updateRoleBindingRequestSchema,
  updateRoleRequestSchema,
  workspaceRootPathDtoSchema,
  wsClientMessageSchema,
  type EventEnvelope,
} from '@rolecast/contract'

import type { ArtifactService } from '../application/artifacts/artifact-service.js'
import type { MailboxService } from '../application/mailbox/mailbox-service.js'
import type { ConversationService } from '../application/conversation/conversation-service.js'
import type { CredentialService } from '../application/credentials/credential-service.js'
import type { ProviderService } from '../application/providers/provider-service.js'
import type { RoleService } from '../application/roles/role-service.js'
import type { WorkspaceService } from '../application/workspace/workspace-service.js'
import type { EventBusPort } from '../application/ports/event-bus-port.js'
import type { CodexConfigImportDraft } from '../application/ports/codex-config-import-port.js'
import type { RepositoryPort } from '../application/ports/repository-port.js'
import type { SessionService } from '../application/sessions/session-service.js'
import { rejectEmptyRootPath, requestId, sendApiError, sendMappedError, sendValidationError } from './http-api-error.js'
import { installArtifactRoutes } from './artifact-routes.js'
import { installMailboxRoutes } from './mailbox-routes.js'
import { LocalTokenService } from './local-token.js'

/** HTTP/WS 装配所需的 Application 依赖。 */
export interface HttpServerDependencies {
  artifactService: ArtifactService
  mailboxService: MailboxService
  workspaceService: WorkspaceService
  providerService: ProviderService
  credentialService: CredentialService
  roleService: RoleService
  sessionService: SessionService
  conversationService: ConversationService
  repository: RepositoryPort
  eventBus: EventBusPort
  localToken: LocalTokenService
}

type Params = Record<string, string>

/**
 * @name createHttpApp
 * @description 创建经过 Local Token、Origin 和 Host 保护的 Fastify 控制面
 * @param {HttpServerDependencies} dependencies Application 和基础设施依赖
 * @return {Promise<FastifyInstance>} 已注册 REST/WS 路由的 Fastify 实例
 */
export async function createHttpApp(dependencies: HttpServerDependencies): Promise<FastifyInstance> {
  const app = (await import('fastify')).default({ logger: false, bodyLimit: 1_048_576 })
  await app.register(websocketPlugin)
  installSecurityHooks(app, dependencies.localToken)
  installRoutes(app, dependencies)
  installArtifactRoutes(app, dependencies.artifactService)
  installMailboxRoutes(app, dependencies.mailboxService)
  return app
}

function installSecurityHooks(app: FastifyInstance, localToken: LocalTokenService): void {
  app.addHook('onRequest', async (request, reply) => {
    const requestId = request.headers['x-request-id']
    const normalizedRequestId = typeof requestId === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(requestId)
      ? requestId
      : request.id

    reply.header('x-request-id', normalizedRequestId)
    if (!isLocalHost(request.headers.host) || !isAllowedOrigin(request.headers.origin)) {
      sendApiError(reply, 403, {
        code: 'unauthorized',
        message: '请求来源不受允许',
        details: {},
        request_id: normalizedRequestId,
      })
      return
    }
    if (request.url.startsWith('/healthz') || request.url.startsWith('/api/ws')) {
      return
    }
    const authorization = request.headers.authorization
    if (!isBearerTokenValid(authorization, localToken)) {
      sendApiError(reply, 401, {
        code: 'unauthorized',
        message: 'Local Token 无效或缺失',
        details: {},
        request_id: normalizedRequestId,
      })
    }
  })
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'strict-origin-when-cross-origin')
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
    reply.header('content-security-policy', "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'")
    return payload
  })
}

function installRoutes(app: FastifyInstance, dependencies: HttpServerDependencies): void {
  app.get('/healthz', async (_request, reply) => {
    reply.send({ ok: true, data: { status: 'ok' } })
  })

  app.get('/api/workspaces', async (request, reply) => {
    try {
      const data = await dependencies.workspaceService.list()
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/workspaces', async (request, reply) => {
    if (
      typeof request.body !== 'object' ||
      request.body === null ||
      !Object.hasOwn(request.body, 'root_path')
    ) {
      sendApiError(reply, 422, {
        code: 'workspace_root_required',
        message: '新建 Workspace 必须提供根目录路径',
        details: {},
        request_id: requestId(request),
      })
      return
    }
    if (rejectEmptyRootPath(request.body, reply, request)) {
      return
    }
    const parsed = createWorkspaceRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const data = await dependencies.workspaceService.create(parsed.data)
      reply.code(201).send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/workspaces/:workspaceId/root-path', async (request, reply) => {
    const params = request.params as Params
    try {
      const data = await dependencies.workspaceService.getRootPath(params.workspaceId ?? '')
      reply.send({ ok: true, data: workspaceRootPathDtoSchema.parse(data) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/workspaces/:workspaceId/root-path', async (request, reply) => {
    if (rejectEmptyRootPath(request.body, reply, request)) {
      return
    }
    const parsed = setWorkspaceRootPathRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    const params = request.params as Params
    try {
      const data = await dependencies.workspaceService.setRootPath(params.workspaceId ?? '', parsed.data)
      reply.send({ ok: true, data: workspaceRootPathDtoSchema.parse(data) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/workspaces/:workspaceId/providers', async (request, reply) => {
    const params = request.params as Params
    try {
      const data = await dependencies.providerService.listConnections(params.workspaceId ?? '')
      reply.send({ ok: true, data: data.map((item) => providerConnectionDtoSchema.parse(item)) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/workspaces/:workspaceId/providers', async (request, reply) => {
    const parsed = createProviderConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      const data = await dependencies.providerService.createConnection(params.workspaceId ?? '', parsed.data)
      reply.code(201).send({ ok: true, data: providerConnectionDtoSchema.parse(data) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/providers/:providerId/test', async (request, reply) => {
    try {
      const params = request.params as Params
      const data = capabilitySnapshotSchema.parse(await dependencies.providerService.testConnection(params.providerId ?? ''))
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/providers/:providerId/discover', async (request, reply) => {
    try {
      const params = request.params as Params
      const data = capabilitySnapshotSchema.parse(await dependencies.providerService.discoverModels(params.providerId ?? ''))
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/credentials', async (request, reply) => {
    const parsed = createCredentialRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const data = await dependencies.credentialService.create({
        idempotencyKey: parsed.data.idempotency_key,
        secret: parsed.data.secret,
      })
      // 响应含凭据引用，禁止任何中间层缓存。
      reply.header('cache-control', 'no-store')
      reply.code(201).send({ ok: true, data: credentialReferenceDtoSchema.parse(data) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.patch('/api/providers/:providerId', async (request, reply) => {
    const parsed = updateProviderConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      const data = await dependencies.providerService.updateConnection(params.providerId ?? '', parsed.data)
      reply.send({ ok: true, data: providerConnectionDtoSchema.parse(data) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/providers/:providerId/config-import/preview', async (request, reply) => {
    const parsed = codexConfigImportPreviewRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      const draft = await dependencies.providerService.previewConfigImport(params.providerId ?? '', parsed.data.source_path)
      const data = codexConfigImportPreviewSchema.parse(toCodexConfigImportPreview(draft))
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/providers/:providerId/config-import/apply', async (request, reply) => {
    const parsed = codexConfigImportApplyRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      const data = await dependencies.providerService.applyConfigImport(params.providerId ?? '', parsed.data)
      reply.send({ ok: true, data: providerConnectionDtoSchema.parse(data) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/providers/:providerId/models', async (request, reply) => {
    try {
      const params = request.params as Params
      const data = await dependencies.providerService.listModels(params.providerId ?? '')
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/workspaces/:workspaceId/roles', async (request, reply) => {
    try {
      const params = request.params as Params
      const data = await dependencies.roleService.listRoles(params.workspaceId ?? '')
      reply.send({ ok: true, data: data.map((role) => roleDtoSchema.parse(role)) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/workspaces/:workspaceId/roles', async (request, reply) => {
    const parsed = createRoleRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      const data = await dependencies.roleService.createRole(params.workspaceId ?? '', parsed.data)
      reply.code(201).send({ ok: true, data: roleDtoSchema.parse(data) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/roles/:roleId', async (request, reply) => {
    try {
      const params = request.params as Params
      const data = await dependencies.roleService.getRole(params.roleId ?? '')
      reply.send({ ok: true, data: roleDtoSchema.parse(data) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.patch('/api/roles/:roleId', async (request, reply) => {
    const parsed = updateRoleRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      const data = await dependencies.roleService.updateRole(params.roleId ?? '', parsed.data)
      reply.send({ ok: true, data: roleDtoSchema.parse(data) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.delete('/api/roles/:roleId', async (request, reply) => {
    const version = parseVersionQuery(request, reply)
    if (version === null) {
      return
    }
    try {
      const params = request.params as Params
      await dependencies.roleService.deleteRole(params.roleId ?? '', version)
      reply.send({ ok: true, data: null })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/workspaces/:workspaceId/bindings', async (request, reply) => {
    try {
      const params = request.params as Params
      const data = await dependencies.roleService.listBindings(params.workspaceId ?? '')
      reply.send({ ok: true, data: data.map((binding) => roleBindingDtoSchema.parse(binding)) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/workspaces/:workspaceId/bindings', async (request, reply) => {
    const parsed = createRoleBindingRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      const data = await dependencies.roleService.createBinding(params.workspaceId ?? '', parsed.data)
      reply.code(201).send({ ok: true, data: roleBindingDtoSchema.parse(data) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/bindings/:bindingId', async (request, reply) => {
    try {
      const params = request.params as Params
      const data = await dependencies.roleService.getBinding(params.bindingId ?? '')
      reply.send({ ok: true, data: roleBindingDtoSchema.parse(data) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.patch('/api/bindings/:bindingId', async (request, reply) => {
    const parsed = updateRoleBindingRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      const data = await dependencies.roleService.updateBinding(params.bindingId ?? '', parsed.data)
      reply.send({ ok: true, data: roleBindingDtoSchema.parse(data) })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.delete('/api/bindings/:bindingId', async (request, reply) => {
    const version = parseVersionQuery(request, reply)
    if (version === null) {
      return
    }
    try {
      const params = request.params as Params
      await dependencies.roleService.deleteBinding(params.bindingId ?? '', version)
      reply.send({ ok: true, data: null })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/workspaces/:workspaceId/sessions', async (request, reply) => {
    try {
      const params = request.params as Params
      const data = await dependencies.sessionService.list(params.workspaceId ?? '')
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/workspaces/:workspaceId/sessions', async (request, reply) => {
    const parsed = createSessionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      const data = await dependencies.sessionService.create(params.workspaceId ?? '', parsed.data)
      reply.code(201).send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/sessions/:sessionId', async (request, reply) => {
    try {
      const params = request.params as Params
      const data = await dependencies.sessionService.require(params.sessionId ?? '')
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/sessions/:sessionId/snapshot', async (request, reply) => {
    try {
      const params = request.params as Params
      const data = await dependencies.sessionService.snapshot(params.sessionId ?? '')
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/sessions/:sessionId/agents', async (request, reply) => {
    const parsed = addAgentSlotRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      const data = await dependencies.sessionService.addAgentSlot(params.sessionId ?? '', parsed.data)
      reply.code(201).send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.delete('/api/sessions/:sessionId/agents/:slotId', async (request, reply) => {
    try {
      const params = request.params as Params
      await dependencies.sessionService.deleteAgentSlot(params.sessionId ?? '', params.slotId ?? '')
      reply.send({ ok: true, data: null })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  for (const command of ['cancel', 'resume', 'retry'] as const) {
    app.post(`/api/runs/:runId/${command}`, async (request, reply) => {
      const parsed = runCommandRequestSchema.safeParse(request.body)
      if (!parsed.success) {
        sendValidationError(reply, request, parsed.error.issues)
        return
      }
      try {
        const params = request.params as Params
        const runId = params.runId ?? ''
        const receipt = command === 'cancel'
          ? await dependencies.conversationService.cancelRun(runId, parsed.data)
          : command === 'resume'
            ? await dependencies.conversationService.resumeRun(runId, parsed.data)
            : await dependencies.conversationService.retryRun(runId, parsed.data)
        // 202：命令已接受并返回稳定引用，不代表 Run 已终态。
        reply.code(202).send({ ok: true, data: runCommandReceiptSchema.parse(receipt) })
      } catch (error: unknown) {
        sendMappedError(reply, request, error)
      }
    })
  }

  app.post('/api/sessions/:sessionId/messages', async (request, reply) => {
    const parsed = sendMessageRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      const data = await dependencies.conversationService.sendMessage(params.sessionId ?? '', parsed.data)
      reply.code(202).send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/sessions/:sessionId/handoffs', async (request, reply) => {
    const parsed = handoffRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      const data = await dependencies.conversationService.createHandoff(params.sessionId ?? '', parsed.data)
      // 201：handoff Message 已持久化；重放仍返回同一条 Message。
      reply.code(201).send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/sessions/:sessionId/activity', async (request, reply) => {
    try {
      const params = request.params as Params
      const data = await dependencies.conversationService.getActivity(params.sessionId ?? '')
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/permissions/:requestId/answer', async (request, reply) => {
    const parsed = permissionAnswerRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      sendValidationError(reply, request, parsed.error.issues)
      return
    }
    try {
      const params = request.params as Params
      await dependencies.conversationService.answerPermission(params.requestId ?? '', parsed.data.option_id)
      reply.send({ ok: true, data: null })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/ws', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    registerWebSocket(socket, request, dependencies)
  })
}

function registerWebSocket(
  socket: WebSocket,
  request: FastifyRequest,
  dependencies: HttpServerDependencies,
): void {
  if (!isLocalHost(request.headers.host) || !isAllowedOrigin(request.headers.origin)) {
    socket.close(1008, 'origin rejected')
    return
  }
  let authenticated = false
  let authorizedWorkspaceId: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => socket.close(1008, 'authentication required'), 5_000)
  const subscribedRuns = new Set<string>()
  const unsubscribe = { value: null as (() => void) | null }
  const send = (value: unknown): void => {
    if (socket.readyState !== 1) {
      return
    }
    if (socket.bufferedAmount > 1_048_576) {
      socket.close(1013, 'event buffer exceeded')
      return
    }
    socket.send(JSON.stringify(value))
  }
  const close = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    unsubscribe.value?.()
    unsubscribe.value = null
  }

  socket.on('close', close)
  socket.on('error', close)
  socket.on('message', (raw: Buffer) => {
    void handleWebSocketMessage(raw, socket, dependencies, send, () => authenticated, (value) => {
      authenticated = value
    }, () => authorizedWorkspaceId, (value) => {
      authorizedWorkspaceId = value
    }, subscribedRuns, unsubscribe, timer, (nextTimer) => {
      timer = nextTimer
    }).catch(() => socket.close(1011, 'message handling failed'))
  })
}

async function handleWebSocketMessage(
  raw: Buffer,
  socket: WebSocket,
  dependencies: HttpServerDependencies,
  send: (value: unknown) => void,
  isAuthenticated: () => boolean,
  setAuthenticated: (value: boolean) => void,
  getAuthorizedWorkspaceId: () => string | null,
  setAuthorizedWorkspaceId: (value: string) => void,
  subscribedRuns: Set<string>,
  unsubscribe: { value: (() => void) | null },
  timer: ReturnType<typeof setTimeout> | null,
  setTimer: (value: ReturnType<typeof setTimeout> | null) => void,
): Promise<void> {
  let input: unknown
  try {
    input = JSON.parse(raw.toString('utf8')) as unknown
  } catch {
    socket.close(1008, 'invalid control message')
    return
  }
  const parsed = wsClientMessageSchema.safeParse(input)
  if (!parsed.success) {
    socket.close(1008, 'invalid control message')
    return
  }
  if (!isAuthenticated()) {
    if (parsed.data.type !== 'auth' || !dependencies.localToken.matches(parsed.data.token)) {
      socket.close(1008, 'authentication failed')
      return
    }
    setAuthenticated(true)
    setAuthorizedWorkspaceId(parsed.data.workspace_id)
    if (timer !== null) {
      clearTimeout(timer)
      setTimer(null)
    }
    unsubscribe.value = dependencies.eventBus.subscribe((event) => {
      if (subscribedRuns.has(event.run_id)) {
        send(event)
      }
    })
    send({ type: 'authenticated' })
    return
  }
  if (parsed.data.type !== 'resume') {
    socket.close(1008, 'auth already completed')
    return
  }
  for (const run of parsed.data.runs) {
    const storedRun = await dependencies.repository.getRun(run.run_id)
    if (storedRun === null || storedRun.workspace_id !== getAuthorizedWorkspaceId()) {
      socket.close(1008, 'workspace access denied')
      return
    }
    subscribedRuns.add(run.run_id)
    const bounds = await dependencies.repository.getEventBounds(run.run_id)
    if (bounds.first !== null && (run.last_sequence > bounds.last! || run.last_sequence < bounds.first - 1)) {
      send({ type: 'snapshot_required', session_id: storedRun.session_id })
      continue
    }
    const events = await dependencies.repository.replayEvents(run.run_id, run.last_sequence)
    for (const event of events) {
      send(event)
    }
  }
}

function toCodexConfigImportPreview(draft: CodexConfigImportDraft) {
  return {
    preview_id: draft.previewId,
    provider_id: draft.providerId,
    workspace_id: draft.workspaceId,
    source_name: draft.sourceName,
    source_digest: draft.sourceDigest,
    target_config_revision: draft.targetConfigRevision,
    ...(draft.baseUrl === undefined ? {} : { base_url: draft.baseUrl }),
    codex_config: draft.config,
    models: draft.models.map((model) => ({ model_id: model.modelId, display_name: model.displayName })),
    warnings: [...draft.warnings],
  }
}

function parseVersionQuery(request: FastifyRequest, reply: FastifyReply): number | null {
  const query = request.query as { readonly version?: unknown }
  const value = typeof query.version === 'string' ? Number(query.version) : Number.NaN
  if (!Number.isInteger(value) || value <= 0) {
    sendValidationError(reply, request, [{ path: ['version'], message: 'version 必须是正整数' }])
    return null
  }
  return value
}

function isBearerTokenValid(authorization: string | undefined, token: LocalTokenService): boolean {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    return false
  }
  return token.matches(authorization.slice('Bearer '.length))
}

function isLocalHost(host: string | undefined): boolean {
  if (host === undefined) {
    return false
  }
  const normalized = host.replace(/^\[/, '').split(']')[0]?.split(':')[0] ?? ''
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true
  }
  try {
    return isLocalHost(new URL(origin).host)
  } catch {
    return false
  }
}
