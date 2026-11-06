import {
  addAgentSlotRequestSchema,
  agentSlotDtoSchema,
  artifactContentDtoSchema,
  artifactPageDtoSchema,
  artifactPageQuerySchema,
  capabilitySnapshotSchema,
  codexConfigImportApplyRequestSchema,
  codexConfigImportPreviewRequestSchema,
  codexConfigImportPreviewSchema,
  createCredentialRequestSchema,
  createProviderConnectionRequestSchema,
  createRoleBindingRequestSchema,
  createRoleRequestSchema,
  createSessionRequestSchema,
  createWorkspaceRequestSchema,
  handoffRequestSchema,
  mailboxMarkReadDtoSchema,
  mailboxMarkReadRequestSchema,
  mailboxMessageDetailDtoSchema,
  mailboxPageDtoSchema,
  mailboxPageQuerySchema,
  messageDtoSchema,
  credentialReferenceDtoSchema,
  modelCatalogEntryDtoSchema,
  providerConnectionDtoSchema,
  roleBindingDtoSchema,
  roleDtoSchema,
  runCommandReceiptSchema,
  runCommandRequestSchema,
  sendMessageRequestSchema,
  sessionDtoSchema,
  updateRoleBindingRequestSchema,
  updateProviderConnectionRequestSchema,
  updateRoleRequestSchema,
  sessionSnapshotDtoSchema,
  workspaceDtoSchema,
  workspaceRootPathDtoSchema,
  setWorkspaceRootPathRequestSchema,
  type CodexConfigImportApplyRequest,
  type CodexConfigImportPreviewRequest,
  type CreateCredentialRequest,
  type CreateProviderConnectionRequest,
  type CreateRoleBindingRequest,
  type CreateRoleRequest,
  type CreateSessionRequest,
  type AddAgentSlotRequest,
  type ArtifactPageQuery,
  type CreateWorkspaceRequest,
  type HandoffRequest,
  type MailboxMarkReadRequest,
  type MailboxPageQuery,
  type RunCommandRequest,
  type SendMessageRequest,
  type SetWorkspaceRootPathRequest,
  type UpdateProviderConnectionRequest,
  type UpdateRoleBindingRequest,
  type UpdateRoleRequest,
} from '@rolecast/contract'
import { z } from 'zod'

import { apiRequest } from './httpClient.js'

const sessionCreationResultSchema = z.object({
  session: sessionDtoSchema,
  agentSlot: z.object({ id: z.string().min(1) }).passthrough(),
}).strict()

const turnCreationResultSchema = z.object({
  run: z.object({ id: z.string().min(1) }).passthrough(),
  task: z.object({ id: z.string().min(1) }).passthrough(),
}).strict()

/** Workspace API。 */
export const workspaceEndpoints = {
  list: () => apiRequest({ method: 'GET', url: '/api/workspaces' }, z.array(workspaceDtoSchema)),
  create: (input: CreateWorkspaceRequest) => {
    const payload = createWorkspaceRequestSchema.parse(input)
    return apiRequest({ method: 'POST', url: '/api/workspaces', data: payload }, workspaceDtoSchema)
  },
  getRootPath: (workspaceId: string) => apiRequest(
    {
      method: 'GET',
      url: `/api/workspaces/${encodeURIComponent(workspaceId)}/root-path`,
    },
    workspaceRootPathDtoSchema,
  ),
  setRootPath: (workspaceId: string, input: SetWorkspaceRootPathRequest) => {
    const payload = setWorkspaceRootPathRequestSchema.parse(input)
    return apiRequest(
      {
        method: 'POST',
        url: `/api/workspaces/${encodeURIComponent(workspaceId)}/root-path`,
        data: payload,
      },
      workspaceRootPathDtoSchema,
    )
  },
}

/** Provider API。 */
export const providerEndpoints = {
  list: (workspaceId: string) => apiRequest(
    { method: 'GET', url: `/api/workspaces/${encodeURIComponent(workspaceId)}/providers` },
    z.array(providerConnectionDtoSchema),
  ),
  create: (workspaceId: string, input: CreateProviderConnectionRequest) => {
    const payload = createProviderConnectionRequestSchema.parse(input)
    return apiRequest(
      { method: 'POST', url: `/api/workspaces/${encodeURIComponent(workspaceId)}/providers`, data: payload },
      providerConnectionDtoSchema,
    )
  },
  /** 修正非秘密连接字段；只提交 Contract 允许的字段。 */
  update: (providerId: string, input: UpdateProviderConnectionRequest) => {
    const payload = updateProviderConnectionRequestSchema.parse(input)
    return apiRequest(
      { method: 'PATCH', url: `/api/providers/${encodeURIComponent(providerId)}`, data: payload },
      providerConnectionDtoSchema,
    )
  },
  test: (providerId: string) => apiRequest(
    { method: 'POST', url: `/api/providers/${encodeURIComponent(providerId)}/test` },
    capabilitySnapshotSchema,
  ),
  discover: (providerId: string) => apiRequest(
    { method: 'POST', url: `/api/providers/${encodeURIComponent(providerId)}/discover` },
    capabilitySnapshotSchema,
  ),
  models: (providerId: string) => apiRequest(
    { method: 'GET', url: `/api/providers/${encodeURIComponent(providerId)}/models` },
    z.array(modelCatalogEntryDtoSchema),
  ),
  /** 读取受控 Codex 配置并返回脱敏草稿；不接触 Secret。 */
  previewConfigImport: (providerId: string, input: CodexConfigImportPreviewRequest) => {
    const payload = codexConfigImportPreviewRequestSchema.parse(input)
    return apiRequest(
      {
        method: 'POST',
        url: `/api/providers/${encodeURIComponent(providerId)}/config-import/preview`,
        data: payload,
      },
      codexConfigImportPreviewSchema,
    )
  },
  /** 用户确认后应用一次性草稿；引用 ID 不是 Secret。 */
  applyConfigImport: (providerId: string, input: CodexConfigImportApplyRequest) => {
    const payload = codexConfigImportApplyRequestSchema.parse(input)
    return apiRequest(
      {
        method: 'POST',
        url: `/api/providers/${encodeURIComponent(providerId)}/config-import/apply`,
        data: payload,
      },
      providerConnectionDtoSchema,
    )
  },
}

/** 凭据 API：只创建，不提供读取、列表、轮换或删除入口。 */
export const credentialEndpoints = {
  /**
   * 把 API key 写入服务端 CredentialStore，返回不透明引用。
   *
   * 超时单独放宽到 30s：macOS Keychain 命令本身最长 15s，默认 10s 会把正常写入打断。
   */
  create: (input: CreateCredentialRequest) => {
    const payload = createCredentialRequestSchema.parse(input)
    return apiRequest(
      { method: 'POST', url: '/api/credentials', data: payload, timeout: 30_000 },
      credentialReferenceDtoSchema,
    )
  },
}

/** Role 配置 API。 */
export const roleEndpoints = {
  list: (workspaceId: string) => apiRequest(
    { method: 'GET', url: `/api/workspaces/${encodeURIComponent(workspaceId)}/roles` },
    z.array(roleDtoSchema),
  ),
  create: (workspaceId: string, input: CreateRoleRequest) => {
    const payload = createRoleRequestSchema.parse(input)
    return apiRequest(
      { method: 'POST', url: `/api/workspaces/${encodeURIComponent(workspaceId)}/roles`, data: payload },
      roleDtoSchema,
    )
  },
  get: (roleId: string) => apiRequest(
    { method: 'GET', url: `/api/roles/${encodeURIComponent(roleId)}` },
    roleDtoSchema,
  ),
  update: (roleId: string, input: UpdateRoleRequest) => {
    const payload = updateRoleRequestSchema.parse(input)
    return apiRequest(
      { method: 'PATCH', url: `/api/roles/${encodeURIComponent(roleId)}`, data: payload },
      roleDtoSchema,
    )
  },
  remove: (roleId: string, version: number) => apiRequest(
    { method: 'DELETE', url: `/api/roles/${encodeURIComponent(roleId)}?version=${version}` },
    z.null(),
  ),
}

/** RoleBinding 配置 API。 */
export const bindingEndpoints = {
  list: (workspaceId: string) => apiRequest(
    { method: 'GET', url: `/api/workspaces/${encodeURIComponent(workspaceId)}/bindings` },
    z.array(roleBindingDtoSchema),
  ),
  create: (workspaceId: string, input: CreateRoleBindingRequest) => {
    const payload = createRoleBindingRequestSchema.parse(input)
    return apiRequest(
      { method: 'POST', url: `/api/workspaces/${encodeURIComponent(workspaceId)}/bindings`, data: payload },
      roleBindingDtoSchema,
    )
  },
  get: (bindingId: string) => apiRequest(
    { method: 'GET', url: `/api/bindings/${encodeURIComponent(bindingId)}` },
    roleBindingDtoSchema,
  ),
  update: (bindingId: string, input: UpdateRoleBindingRequest) => {
    const payload = updateRoleBindingRequestSchema.parse(input)
    return apiRequest(
      { method: 'PATCH', url: `/api/bindings/${encodeURIComponent(bindingId)}`, data: payload },
      roleBindingDtoSchema,
    )
  },
  remove: (bindingId: string, version: number) => apiRequest(
    { method: 'DELETE', url: `/api/bindings/${encodeURIComponent(bindingId)}?version=${version}` },
    z.null(),
  ),
}

/** Session 和消息 API。 */
export const sessionEndpoints = {
  list: (workspaceId: string) => apiRequest(
    { method: 'GET', url: `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions` },
    z.array(sessionDtoSchema),
  ),
  create: (workspaceId: string, input: CreateSessionRequest) => {
    const payload = createSessionRequestSchema.parse(input)
    return apiRequest(
      { method: 'POST', url: `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`, data: payload },
      sessionCreationResultSchema,
    )
  },
  snapshot: (sessionId: string) => apiRequest(
    { method: 'GET', url: `/api/sessions/${encodeURIComponent(sessionId)}/snapshot` },
    sessionSnapshotDtoSchema,
  ),
  addAgentSlot: (sessionId: string, input: AddAgentSlotRequest) => {
    const payload = addAgentSlotRequestSchema.parse(input)
    return apiRequest(
      { method: 'POST', url: `/api/sessions/${encodeURIComponent(sessionId)}/agents`, data: payload },
      agentSlotDtoSchema,
    )
  },
  removeAgentSlot: (sessionId: string, slotId: string) => apiRequest(
    {
      method: 'DELETE',
      url: `/api/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(slotId)}`,
    },
    z.null(),
  ),
  sendMessage: (sessionId: string, input: SendMessageRequest) => {
    const payload = sendMessageRequestSchema.parse(input)
    return apiRequest(
      { method: 'POST', url: `/api/sessions/${encodeURIComponent(sessionId)}/messages`, data: payload },
      turnCreationResultSchema,
    )
  },
  handoff: (sessionId: string, input: HandoffRequest) => {
    const payload = handoffRequestSchema.parse(input)
    return apiRequest(
      { method: 'POST', url: `/api/sessions/${encodeURIComponent(sessionId)}/handoffs`, data: payload },
      messageDtoSchema,
    )
  },
}

/** Artifact metadata 分页与按需正文 API。 */
export const artifactEndpoints = {
  list: (sessionId: string, query: ArtifactPageQuery) => {
    const parsed = artifactPageQuerySchema.parse(query)
    const search = new URLSearchParams({ limit: String(parsed.limit) })
    if (parsed.cursor !== undefined) {
      search.set('cursor', parsed.cursor)
    }
    return apiRequest(
      { method: 'GET', url: `/api/sessions/${encodeURIComponent(sessionId)}/artifacts?${search.toString()}` },
      artifactPageDtoSchema,
    )
  },
  content: (sessionId: string, artifactId: string) => apiRequest(
    {
      method: 'GET',
      url: `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/content`,
    },
    artifactContentDtoSchema,
  ),
}

/** Mailbox 收件 API。 */
export const mailboxEndpoints = {
  list: (sessionId: string, query: MailboxPageQuery) => {
    const parsed = mailboxPageQuerySchema.parse(query)
    const search = new URLSearchParams({ slot_id: parsed.slot_id, limit: String(parsed.limit) })
    if (parsed.cursor !== undefined) {
      search.set('cursor', parsed.cursor)
    }
    return apiRequest(
      { method: 'GET', url: `/api/sessions/${encodeURIComponent(sessionId)}/mailbox?${search.toString()}` },
      mailboxPageDtoSchema,
    )
  },
  detail: (sessionId: string, messageId: string, slotId: string) => apiRequest(
    {
      method: 'GET',
      url: `/api/sessions/${encodeURIComponent(sessionId)}/mailbox/${encodeURIComponent(messageId)}`
        + `?slot_id=${encodeURIComponent(slotId)}`,
    },
    mailboxMessageDetailDtoSchema,
  ),
  markRead: (sessionId: string, messageId: string, input: MailboxMarkReadRequest) => {
    const payload = mailboxMarkReadRequestSchema.parse(input)
    return apiRequest(
      {
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(sessionId)}/mailbox/${encodeURIComponent(messageId)}/read`,
        data: payload,
      },
      mailboxMarkReadDtoSchema,
    )
  },
}

/** Run 命令 API（cancel / resume / retry）。 */
export const runEndpoints = {
  cancel: (runId: string, input: RunCommandRequest) => {
    const payload = runCommandRequestSchema.parse(input)
    return apiRequest(
      { method: 'POST', url: `/api/runs/${encodeURIComponent(runId)}/cancel`, data: payload },
      runCommandReceiptSchema,
    )
  },
  resume: (runId: string, input: RunCommandRequest) => {
    const payload = runCommandRequestSchema.parse(input)
    return apiRequest(
      { method: 'POST', url: `/api/runs/${encodeURIComponent(runId)}/resume`, data: payload },
      runCommandReceiptSchema,
    )
  },
  retry: (runId: string, input: RunCommandRequest) => {
    const payload = runCommandRequestSchema.parse(input)
    return apiRequest(
      { method: 'POST', url: `/api/runs/${encodeURIComponent(runId)}/retry`, data: payload },
      runCommandReceiptSchema,
    )
  },
}

/** 权限回答 API。 */
export const permissionEndpoints = {
  answer: (requestId: string, optionId: string) => apiRequest(
    {
      method: 'POST',
      url: `/api/permissions/${encodeURIComponent(requestId)}/answer`,
      data: { option_id: optionId },
    },
    z.null(),
  ),
}
