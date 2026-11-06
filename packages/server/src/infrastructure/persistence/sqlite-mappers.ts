import { decodeJsonRpcRequestId, encodeJsonRpcRequestId } from './json-rpc-request-id-codec.js'
import type { AgentSlotRoleSnapshotRecord, RuntimeAttachmentRecord } from '../../application/ports/repository-port.js'
import type {
  AgentSlotDto,
  EventEnvelope,
  MessageDto,
  PermissionRequestDto,
  RunDto,
  SessionDto,
  TaskDto,
  WorkspaceDto,
  WorkspaceRootPathDto,
} from '@rolecast/contract'

type Row = Record<string, unknown>

const toAdapterRequestIdField = (
  value: unknown,
): Pick<PermissionRequestDto, 'adapter_request_id'> => {
  const decoded = decodeJsonRpcRequestId(value)
  return decoded === null ? {} : { adapter_request_id: decoded }
}
const toOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const toNullableString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null
const parseJson = (value: unknown): Record<string, unknown> => {
  const text = String(value)
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
}

export const toWorkspace = (row: Row): WorkspaceDto => ({
  id: String(row.id),
  name: String(row.name),
  created_at: String(row.created_at),
  updated_at: String(row.updated_at),
})

/**
 * @name toWorkspaceRootPath
 * @description 将 Workspace 根路径列转换为独立配置 DTO
 * @param {Row} row SQLite Workspace 行
 * @return {WorkspaceRootPathDto} Workspace 根路径状态
 */
export const toWorkspaceRootPath = (row: Row): WorkspaceRootPathDto => ({
  workspace_id: String(row.id),
  root_path: toNullableString(row.root_path),
})

export const toSession = (row: Row): SessionDto => ({
  id: String(row.id),
  workspace_id: String(row.workspace_id),
  name: String(row.name),
  status: row.status as SessionDto['status'],
  created_at: String(row.created_at),
  updated_at: String(row.updated_at),
})

export const toAgentSlot = (row: Row): AgentSlotDto => ({
  id: String(row.id),
  session_id: String(row.session_id),
  ...(toOptionalString(row.role_binding_id) === undefined ? {} : { role_binding_id: String(row.role_binding_id) }),
  model_id: String(row.model_id),
  status: row.status as AgentSlotDto['status'],
  created_at: String(row.created_at),
})

const parseStringArray = (value: unknown): readonly string[] => {
  const parsed: unknown = JSON.parse(String(value))
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('invalid private Role snapshot')
  }
  return parsed
}

export const toRuntimeAttachment = (row: Row): RuntimeAttachmentRecord => ({
  slot_id: String(row.slot_id),
  session_id: String(row.session_id),
  provider_connection_id: String(row.provider_connection_id),
  provider_kind: row.provider_kind as RuntimeAttachmentRecord['provider_kind'],
  config_revision: Number(row.config_revision),
  adapter_version: String(row.adapter_version),
  adapter_fingerprint: typeof row.adapter_fingerprint === 'string' ? row.adapter_fingerprint : null,
  cwd: String(row.cwd),
  runtime_directory: String(row.runtime_directory),
  acp_session_id: String(row.acp_session_id),
  updated_at: String(row.updated_at),
})

export const toAgentSlotRoleSnapshot = (row: Row): AgentSlotRoleSnapshotRecord => ({
  slot_id: String(row.slot_id),
  workspace_id: String(row.workspace_id),
  role_binding_id: String(row.role_binding_id),
  role_binding_version: Number(row.role_binding_version),
  role_id: String(row.role_id),
  role_version: Number(row.role_version),
  role_name: String(row.role_name),
  system_prompt: String(row.system_prompt),
  required_guidelines: parseStringArray(row.required_guidelines_json),
  output_contract: String(row.output_contract),
  created_at: String(row.created_at),
})

export const toRun = (row: Row): RunDto => ({
  id: String(row.id),
  workspace_id: String(row.workspace_id),
  session_id: String(row.session_id),
  status: row.status as RunDto['status'],
  attempt: Number(row.attempt),
  ...(toOptionalString(row.started_at) === undefined ? {} : { started_at: String(row.started_at) }),
  ...(toOptionalString(row.ended_at) === undefined ? {} : { ended_at: String(row.ended_at) }),
  ...(toOptionalString(row.error_code) === undefined ? {} : { error_code: String(row.error_code) }),
  ...(toOptionalString(row.retry_of_run_id) === undefined ? {} : { retry_of_run_id: String(row.retry_of_run_id) }),
  ...(toOptionalString(row.created_at) === undefined ? {} : { created_at: String(row.created_at) }),
  ...(toOptionalString(row.updated_at) === undefined ? {} : { updated_at: String(row.updated_at) }),
})

export const toTask = (row: Row): TaskDto => ({
  id: String(row.id),
  workspace_id: String(row.workspace_id),
  session_id: String(row.session_id),
  run_id: String(row.run_id),
  slot_id: String(row.slot_id),
  title: String(row.title),
  status: row.status as TaskDto['status'],
  created_at: String(row.created_at),
  updated_at: String(row.updated_at),
})

export const toMessage = (row: Row): MessageDto => ({
  id: String(row.id),
  session_id: String(row.session_id),
  ...(toNullableString(row.run_id) === null ? { run_id: null } : { run_id: String(row.run_id) }),
  sender_kind: row.sender_kind as MessageDto['sender_kind'],
  ...(toNullableString(row.sender_id) === null ? { sender_id: null } : { sender_id: String(row.sender_id) }),
  content: String(row.content),
  created_at: String(row.created_at),
  ...(row.kind === 'handoff' ? { kind: 'handoff' as const } : {}),
  ...(toOptionalString(row.to_slot_id) === undefined ? {} : { to_slot_id: String(row.to_slot_id) }),
})

export const toPermission = (row: Row): PermissionRequestDto => ({
  id: String(row.id),
  run_id: String(row.run_id),
  task_id: String(row.task_id),
  slot_id: String(row.slot_id),
  capability: String(row.capability),
  description: String(row.description),
  adapter_options: JSON.parse(String(row.adapter_options_json)) as PermissionRequestDto['adapter_options'],
  status: row.status as PermissionRequestDto['status'],
  requested_at: String(row.requested_at),
  soft_timeout_at: String(row.soft_timeout_at),
  ...(toOptionalString(row.overdue_at) === undefined ? {} : { overdue_at: String(row.overdue_at) }),
  ...(toOptionalString(row.expires_at) === undefined ? {} : { expires_at: String(row.expires_at) }),
  ...(toOptionalString(row.expired_at) === undefined ? {} : { expired_at: String(row.expired_at) }),
  ...(toOptionalString(row.answered_at) === undefined ? {} : { answered_at: String(row.answered_at) }),
  ...(toOptionalString(row.selected_option_id) === undefined ? {} : { selected_option_id: String(row.selected_option_id) }),
  ...toAdapterRequestIdField(row.adapter_request_id_encoded),
  ...(toOptionalString(row.expiration_reason) === undefined
    ? {}
    : { expiration_reason: row.expiration_reason as PermissionRequestDto['expiration_reason'] }),
})

export const toEvent = (row: Row): EventEnvelope => ({
  event_id: String(row.event_id),
  schema_version: Number(row.schema_version),
  workspace_id: String(row.workspace_id),
  session_id: String(row.session_id),
  run_id: String(row.run_id),
  sequence: Number(row.sequence),
  type: String(row.type),
  source: String(row.source),
  occurred_at: String(row.occurred_at),
  payload: parseJson(row.payload_json),
})

export const permissionParameters = (request: PermissionRequestDto): Record<string, unknown> => ({
  id: request.id,
  run_id: request.run_id,
  task_id: request.task_id,
  slot_id: request.slot_id,
  capability: request.capability,
  description: request.description,
  status: request.status,
  requested_at: request.requested_at,
  soft_timeout_at: request.soft_timeout_at,
  overdue_at: request.overdue_at ?? null,
  expires_at: request.expires_at ?? null,
  expired_at: request.expired_at ?? null,
  answered_at: request.answered_at ?? null,
  selected_option_id: request.selected_option_id ?? null,
  adapter_request_id_encoded: request.adapter_request_id === undefined
    ? null
    : encodeJsonRpcRequestId(request.adapter_request_id),
  expiration_reason: request.expiration_reason ?? null,
})
