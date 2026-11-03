/** Domain 层支持的 Provider 类型。 */
export type ProviderKind = 'claude' | 'codex'

/** Run 生命周期状态。 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** Task 生命周期状态。 */
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** Session 生命周期状态。 */
export type SessionStatus = 'active' | 'paused' | 'completed' | 'archived'

/** Workspace 领域实体。 */
export interface Workspace {
  readonly id: string
  readonly name: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** ProviderConnection 领域实体，不包含凭据原文。 */
export interface ProviderConnection {
  readonly id: string
  readonly workspaceId: string
  readonly providerKind: ProviderKind
  readonly connectionKind: 'local' | 'api_key' | 'custom_endpoint'
  readonly baseUrl: string | null
  readonly credentialRef: string | null
  readonly environmentMode: 'inherited' | 'isolated'
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Workspace 内可复用的 Role 定义。 */
export interface Role {
  readonly id: string
  readonly workspaceId: string
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly requiredGuidelines: readonly string[]
  readonly gates: readonly string[]
  readonly outputContract: string
  readonly blockingConditions: readonly string[]
  readonly selectable: boolean
  readonly dispatchable: boolean
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Role 与 ProviderConnection、Model 的 Workspace 级绑定。 */
export interface RoleBinding {
  readonly id: string
  readonly workspaceId: string
  readonly roleId: string
  readonly providerConnectionId: string
  readonly modelId: string
  readonly runtimeOptions: Readonly<Record<string, string | number | boolean>>
  readonly priority: number
  readonly enabled: boolean
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Role 可更新字段。 */
export interface RoleUpdate {
  readonly name?: string
  readonly description?: string
  readonly systemPrompt?: string
  readonly requiredGuidelines?: readonly string[]
  readonly gates?: readonly string[]
  readonly outputContract?: string
  readonly blockingConditions?: readonly string[]
  readonly selectable?: boolean
  readonly dispatchable?: boolean
}

/** RoleBinding 可更新字段。 */
export interface RoleBindingUpdate {
  readonly roleId?: string
  readonly providerConnectionId?: string
  readonly modelId?: string
  readonly runtimeOptions?: Readonly<Record<string, string | number | boolean>>
  readonly priority?: number
  readonly enabled?: boolean
}

/** Session 领域实体。 */
export interface Session {
  readonly id: string
  readonly workspaceId: string
  readonly name: string
  readonly status: SessionStatus
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** 单个 AgentSlot 领域实体。 */
export interface AgentSlot {
  readonly id: string
  readonly sessionId: string
  readonly roleBindingId: string | null
  readonly modelId: string
  readonly status: 'idle' | 'running' | 'waiting_user' | 'stopped'
  readonly createdAt: Date
}

/** Run 领域实体。 */
export interface Run {
  readonly id: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly status: RunStatus
  readonly attempt: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly startedAt?: Date
  readonly endedAt?: Date
  readonly errorCode?: string
}

/** Task 领域实体。 */
export interface Task {
  readonly id: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly runId: string
  readonly slotId: string
  readonly title: string
  readonly status: TaskStatus
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** 用户、Agent 或系统消息。 */
export interface Message {
  readonly id: string
  readonly sessionId: string
  readonly runId: string | null
  readonly senderKind: 'user' | 'agent' | 'system'
  readonly senderId: string | null
  readonly content: string
  readonly createdAt: Date
}

/** 领域状态冲突。 */
export class DomainStateConflictError extends Error {
  readonly code = 'state_conflict'

  constructor(message: string) {
    super(message)
    this.name = 'DomainStateConflictError'
  }
}

/** 创建 Workspace。 */
export function createWorkspace(input: { id: string; name: string; now: Date }): Workspace {
  const name = input.name.trim()
  if (name.length === 0) {
    throw new DomainStateConflictError('Workspace 名称不能为空')
  }
  return {
    id: input.id,
    name,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  }
}

/**
 * @name createRole
 * @description 创建带有默认配置的 Workspace Role
 * @param {object} input Role 的标识、归属、名称和创建时间
 * @return {Role} 不可变 Role 实体
 * @example createRole({ id: 'role-001', workspaceId: 'workspace-001', name: '执行者', now })
 */
export function createRole(input: {
  readonly id: string
  readonly workspaceId: string
  readonly name: string
  readonly description?: string
  readonly systemPrompt?: string
  readonly requiredGuidelines?: readonly string[]
  readonly gates?: readonly string[]
  readonly outputContract?: string
  readonly blockingConditions?: readonly string[]
  readonly selectable?: boolean
  readonly dispatchable?: boolean
  readonly now: Date
}): Role {
  const name = input.name.trim()
  if (name.length === 0) {
    throw new DomainStateConflictError('Role 名称不能为空')
  }
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    name,
    description: input.description ?? '',
    systemPrompt: input.systemPrompt ?? '',
    requiredGuidelines: [...(input.requiredGuidelines ?? [])],
    gates: [...(input.gates ?? [])],
    outputContract: input.outputContract ?? '',
    blockingConditions: [...(input.blockingConditions ?? [])],
    selectable: input.selectable ?? true,
    dispatchable: input.dispatchable ?? false,
    version: 1,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  }
}

/**
 * @name updateRole
 * @description 以不可变方式更新 Role 并递增版本
 * @param {Role} role 原 Role
 * @param {RoleUpdate} patch 要应用的字段
 * @param {Date} now 更新时刻
 * @return {Role} 更新后的新 Role
 */
export function updateRole(role: Role, patch: RoleUpdate, now: Date): Role {
  const name = patch.name === undefined ? role.name : patch.name.trim()
  if (name.length === 0) {
    throw new DomainStateConflictError('Role 名称不能为空')
  }
  return {
    ...role,
    name,
    description: patch.description ?? role.description,
    systemPrompt: patch.systemPrompt ?? role.systemPrompt,
    requiredGuidelines: patch.requiredGuidelines === undefined ? [...role.requiredGuidelines] : [...patch.requiredGuidelines],
    gates: patch.gates === undefined ? [...role.gates] : [...patch.gates],
    outputContract: patch.outputContract ?? role.outputContract,
    blockingConditions: patch.blockingConditions === undefined ? [...role.blockingConditions] : [...patch.blockingConditions],
    selectable: patch.selectable ?? role.selectable,
    dispatchable: patch.dispatchable ?? role.dispatchable,
    version: role.version + 1,
    createdAt: new Date(role.createdAt),
    updatedAt: new Date(now),
  }
}

/**
 * @name createRoleBinding
 * @description 创建 Role、ProviderConnection 和 Model 的绑定
 * @param {object} input Binding 的引用和创建时间
 * @return {RoleBinding} 不可变 RoleBinding 实体
 */
export function createRoleBinding(input: {
  readonly id: string
  readonly workspaceId: string
  readonly roleId: string
  readonly providerConnectionId: string
  readonly modelId: string
  readonly runtimeOptions?: Readonly<Record<string, string | number | boolean>>
  readonly priority?: number
  readonly enabled?: boolean
  readonly now: Date
}): RoleBinding {
  if (input.roleId.length === 0 || input.providerConnectionId.length === 0 || input.modelId.length === 0) {
    throw new DomainStateConflictError('RoleBinding 引用不能为空')
  }
  if (input.priority !== undefined && input.priority < 0) {
    throw new DomainStateConflictError('RoleBinding priority 不能为负数')
  }
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    roleId: input.roleId,
    providerConnectionId: input.providerConnectionId,
    modelId: input.modelId,
    runtimeOptions: { ...(input.runtimeOptions ?? {}) },
    priority: input.priority ?? 0,
    enabled: input.enabled ?? true,
    version: 1,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  }
}

/**
 * @name updateRoleBinding
 * @description 以不可变方式更新 RoleBinding 并递增版本
 * @param {RoleBinding} binding 原 Binding
 * @param {RoleBindingUpdate} patch 要应用的字段
 * @param {Date} now 更新时刻
 * @return {RoleBinding} 更新后的新 Binding
 */
export function updateRoleBinding(binding: RoleBinding, patch: RoleBindingUpdate, now: Date): RoleBinding {
  const roleId = patch.roleId ?? binding.roleId
  const providerConnectionId = patch.providerConnectionId ?? binding.providerConnectionId
  const modelId = patch.modelId ?? binding.modelId
  if (roleId.length === 0 || providerConnectionId.length === 0 || modelId.length === 0) {
    throw new DomainStateConflictError('RoleBinding 引用不能为空')
  }
  if (patch.priority !== undefined && patch.priority < 0) {
    throw new DomainStateConflictError('RoleBinding priority 不能为负数')
  }
  return {
    ...binding,
    roleId,
    providerConnectionId,
    modelId,
    runtimeOptions: patch.runtimeOptions === undefined ? { ...binding.runtimeOptions } : { ...patch.runtimeOptions },
    priority: patch.priority ?? binding.priority,
    enabled: patch.enabled ?? binding.enabled,
    version: binding.version + 1,
    createdAt: new Date(binding.createdAt),
    updatedAt: new Date(now),
  }
}

/**
 * @name assertBindingWorkspaceConsistency
 * @description 验证 Binding、Role 和 ProviderConnection 属于同一 Workspace
 * @param {Pick<RoleBinding, 'workspaceId'>} binding 要校验的 Binding
 * @param {string} roleWorkspaceId Role 的 Workspace ID
 * @param {string} providerWorkspaceId ProviderConnection 的 Workspace ID
 * @return {void} 校验成功不返回值
 */
export function assertBindingWorkspaceConsistency(
  binding: Pick<RoleBinding, 'workspaceId'>,
  roleWorkspaceId: string,
  providerWorkspaceId: string,
): void {
  if (
    binding.workspaceId !== roleWorkspaceId ||
    binding.workspaceId !== providerWorkspaceId
  ) {
    throw new DomainStateConflictError('RoleBinding 必须引用同一 Workspace')
  }
}

/** 创建 Session。 */
export function createSession(input: {
  id: string
  workspaceId: string
  name: string
  now: Date
}): Session {
  const name = input.name.trim()
  if (name.length === 0) {
    throw new DomainStateConflictError('Session 名称不能为空')
  }
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    name,
    status: 'active',
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  }
}

/** 创建初始 Run。 */
export function createRun(input: {
  id: string
  workspaceId: string
  sessionId: string
  now: Date
}): Run {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    status: 'queued',
    attempt: 1,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  }
}

/** 创建初始 Task。 */
export function createTask(input: {
  id: string
  workspaceId: string
  sessionId: string
  runId: string
  slotId: string
  title: string
  now: Date
}): Task {
  const title = input.title.trim()
  if (title.length === 0) {
    throw new DomainStateConflictError('Task 标题不能为空')
  }
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    runId: input.runId,
    slotId: input.slotId,
    title,
    status: 'queued',
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  }
}

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['waiting_user', 'completed', 'failed', 'cancelled', 'interrupted'],
  waiting_user: ['running', 'interrupted'],
  paused: ['running', 'interrupted'],
  interrupted: ['running', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['paused', 'completed', 'failed', 'cancelled', 'interrupted'],
  paused: ['running', 'interrupted'],
  interrupted: ['running', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

/** 按领域状态机产生新的 Run，不修改旧对象。 */
export function transitionRun(run: Run, nextStatus: RunStatus, now: Date): Run {
  if (!RUN_TRANSITIONS[run.status].includes(nextStatus)) {
    throw new DomainStateConflictError(`Run 状态不可转换: ${run.status} -> ${nextStatus}`)
  }
  const startedAt = run.startedAt ?? (nextStatus === 'running' ? new Date(now) : undefined)
  const terminal = ['completed', 'failed', 'cancelled'].includes(nextStatus)
  const endedAt = terminal ? new Date(now) : run.endedAt
  return {
    ...run,
    status: nextStatus,
    updatedAt: new Date(now),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  }
}

/** 按领域状态机产生新的 Task，不修改旧对象。 */
export function transitionTask(task: Task, nextStatus: TaskStatus, now: Date): Task {
  if (!TASK_TRANSITIONS[task.status].includes(nextStatus)) {
    throw new DomainStateConflictError(`Task 状态不可转换: ${task.status} -> ${nextStatus}`)
  }
  return { ...task, status: nextStatus, updatedAt: new Date(now) }
}
