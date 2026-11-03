import { z } from 'zod'

export const isoDateTimeSchema = z.string().datetime({ offset: true })
export const identifierSchema = z.string().min(1)
export const optionalIdentifierSchema = identifierSchema.optional()

/**
 * JSON-RPC request ID 的唯一合法域。
 *
 * 类型本身是身份的一部分（number `1` 与 string `"1"` 不是同一个请求），
 * 因此不能用统一转成 string 的 schema。上限必须是 safe integer：超出
 * `Number.MAX_SAFE_INTEGER` 的整数无法在 JS 中保真往返，会在持久化层被丢弃，
 * 从而留下无法应答的权限 pending。
 *
 * 该谓词是 ACP ingress、Contract、Runtime、SQLite codec 的**唯一**判据。
 */
export function isJsonRpcRequestId(value: unknown): value is string | number {
  if (typeof value === 'string') {
    return value.length > 0
  }
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/**
 * JSON-RPC request ID：非空 string 或 JS safe integer。
 *
 * 用 `refine` 复用 `isJsonRpcRequestId`，避免 schema 与运行时谓词各自演化。
 */
const jsonRpcRequestIdSchema = z.union([z.string(), z.number()]).refine(isJsonRpcRequestId, {
  message: 'request id must be a non-empty string or a safe integer',
})

const ROLE_TEXT_MAX_LENGTH = 20_000
const ROLE_DESCRIPTION_MAX_LENGTH = 2_000
const ROLE_LIST_MAX_ITEMS = 64
const ROLE_LIST_ITEM_MAX_LENGTH = 2_000
const RUNTIME_OPTION_MAX_KEYS = 32
const RUNTIME_OPTION_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/
/** 判断 runtime_options 键是否可能承载凭据。 */
export function isSensitiveRuntimeOptionKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (normalized === 'maxoutputtokens') {
    return false
  }
  return normalized.includes('apikey')
    || normalized.includes('accesstoken')
    || normalized.includes('refreshtoken')
    || normalized.includes('authorization')
    || normalized.includes('clientsecret')
    || normalized.includes('privatekey')
    || normalized.includes('clientkey')
    || normalized.includes('signingkey')
    || normalized.includes('credential')
    || normalized.includes('password')
    || normalized.includes('secret')
    || normalized.includes('token')
    || normalized.includes('auth')
}

const roleListSchema = z.array(z.string().trim().min(1).max(ROLE_LIST_ITEM_MAX_LENGTH)).max(ROLE_LIST_MAX_ITEMS)
const runtimeOptionValueSchema = z.union([
  z.string().max(ROLE_LIST_ITEM_MAX_LENGTH),
  z.number().finite().min(-1_000_000_000).max(1_000_000_000),
  z.boolean(),
])
const runtimeOptionsSchema = z
  .record(z.string().regex(RUNTIME_OPTION_KEY_PATTERN), runtimeOptionValueSchema)
  .refine((value) => Object.keys(value).length <= RUNTIME_OPTION_MAX_KEYS, {
    message: `runtime_options 最多支持 ${RUNTIME_OPTION_MAX_KEYS} 个键`,
  })
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (isSensitiveRuntimeOptionKey(key)) {
        context.addIssue({ code: 'custom', path: [key], message: 'runtime_options 不得包含凭据字段' })
      }
    }
  })

const roleMutableFieldSchemas = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(ROLE_DESCRIPTION_MAX_LENGTH),
  system_prompt: z.string().max(ROLE_TEXT_MAX_LENGTH),
  required_guidelines: roleListSchema,
  gates: roleListSchema,
  output_contract: z.string().max(ROLE_TEXT_MAX_LENGTH),
  blocking_conditions: roleListSchema,
  selectable: z.boolean(),
  dispatchable: z.boolean(),
}

const roleBindingMutableFieldSchemas = {
  role_id: identifierSchema,
  provider_connection_id: identifierSchema,
  model_id: identifierSchema,
  runtime_options: runtimeOptionsSchema,
  priority: z.number().int().nonnegative().max(1_000_000),
  enabled: z.boolean(),
}

/** ProviderConnection 的环境继承方式。 */
export const environmentModeSchema = z.enum(['inherited', 'isolated'])
export type EnvironmentMode = z.infer<typeof environmentModeSchema>

/** ProviderConnection 的连接类型。 */
export const connectionKindSchema = z.enum(['local', 'api_key', 'custom_endpoint'])
export type ConnectionKind = z.infer<typeof connectionKindSchema>

/** 支持的 Provider 类型。 */
export const providerKindSchema = z.enum(['claude', 'codex'])
export type ProviderKind = z.infer<typeof providerKindSchema>

/** 通用生命周期状态。 */
export const runStatusSchema = z.enum([
  'queued',
  'running',
  'cancelling',
  'waiting_user',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])
export type RunStatus = z.infer<typeof runStatusSchema>

/** Task 生命周期状态。 */
export const taskStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])
export type TaskStatus = z.infer<typeof taskStatusSchema>

/** Session 生命周期状态。 */
export const sessionStatusSchema = z.enum(['active', 'paused', 'completed', 'archived'])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

/** AgentSlot 生命周期状态。 */
export const agentSlotStatusSchema = z.enum(['idle', 'running', 'waiting_user', 'stopped'])
export type AgentSlotStatus = z.infer<typeof agentSlotStatusSchema>

/** 不允许把凭据携带在 URL 中的公共 Base URL Schema。 */
export const nonSecretBaseUrlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
      && url.hostname.length > 0
      && url.username.length === 0
      && url.password.length === 0
      && url.search.length === 0
      && url.hash.length === 0
  } catch {
    return false
  }
}, { message: 'base_url 不能包含凭据、查询参数或片段' })

/** Codex ProviderConnection 中可持久化的非秘密配置。 */
export const codexConnectionConfigSchema = z
  .object({
    model_provider: z.string().trim().min(1).max(120).optional(),
    model: z.string().trim().min(1).max(240).optional(),
    wire_api: z.string().trim().min(1).max(64).optional(),
    reasoning_effort: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
export type CodexConnectionConfig = z.infer<typeof codexConnectionConfigSchema>

/** ProviderConnection DTO Schema。 */
export const providerConnectionDtoSchema = z
  .object({
    id: identifierSchema,
    workspace_id: identifierSchema,
    provider_definition_id: optionalIdentifierSchema,
    provider_kind: providerKindSchema,
    connection_kind: connectionKindSchema,
    base_url: nonSecretBaseUrlSchema.optional(),
    credential_ref: identifierSchema.optional(),
    environment_mode: environmentModeSchema,
    codex_config: codexConnectionConfigSchema.optional(),
    config_revision: z.number().int().positive().default(1),
    created_at: isoDateTimeSchema.optional(),
    updated_at: isoDateTimeSchema.optional(),
  })
  .strict()
export type ProviderConnectionDto = z.infer<typeof providerConnectionDtoSchema>

/** Workspace DTO Schema。 */
export const workspaceDtoSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(120),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .strict()
export type WorkspaceDto = z.infer<typeof workspaceDtoSchema>

/** ProviderDefinition DTO Schema。 */
export const providerDefinitionDtoSchema = z
  .object({
    id: identifierSchema,
    provider_kind: providerKindSchema,
    display_name: z.string().min(1),
    adapter_command: z.string().min(1),
    adapter_args: z.array(z.string()),
    adapter_version: z.string().min(1),
  })
  .strict()
export type ProviderDefinitionDto = z.infer<typeof providerDefinitionDtoSchema>

/** 模型目录条目 DTO Schema。 */
export const modelCatalogEntryDtoSchema = z
  .object({
    id: identifierSchema,
    workspace_id: identifierSchema,
    provider_connection_id: identifierSchema,
    provider_kind: providerKindSchema,
    model_id: identifierSchema,
    display_name: z.string().min(1),
    capabilities: z.record(z.string(), z.unknown()),
    observed_at: isoDateTimeSchema,
  })
  .strict()
export type ModelCatalogEntryDto = z.infer<typeof modelCatalogEntryDtoSchema>

/** Role DTO Schema。 */
export const roleDtoSchema = z
  .object({
    id: identifierSchema,
    workspace_id: identifierSchema,
    ...roleMutableFieldSchemas,
    required_guidelines: roleListSchema,
    gates: roleListSchema,
    blocking_conditions: roleListSchema,
    selectable: z.boolean(),
    dispatchable: z.boolean(),
    version: z.number().int().positive(),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .strict()
export type RoleDto = z.infer<typeof roleDtoSchema>

/** Role 与 ProviderConnection、Model 的绑定 DTO Schema。 */
export const roleBindingDtoSchema = z
  .object({
    id: identifierSchema,
    workspace_id: identifierSchema,
    ...roleBindingMutableFieldSchemas,
    runtime_options: runtimeOptionsSchema,
    version: z.number().int().positive(),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .strict()
export type RoleBindingDto = z.infer<typeof roleBindingDtoSchema>

/** 创建 Role 请求 Schema。 */
export const createRoleRequestSchema = z
  .object({
    ...roleMutableFieldSchemas,
    description: roleMutableFieldSchemas.description.optional(),
    system_prompt: roleMutableFieldSchemas.system_prompt.optional(),
    required_guidelines: roleMutableFieldSchemas.required_guidelines.optional(),
    gates: roleMutableFieldSchemas.gates.optional(),
    output_contract: roleMutableFieldSchemas.output_contract.optional(),
    blocking_conditions: roleMutableFieldSchemas.blocking_conditions.optional(),
    selectable: roleMutableFieldSchemas.selectable.optional(),
    dispatchable: roleMutableFieldSchemas.dispatchable.optional(),
  })
  .strict()
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>

/** 更新 Role 请求 Schema。PATCH 必须携带当前 version。 */
export const updateRoleRequestSchema = z
  .object({
    name: roleMutableFieldSchemas.name.optional(),
    description: roleMutableFieldSchemas.description.optional(),
    system_prompt: roleMutableFieldSchemas.system_prompt.optional(),
    required_guidelines: roleMutableFieldSchemas.required_guidelines.optional(),
    gates: roleMutableFieldSchemas.gates.optional(),
    output_contract: roleMutableFieldSchemas.output_contract.optional(),
    blocking_conditions: roleMutableFieldSchemas.blocking_conditions.optional(),
    selectable: roleMutableFieldSchemas.selectable.optional(),
    dispatchable: roleMutableFieldSchemas.dispatchable.optional(),
    version: z.number().int().positive(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
    message: 'PATCH 至少需要一个可更新字段',
  })
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>

/** 创建 RoleBinding 请求 Schema。 */
export const createRoleBindingRequestSchema = z
  .object({
    role_id: roleBindingMutableFieldSchemas.role_id,
    provider_connection_id: roleBindingMutableFieldSchemas.provider_connection_id,
    model_id: roleBindingMutableFieldSchemas.model_id,
    runtime_options: roleBindingMutableFieldSchemas.runtime_options.optional(),
    priority: roleBindingMutableFieldSchemas.priority.optional(),
    enabled: roleBindingMutableFieldSchemas.enabled.optional(),
  })
  .strict()
export type CreateRoleBindingRequest = z.infer<typeof createRoleBindingRequestSchema>

/** 更新 RoleBinding 请求 Schema。PATCH 必须携带当前 version。 */
export const updateRoleBindingRequestSchema = z
  .object({
    role_id: roleBindingMutableFieldSchemas.role_id.optional(),
    provider_connection_id: roleBindingMutableFieldSchemas.provider_connection_id.optional(),
    model_id: roleBindingMutableFieldSchemas.model_id.optional(),
    runtime_options: roleBindingMutableFieldSchemas.runtime_options.optional(),
    priority: roleBindingMutableFieldSchemas.priority.optional(),
    enabled: roleBindingMutableFieldSchemas.enabled.optional(),
    version: z.number().int().positive(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
    message: 'PATCH 至少需要一个可更新字段',
  })
export type UpdateRoleBindingRequest = z.infer<typeof updateRoleBindingRequestSchema>

/** Session DTO Schema。 */
export const sessionDtoSchema = z
  .object({
    id: identifierSchema,
    workspace_id: identifierSchema,
    name: z.string().min(1),
    status: sessionStatusSchema,
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .strict()
export type SessionDto = z.infer<typeof sessionDtoSchema>

/** 单 Agent Slot DTO Schema。 */
export const agentSlotDtoSchema = z
  .object({
    id: identifierSchema,
    session_id: identifierSchema,
    role_binding_id: optionalIdentifierSchema,
    model_id: identifierSchema,
    status: agentSlotStatusSchema,
    created_at: isoDateTimeSchema,
  })
  .strict()
export type AgentSlotDto = z.infer<typeof agentSlotDtoSchema>

/** Run DTO Schema。 */
export const runDtoSchema = z
  .object({
    id: identifierSchema,
    workspace_id: identifierSchema,
    session_id: identifierSchema,
    status: runStatusSchema,
    attempt: z.number().int().positive(),
    started_at: isoDateTimeSchema.optional(),
    ended_at: isoDateTimeSchema.optional(),
    error_code: z.string().optional(),
    /** 该 Run 由哪一个 Run retry 而来；旧数据缺省。 */
    retry_of_run_id: identifierSchema.optional(),
    created_at: isoDateTimeSchema.optional(),
    updated_at: isoDateTimeSchema.optional(),
  })
  .strict()
export type RunDto = z.infer<typeof runDtoSchema>

/** Task DTO Schema。 */
export const taskDtoSchema = z
  .object({
    id: identifierSchema,
    workspace_id: identifierSchema,
    session_id: identifierSchema,
    run_id: identifierSchema,
    slot_id: identifierSchema,
    title: z.string().min(1),
    status: taskStatusSchema,
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .strict()
export type TaskDto = z.infer<typeof taskDtoSchema>

/** Message DTO Schema。 */
export const messageDtoSchema = z
  .object({
    id: identifierSchema,
    session_id: identifierSchema,
    run_id: z.union([identifierSchema, z.null()]).optional(),
    sender_kind: z.enum(['user', 'agent', 'system']),
    sender_id: z.union([identifierSchema, z.null()]).optional(),
    content: z.string(),
    created_at: isoDateTimeSchema,
    /** handoff Message 标记；旧消息省略。 */
    kind: z.literal('handoff').optional(),
    /** handoff 的接收 Slot；旧消息省略。 */
    to_slot_id: identifierSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'handoff' && value.to_slot_id === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['to_slot_id'],
        message: 'handoff message requires to_slot_id',
      })
    }
  })
export type MessageDto = z.infer<typeof messageDtoSchema>

/** Adapter 权限选项 Schema。 */
export const permissionOptionSchema = z
  .object({
    option_id: identifierSchema,
    name: z.string().min(1),
    kind: z.enum(['allow_once', 'allow_always', 'reject_once']),
  })
  .strict()
export type PermissionOption = z.infer<typeof permissionOptionSchema>

/** PermissionRequest DTO Schema。 */
export const permissionRequestDtoSchema = z
  .object({
    id: identifierSchema,
    run_id: identifierSchema,
    task_id: identifierSchema,
    slot_id: identifierSchema,
    capability: identifierSchema,
    description: z.string().min(1),
    adapter_options: z.array(permissionOptionSchema),
    status: z.enum(['pending', 'answered', 'expired']),
    requested_at: isoDateTimeSchema,
    soft_timeout_at: isoDateTimeSchema,
    overdue_at: isoDateTimeSchema.optional(),
    expires_at: isoDateTimeSchema.optional(),
    expired_at: isoDateTimeSchema.optional(),
    answered_at: isoDateTimeSchema.optional(),
    selected_option_id: identifierSchema.optional(),
    /** 保留 Adapter JSON-RPC request ID 的原始类型。 */
    adapter_request_id: jsonRpcRequestIdSchema.optional(),
    expiration_reason: z.enum(['timeout', 'runtime_unavailable', 'cancelled']).optional(),
  })
  .strict()
export type PermissionRequestDto = z.infer<typeof permissionRequestDtoSchema>

/** Session 重连综合快照 Schema。 */
export const sessionSnapshotDtoSchema = z
  .object({
    session: sessionDtoSchema,
    agent_slots: z.array(agentSlotDtoSchema),
    runs: z.array(runDtoSchema),
    tasks: z.array(taskDtoSchema),
    messages: z.array(messageDtoSchema),
    permissions: z.array(permissionRequestDtoSchema),
    latest_sequences: z.record(identifierSchema, z.number().int().nonnegative()),
  })
  .strict()
export type SessionSnapshotDto = z.infer<typeof sessionSnapshotDtoSchema>

/** Provider 能力快照 Schema。 */
export const capabilitySnapshotSchema = z
  .object({
    provider_kind: providerKindSchema,
    adapter_version: identifierSchema,
    source: z.enum(['acp_handshake', 'provider_api', 'local_config', 'manual']),
    observed_at: isoDateTimeSchema,
    capabilities: z.record(z.string(), z.unknown()),
  })
  .strict()
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>

/** ACP Runtime 归一化事件 Schema。 */
export const runtimeEventSchema = z
  .object({
    session_id: identifierSchema,
    kind: z.enum([
      'agent_message_chunk',
      'agent_thought_chunk',
      'tool_call',
      'tool_call_update',
      'available_commands_update',
      'permission_requested',
      'turn_completed',
      'turn_cancelled',
      'adapter_crashed',
    ]),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>

/** Rolecast 事件信封 Schema。 */
export const eventEnvelopeSchema = z
  .object({
    event_id: identifierSchema,
    schema_version: z.number().int().positive(),
    workspace_id: identifierSchema,
    session_id: identifierSchema,
    run_id: identifierSchema,
    sequence: z.number().int().nonnegative(),
    type: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
    source: identifierSchema,
    occurred_at: isoDateTimeSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>

/** 运行命令 Schema。 */
export const runCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start'), run_id: identifierSchema, request_id: identifierSchema }).strict(),
  z.object({ kind: z.literal('cancel'), run_id: identifierSchema, request_id: identifierSchema }).strict(),
  z.object({ kind: z.literal('resume'), run_id: identifierSchema, request_id: identifierSchema }).strict(),
  z.object({ kind: z.literal('retry'), run_id: identifierSchema, request_id: identifierSchema }).strict(),
])
export type RunCommand = z.infer<typeof runCommandSchema>

/** 统一错误码表。 */
export const ERROR_CODES = {
  invalid_request: 'invalid_request',
  invalid_response: 'invalid_response',
  unauthorized: 'unauthorized',
  not_found: 'not_found',
  state_conflict: 'state_conflict',
  command_outcome_ambiguous: 'command_outcome_ambiguous',
  slot_busy: 'slot_busy',
  permission_not_found: 'permission_not_found',
  permission_timeout: 'permission_timeout',
  permission_option_invalid: 'permission_option_invalid',
  provider_needs_configuration: 'provider_needs_configuration',
  credentials_unavailable: 'credentials_unavailable',
  adapter_start_failed: 'adapter_start_failed',
  adapter_crashed: 'adapter_crashed',
  handshake_failed: 'handshake_failed',
  session_create_failed: 'session_create_failed',
  turn_cancelled: 'turn_cancelled',
  db_unavailable: 'db_unavailable',
  migration_failed: 'migration_failed',
  internal_error: 'internal_error',
  workspace_not_found: 'workspace_not_found',
  role_not_found: 'role_not_found',
  binding_not_found: 'binding_not_found',
  model_unavailable: 'model_unavailable',
  resource_in_use: 'resource_in_use',
  config_import_invalid: 'config_import_invalid',
  config_import_not_found: 'config_import_not_found',
  config_import_stale: 'config_import_stale',
  config_import_target_conflict: 'config_import_target_conflict',
  credential_not_found: 'credential_not_found',
  credential_denied: 'credential_denied',
  credential_invalid: 'credential_invalid',
  credential_required: 'credential_required',
  credential_environment_mismatch: 'credential_environment_mismatch',
  unsupported_option: 'unsupported_option',
  provider_capability_not_supported: 'provider_capability_not_supported',
  context_source_missing: 'context_source_missing',
  codex_custom_endpoint_unverified: 'codex_custom_endpoint_unverified',
  source_history_unavailable: 'source_history_unavailable',
  source_event_payload_too_large: 'source_event_payload_too_large',
  handoff_content_too_large: 'handoff_content_too_large',
} as const
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** 统一 API 错误信封 Schema。 */
export const apiErrorSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()),
    request_id: identifierSchema,
  })
  .strict()
export type ApiError = z.infer<typeof apiErrorSchema>

/** 成功响应信封的运行时 Schema 工厂。 */
export function apiSuccessEnvelopeSchema<T extends z.ZodType>(dataSchema: T): z.ZodObject<{
  ok: z.ZodLiteral<true>
  data: T
}> {
  return z.object({ ok: z.literal(true), data: dataSchema }).strict()
}

/** 失败响应信封 Schema。 */
export const apiFailureEnvelopeSchema = z
  .object({ ok: z.literal(false), error: apiErrorSchema })
  .strict()

/** 创建 Workspace 请求 Schema。 */
export const createWorkspaceRequestSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict()
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>

/** 创建 ProviderConnection 请求 Schema。 */
export const createProviderConnectionRequestSchema = z
  .object({
    provider_kind: providerKindSchema,
    connection_kind: connectionKindSchema,
    base_url: nonSecretBaseUrlSchema.optional(),
    credential_ref: identifierSchema.optional(),
    environment_mode: environmentModeSchema,
  })
  .strict()
export type CreateProviderConnectionRequest = z.infer<typeof createProviderConnectionRequestSchema>

/**
 * ProviderConnection 非秘密更新请求 Schema。
 *
 * 只允许修正连接类型、环境模式、非秘密 `base_url` 与既有 `credential_ref`；
 * `null` 表示清空。`codex_config` 只允许 `null`，用于清除历史遗留配置，
 * 任意写入只能经配置导入。不接受 Secret、Token 或任何认证会话字段。
 */
export const updateProviderConnectionRequestSchema = z
  .object({
    connection_kind: connectionKindSchema.optional(),
    environment_mode: environmentModeSchema.optional(),
    base_url: nonSecretBaseUrlSchema.nullable().optional(),
    credential_ref: identifierSchema.nullable().optional(),
    /** 只允许用 null 清除遗留配置，不接受任意写入。 */
    codex_config: z.null().optional(),
    config_revision: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'config_revision'),
    { message: 'PATCH 至少需要一个可更新字段' },
  )
export type UpdateProviderConnectionRequest = z.infer<typeof updateProviderConnectionRequestSchema>

/**
 * Credential 创建请求中 Secret 的字符上限。
 *
 * 这是 wire 层保护；CredentialStore 仍按 UTF-8 字节数做最终判定，
 * 多字节字符可能通过字符上限后被 Store 以 `credential_invalid` 拒绝。
 */
const CREDENTIAL_SECRET_MAX_CHARS = 64 * 1024

/**
 * 创建 API key 凭据请求 Schema。
 *
 * `idempotency_key` 是客户端为**单次创建操作**生成的 UUID，与链路追踪的
 * `X-Request-Id` 无关：同一 key + 同一 Secret 重试返回同一引用；同一 key +
 * 不同 Secret 会被拒绝，不会覆盖既有凭据。
 */
export const createCredentialRequestSchema = z
  .object({
    idempotency_key: z.uuid(),
    secret: z
      .string()
      .min(1)
      .max(CREDENTIAL_SECRET_MAX_CHARS)
      .refine((value) => !/[\r\n]/.test(value), {
        message: 'Secret 不能包含换行',
      }),
  })
  .strict()
export type CreateCredentialRequest = z.infer<typeof createCredentialRequestSchema>

/** 创建凭据响应 DTO：只返回不透明引用，永不回显 Secret。 */
export const credentialReferenceDtoSchema = z
  .object({ credential_ref: identifierSchema })
  .strict()
export type CredentialReferenceDto = z.infer<typeof credentialReferenceDtoSchema>

/** Codex 配置导入 preview 请求 Schema。 */
export const codexConfigImportPreviewRequestSchema = z
  .object({
    source_path: z.string().trim().min(1).max(4_096),
  })
  .strict()
export type CodexConfigImportPreviewRequest = z.infer<typeof codexConfigImportPreviewRequestSchema>

const codexConfigImportModelSchema = z
  .object({
    model_id: z.string().trim().min(1).max(240),
    display_name: z.string().trim().min(1).max(240),
  })
  .strict()

/** Codex 配置导入 preview 的脱敏结果 Schema。 */
export const codexConfigImportPreviewSchema = z
  .object({
    preview_id: identifierSchema,
    provider_id: identifierSchema,
    workspace_id: identifierSchema,
    source_name: z.string().trim().min(1).max(255),
    source_digest: z.string().regex(/^[a-f0-9]{64}$/),
    target_config_revision: z.number().int().positive(),
    base_url: nonSecretBaseUrlSchema.optional(),
    codex_config: codexConnectionConfigSchema,
    models: z.array(codexConfigImportModelSchema).max(64),
    warnings: z.array(z.string().trim().min(1).max(240)).max(32),
  })
  .strict()
export type CodexConfigImportPreview = z.infer<typeof codexConfigImportPreviewSchema>

/** Codex 配置导入 apply 请求 Schema。 */
export const codexConfigImportApplyRequestSchema = z
  .object({
    preview_id: identifierSchema,
    confirmed: z.literal(true),
    target_config_revision: z.number().int().positive(),
    credential_ref: identifierSchema.optional(),
  })
  .strict()
export type CodexConfigImportApplyRequest = z.infer<typeof codexConfigImportApplyRequestSchema>

/** 创建 Session 请求 Schema。 */
export const createSessionRequestSchema = z.union([
  z.object({
    name: z.string().trim().min(1).max(120),
    provider_connection_id: identifierSchema,
    model_id: identifierSchema,
  }).strict(),
  z.object({
    name: z.string().trim().min(1).max(120),
    role_binding_id: identifierSchema,
  }).strict(),
])
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>

/** 添加 AgentSlot 请求 Schema。 */
export const addAgentSlotRequestSchema = z
  .object({ role_binding_id: identifierSchema, request_id: identifierSchema.optional() })
  .strict()
export type AddAgentSlotRequest = z.infer<typeof addAgentSlotRequestSchema>

/** 发送消息请求 Schema。 */
export const sendMessageRequestSchema = z
  .object({
    content: z.string().trim().min(1).max(64_000),
    request_id: identifierSchema.optional(),
    agent_slot_id: identifierSchema.optional(),
  })
  .strict()
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>

/**
 * Run 命令请求 Schema（cancel / resume / retry）。
 *
 * `request_id` 是客户端幂等键：同键同命令重放返回既有结果，不同参数返回 409。
 */
export const runCommandRequestSchema = z
  .object({ request_id: identifierSchema })
  .strict()
export type RunCommandRequest = z.infer<typeof runCommandRequestSchema>

/** Run 命令回执状态。 */
export const runCommandStatusSchema = z.enum([
  'reserved',
  'running',
  'completed',
  'failed',
  'ambiguous',
])
export type RunCommandStatus = z.infer<typeof runCommandStatusSchema>

/** Run 命令回执 DTO；不包含输入内容、hashes 或任何 Secret。 */
export const runCommandReceiptSchema = z
  .object({
    request_id: identifierSchema,
    status: runCommandStatusSchema,
    run_id: identifierSchema.optional(),
    task_id: identifierSchema.optional(),
    error_code: z.string().optional(),
  })
  .strict()
export type RunCommandReceipt = z.infer<typeof runCommandReceiptSchema>

/** 权限回答请求 Schema。 */
export const permissionAnswerRequestSchema = z
  .object({ option_id: identifierSchema, request_id: identifierSchema.optional() })
  .strict()
export type PermissionAnswerRequest = z.infer<typeof permissionAnswerRequestSchema>

/** WebSocket 客户端控制消息 Schema。 */
export const wsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1), workspace_id: identifierSchema }).strict(),
  z
    .object({
      type: z.literal('resume'),
      runs: z.array(z.object({ run_id: identifierSchema, last_sequence: z.number().int().nonnegative() }).strict()),
    })
    .strict(),
])
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>

/** WebSocket 服务端控制消息 Schema。 */
export const wsServerControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('authenticated') }).strict(),
  z.object({ type: z.literal('snapshot_required'), session_id: identifierSchema }).strict(),
])
export type WsServerControl = z.infer<typeof wsServerControlSchema>
