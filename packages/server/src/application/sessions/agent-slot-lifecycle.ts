import { createHash } from 'node:crypto'

import type {
  AddAgentSlotRequest,
  AgentSlotDto,
  ProviderConnectionDto,
  RoleBindingDto,
  RoleDto,
  SessionDto,
} from '@rolecast/contract'

import { ApplicationError, isCodedError } from '../errors.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort, ProviderDefinitionPort, RuntimeEnvironmentPort } from '../ports/id-generator-port.js'
import type {
  AgentSlotRoleSnapshotRecord,
  CommandReceiptRecord,
  RepositoryPort,
  RuntimeAttachmentRecord,
} from '../ports/repository-port.js'
import type { RoleService } from '../roles/role-service.js'
import type { AgentRuntimeConnection, AgentRuntimePort, AgentRuntimeSession } from '../ports/agent-runtime-port.js'
import { assertRunnableCombination } from '../providers/provider-combination.js'
import { createProviderRuntimeInput } from '../providers/provider-runtime-input.js'

interface AgentSlotLifecycleDependencies {
  readonly repository: RepositoryPort
  readonly runtime: AgentRuntimePort
  readonly ids: IdGeneratorPort
  readonly clock: ClockPort
  readonly definitions: ProviderDefinitionPort
  readonly environment: RuntimeEnvironmentPort
  readonly roleService?: Pick<RoleService, 'resolveBindingForWorkspace'>
  readonly applyModelSelection: (session: AgentRuntimeSession, modelId: string) => Promise<AgentRuntimeSession>
  readonly registerRuntime: (
    slotId: string,
    session: AgentRuntimeSession,
    connection: AgentRuntimeConnection,
  ) => void
  readonly closeConnection: (connectionId: string) => Promise<void>
}

/**
 * @name addRoleBoundAgentSlot
 * @description 以 RoleBinding 幂等创建 Slot、Runtime attachment 和私有 Role snapshot
 * @param {AgentSlotLifecycleDependencies} dependencies Slot 创建所需的 Application ports
 * @param {string} sessionId 目标 Session ID
 * @param {AddAgentSlotRequest} input RoleBinding 与可选 request_id
 * @return {Promise<AgentSlotDto>} 已创建或同键重放的 AgentSlot
 */
export async function addRoleBoundAgentSlot(
  dependencies: AgentSlotLifecycleDependencies,
  sessionId: string,
  input: AddAgentSlotRequest,
): Promise<AgentSlotDto> {
  const { repository, runtime, ids, clock, definitions, environment } = dependencies
  const session = await repository.getSession(sessionId)
  if (session === null) {
    throw new ApplicationError('Session 不存在', 'not_found', 404, { resource: 'session' })
  }
  const requestId = input.request_id ?? ids.next('request')
  const inputDigest = bindingDigest(input.role_binding_id)
  const prior = await repository.getCommandReceipt(session.workspace_id, requestId, 'add_slot')
  if (prior !== null) {
    assertReceiptTarget(prior, sessionId, inputDigest)
    if (prior.status === 'completed') {
      return readCompletedSlot(repository, prior)
    }
    if (prior.status === 'reserved' || prior.status === 'running') {
      throw new ApplicationError('该 Agent Slot 正在创建，请稍后重试', 'state_conflict', 409)
    }
    if (prior.status === 'ambiguous' || prior.dispatch_state !== 'not_started') {
      throw new ApplicationError('Slot 创建结果不确定，请使用新的 request_id', 'command_outcome_ambiguous', 409)
    }
    if (prior.run_id !== undefined || prior.task_id !== undefined || prior.message_id !== undefined) {
      throw new ApplicationError('Slot 创建回执引用无效', 'state_conflict', 409)
    }
  }
  if (dependencies.roleService === undefined) {
    throw new ApplicationError('Role 配置服务不可用', 'internal_error', 500)
  }
  const { binding, role } = await dependencies.roleService.resolveBindingForWorkspace(
    session.workspace_id,
    input.role_binding_id,
  )
  const connection = await repository.getProviderConnection(binding.provider_connection_id)
  if (connection === null || connection.workspace_id !== session.workspace_id) {
    throw new ApplicationError('ProviderConnection 不属于当前 Workspace', 'not_found', 404, {
      resource: 'provider',
    })
  }
  assertRunnableCombination(connection)
  const runtimeInput = createProviderRuntimeInput(connection, definitions, environment)
  const now = clock.now().toISOString()
  const slotId = prior?.target_slot_id ?? ids.next('slot')
  const reservation = await repository.reserveAgentSlotCreation({
    workspace_id: session.workspace_id,
    request_id: requestId,
    command: 'add_slot',
    target_id: sessionId,
    target_slot_id: slotId,
    status: 'reserved',
    dispatch_state: 'not_started',
    input_digest: inputDigest,
    updated_at: now,
  })
  if (reservation.kind === 'completed') {
    assertReceiptTarget(reservation.receipt, sessionId, inputDigest)
    return readCompletedSlot(repository, reservation.receipt)
  }
  if (reservation.kind === 'in_progress') {
    throw new ApplicationError('该 Agent Slot 正在创建，请稍后重试', 'state_conflict', 409)
  }
  if (reservation.kind === 'conflict') {
    throw new ApplicationError('同 request_id 指向不同 Slot 创建请求', 'state_conflict', 409)
  }

  return createReservedSlot(dependencies, {
    session,
    binding,
    role,
    connection,
    runtimeInput,
    receipt: reservation.receipt,
  })
}

async function createReservedSlot(
  dependencies: AgentSlotLifecycleDependencies,
  input: {
    session: SessionDto
    binding: RoleBindingDto
    role: RoleDto
    connection: ProviderConnectionDto
    runtimeInput: ReturnType<typeof createProviderRuntimeInput>
    receipt: CommandReceiptRecord
  },
): Promise<AgentSlotDto> {
  let runtimeConnection: AgentRuntimeConnection | null = null
  try {
    runtimeConnection = await dependencies.runtime.connect(input.runtimeInput)
    const created = await dependencies.runtime.createSession(runtimeConnection, dependencies.environment.cwd)
    const runtimeSession = await dependencies.applyModelSelection(created, input.binding.model_id)
    return await persistSlotBundle(dependencies, input, runtimeConnection, runtimeSession)
  } catch (error: unknown) {
    if (runtimeConnection !== null) {
      await dependencies.closeConnection(runtimeConnection.connectionId).catch(() => undefined)
    }
    await failReservation(dependencies.repository, input.receipt, dependencies.clock.now().toISOString())
    throw mapSlotCreationError(error)
  }
}

async function persistSlotBundle(
  dependencies: AgentSlotLifecycleDependencies,
  input: {
    session: SessionDto
    binding: RoleBindingDto
    role: RoleDto
    connection: ProviderConnectionDto
    runtimeInput: ReturnType<typeof createProviderRuntimeInput>
    receipt: CommandReceiptRecord
  },
  runtimeConnection: AgentRuntimeConnection,
  runtimeSession: AgentRuntimeSession,
): Promise<AgentSlotDto> {
  const records = await buildSlotRecords(dependencies, input, runtimeSession)
  const persisted = await dependencies.repository.completeAgentSlotCreation(
    records.slot,
    records.attachment,
    records.roleSnapshot,
    { ...input.receipt, updated_at: records.slot.created_at },
  )
  if (persisted === 'receipt_conflict') {
    const current = await dependencies.repository.getCommandReceipt(
      input.receipt.workspace_id,
      input.receipt.request_id,
      input.receipt.command,
    )
    if (current?.status === 'completed') {
      await dependencies.closeConnection(runtimeConnection.connectionId).catch(() => undefined)
      assertReceiptTarget(current, input.session.id, input.receipt.input_digest ?? '')
      return readCompletedSlot(dependencies.repository, current)
    }
    throw new ApplicationError('Slot 创建回执已变化，请重试', 'state_conflict', 409)
  }
  dependencies.registerRuntime(records.slot.id, runtimeSession, runtimeConnection)
  return records.slot
}

async function buildSlotRecords(
  dependencies: AgentSlotLifecycleDependencies,
  input: {
    session: SessionDto
    binding: RoleBindingDto
    role: RoleDto
    connection: ProviderConnectionDto
    runtimeInput: ReturnType<typeof createProviderRuntimeInput>
    receipt: CommandReceiptRecord
  },
  runtimeSession: AgentRuntimeSession,
): Promise<{
  slot: AgentSlotDto
  attachment: RuntimeAttachmentRecord
  roleSnapshot: AgentSlotRoleSnapshotRecord
}> {
  const slotId = input.receipt.target_slot_id
  if (slotId === undefined) {
    throw new ApplicationError('Slot 创建回执缺少目标 ID', 'state_conflict', 409)
  }
  const now = dependencies.clock.now().toISOString()
  const slot: AgentSlotDto = {
    id: slotId,
    session_id: input.session.id,
    role_binding_id: input.binding.id,
    model_id: input.binding.model_id,
    status: 'idle',
    created_at: now,
  }
  const attachment: RuntimeAttachmentRecord = {
    slot_id: slot.id,
    session_id: input.session.id,
    provider_connection_id: input.connection.id,
    provider_kind: input.connection.provider_kind,
    config_revision: input.connection.config_revision,
    adapter_version: input.runtimeInput.adapterVersion,
    adapter_fingerprint: await dependencies.definitions.fingerprint?.(input.connection.provider_kind) ?? null,
    cwd: input.runtimeInput.cwd,
    runtime_directory: input.runtimeInput.runtimeDirectory,
    acp_session_id: runtimeSession.sessionId,
    updated_at: now,
  }
  return { slot, attachment, roleSnapshot: snapshotRole(input, slot.id, now) }
}

/**
 * @name snapshotRole
 * @description 根据已验证的 RoleBinding 构造 Slot 私有 Role 快照
 * @param {{ session: SessionDto; binding: RoleBindingDto; role: RoleDto }} input Session、Binding 与 Role
 * @param {string} slotId 初始 AgentSlot ID
 * @param {string} now 快照创建时间
 * @return {AgentSlotRoleSnapshotRecord} 不进入公共 DTO 的不可变配置快照
 */
export function snapshotRole(
  input: { session: SessionDto; binding: RoleBindingDto; role: RoleDto },
  slotId: string,
  now: string,
): AgentSlotRoleSnapshotRecord {
  return {
    slot_id: slotId,
    workspace_id: input.session.workspace_id,
    role_binding_id: input.binding.id,
    role_binding_version: input.binding.version,
    role_id: input.role.id,
    role_version: input.role.version,
    role_name: input.role.name,
    system_prompt: input.role.system_prompt,
    required_guidelines: [...input.role.required_guidelines],
    output_contract: input.role.output_contract,
    created_at: now,
  }
}

function mapSlotCreationError(error: unknown): ApplicationError {
  if (isCodedError(error, 'credential_environment_mismatch')) {
    return new ApplicationError('凭据引用与连接环境模式不匹配', 'credential_environment_mismatch', 422)
  }
  if (isCodedError(error, 'provider_needs_configuration')) {
    return new ApplicationError('Provider 仍需要完成凭据配置', 'provider_needs_configuration', 422)
  }
  if (isCodedError(error, 'credential_denied')) {
    return new ApplicationError('凭据访问被拒绝', 'credential_denied', 403)
  }
  if (isCodedError(error, 'credentials_unavailable')) {
    return new ApplicationError('凭据存储不可用', 'credentials_unavailable', 503)
  }
  return error instanceof ApplicationError
    ? error
    : new ApplicationError('Agent Slot 创建失败', 'session_create_failed', 502)
}

function bindingDigest(bindingId: string): string {
  return createHash('sha256').update(bindingId, 'utf8').digest('hex')
}

function assertReceiptTarget(receipt: CommandReceiptRecord, sessionId: string, digest: string): void {
  if (receipt.target_id !== sessionId || receipt.input_digest !== digest) {
    throw new ApplicationError('同 request_id 指向不同 Slot 创建请求', 'state_conflict', 409)
  }
}

async function readCompletedSlot(repository: RepositoryPort, receipt: CommandReceiptRecord): Promise<AgentSlotDto> {
  const slotId = receipt.target_slot_id
  const slot = slotId === undefined ? null : await repository.getAgentSlot(slotId)
  if (slot === null) {
    throw new ApplicationError('Slot 创建回执指向已删除或不存在的 Slot', 'state_conflict', 409)
  }
  return slot
}

async function failReservation(
  repository: RepositoryPort,
  receipt: CommandReceiptRecord,
  updatedAt: string,
): Promise<void> {
  try {
    await repository.updateCommandReceipt({
      ...receipt,
      status: 'failed',
      dispatch_state: 'not_started',
      error_code: 'session_create_failed',
      updated_at: updatedAt,
    }, receipt.status, receipt.dispatch_state)
  } catch {
    // 保留 reservation，启动恢复会将其收敛为可重试状态。
  }
}
