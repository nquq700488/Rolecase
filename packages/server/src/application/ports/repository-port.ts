import type {
  AgentSlotDto,
  EventEnvelope,
  MessageDto,
  ModelCatalogEntryDto,
  PermissionRequestDto,
  ProviderConnectionDto,
  RunDto,
  SessionDto,
  SessionSnapshotDto,
  TaskDto,
  WorkspaceDto,
  WorkspaceRootPathDto,
} from '@rolecast/contract'

import type { PermissionStateStore } from '../permission/permission-state-coordinator.js'

/** 私有 Runtime attachment；不进入任何公共 DTO。 */
export interface RuntimeAttachmentRecord {
  readonly slot_id: string
  readonly session_id: string
  readonly provider_connection_id: string
  readonly provider_kind: 'claude' | 'codex'
  readonly config_revision: number
  readonly adapter_version: string
  /** 实际 spawn 身份指纹；无法可靠生成时为 null（不可恢复）。 */
  readonly adapter_fingerprint: string | null
  readonly cwd: string
  readonly runtime_directory: string
  readonly acp_session_id: string
  readonly updated_at: string
}

/** AgentSlot 私有、不可变 Role/Binding 配置快照；不进入公共 DTO。 */
export interface AgentSlotRoleSnapshotRecord {
  readonly slot_id: string
  readonly workspace_id: string
  readonly role_binding_id: string
  readonly role_binding_version: number
  readonly role_id: string
  readonly role_version: number
  readonly role_name: string
  readonly system_prompt: string
  readonly required_guidelines: readonly string[]
  readonly output_contract: string
  readonly created_at: string
}

/** ContextBundle 使用的可审计来源引用；不保存渲染后的 Prompt。 */
export interface ContextSourceRecord {
  readonly task_id: string
  readonly source_type: 'role' | 'role_binding' | 'message'
  readonly source_id: string
  readonly source_version: number
  readonly created_at: string
}

/** 命令回执状态与派发边界。 */
export type CommandReceiptStatus = 'reserved' | 'running' | 'completed' | 'failed' | 'ambiguous'
export type CommandDispatchState = 'not_started' | 'started' | 'accepted'

/** Slot 软删除的事务结果。 */
export type AgentSlotDeletionResult = 'deleted' | 'already_deleted' | 'not_found' | 'default_slot' | 'slot_busy'

/** 新增 Slot 幂等 reservation 的事务结果。 */
export type AgentSlotCreationReservation =
  | { readonly kind: 'reserved'; readonly receipt: CommandReceiptRecord }
  | { readonly kind: 'completed'; readonly receipt: CommandReceiptRecord }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'conflict' }

/** 幂等命令回执；不保存输入原文，仅保存用于同键一致性比较的不可逆摘要。 */
export interface CommandReceiptRecord {
  readonly workspace_id: string
  readonly request_id: string
  /** `start` / `resume` / `retry` / `cancel` / `add_slot`。 */
  readonly command: string
  readonly target_id: string
  /** start/add_slot 命令的 AgentSlot 目标；旧 start receipt 的 NULL 表示默认目标。 */
  readonly target_slot_id?: string
  readonly status: CommandReceiptStatus
  readonly dispatch_state: CommandDispatchState
  readonly run_id?: string
  readonly task_id?: string
  /** start 命令关联的用户 Message ID，用于同键输入精确比较。 */
  readonly message_id?: string
  /** start/add_slot 命令输入的不可逆摘要；不保存输入原文。 */
  readonly input_digest?: string
  readonly error_code?: string
  readonly updated_at: string
}

/** Slot 活动 claim：单 Slot 单活动 Run。 */
export interface SlotActivityClaimRecord {
  readonly slot_id: string
  readonly run_id: string | null
  readonly state: 'active' | 'recovery_conflict'
  readonly updated_at: string
}

/** 有界 Run Event 分页；超限或边界不一致时不得把 payload 交给上层。 */
export type RunEventPage =
  | { readonly kind: 'ok'; readonly events: readonly EventEnvelope[]; readonly nextSequence: number }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'inconsistent' }

/** handoff 来源：已完成 Run、唯一 Task 与可信完成水位。 */
export interface HandoffSourceRecord {
  readonly run: RunDto
  readonly task: TaskDto
  readonly from_slot_id: string
  readonly completed_sequence: number
}

/** handoff Message、私有幂等键与 metadata Event 的原子写入输入。 */
export interface CreateHandoffMessageInput {
  readonly message: MessageDto
  readonly event: Omit<EventEnvelope, 'sequence'>
  readonly runId: string
  readonly fromSlotId: string
  readonly toSlotId: string
  readonly requestId: string
}

export type CreateHandoffMessageResult =
  | { readonly kind: 'created'; readonly message: MessageDto; readonly event: EventEnvelope }
  | { readonly kind: 'replayed'; readonly message: MessageDto }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'source_unavailable' }
  | { readonly kind: 'invalid_target' }

/** Phase 1A 的持久化边界。所有方法都按 Workspace/Session 约束查询范围。 */
export interface RepositoryPort extends PermissionStateStore {
  /** 保存并返回未配置根路径的 Workspace，用于迁移与测试场景。 */
  createWorkspace(workspace: WorkspaceDto): Promise<WorkspaceDto>
  /** 原子保存新 Workspace 与已校验的 canonical 根路径。 */
  createWorkspaceWithRootPath(workspace: WorkspaceDto, rootPath: string): Promise<'created' | 'duplicate'>
  /** 获取 Workspace 根路径配置；未知 Workspace 返回 null。 */
  getWorkspaceRootPath(id: string): Promise<WorkspaceRootPathDto | null>
  /** 仅将 NULL 根路径一次性设为 canonical 路径，并报告 CAS 结果。 */
  setWorkspaceRootPathIfUnconfigured(
    id: string,
    rootPath: string,
  ): Promise<'configured' | 'duplicate' | 'already_configured' | 'not_found'>
  /** 列出 Workspace。 */
  listWorkspaces(): Promise<WorkspaceDto[]>
  /** 获取 Workspace。 */
  getWorkspace(id: string): Promise<WorkspaceDto | null>
  /** 保存 ProviderConnection。 */
  createProviderConnection(connection: ProviderConnectionDto): Promise<ProviderConnectionDto>
  /** 按 config_revision 条件更新 ProviderConnection；冲突时返回 null。 */
  updateProviderConnection(
    connection: ProviderConnectionDto,
    expectedConfigRevision: number,
  ): Promise<ProviderConnectionDto | null>
  /** 获取 ProviderConnection。 */
  getProviderConnection(id: string): Promise<ProviderConnectionDto | null>
  /** 列出 Workspace 内的 ProviderConnection。 */
  listProviderConnections(workspaceId: string): Promise<ProviderConnectionDto[]>
  /** 保存模型目录。 */
  /**
   * 仅当连接仍处于捕获时的 `config_revision` 时，原子替换该连接的模型目录。
   *
   * 用于发现流程：Adapter 往返期间配置可能已被 CAS 更新，旧结果不能复活。
   * 返回 false 表示 revision 已变化、未写入。
   */
  saveModelsIfCurrentRevision(
    providerConnectionId: string,
    expectedConfigRevision: number,
    models: readonly ModelCatalogEntryDto[],
  ): Promise<boolean>
  /** 列出 ProviderConnection 的模型。 */
  listModels(providerConnectionId: string): Promise<ModelCatalogEntryDto[]>
  /** 保存 Session。 */
  createSession(session: SessionDto): Promise<SessionDto>
  /** 按 id 覆盖保存 Session（内部状态收敛用）。 */
  saveSession(session: SessionDto): Promise<SessionDto>
  /** 获取 Session。 */
  getSession(id: string): Promise<SessionDto | null>
  /** 列出 Workspace 的 Session。 */
  listSessions(workspaceId: string): Promise<SessionDto[]>
  /** 保存 AgentSlot。 */
  createAgentSlot(slot: AgentSlotDto): Promise<AgentSlotDto>
  /** 原子保存新增 Slot、私有 Runtime attachment 与不可变 Role snapshot。 */
  addAgentSlotWithAttachmentAndRoleSnapshot(
    slot: AgentSlotDto,
    attachment: RuntimeAttachmentRecord,
    roleSnapshot: AgentSlotRoleSnapshotRecord,
  ): Promise<void>
  /** 先持久预留 add_slot 幂等键；同键并发时仅一个调用者取得 reservation。 */
  reserveAgentSlotCreation(receipt: CommandReceiptRecord): Promise<AgentSlotCreationReservation>
  /** 原子提交 Slot/attachment/Role snapshot 与 completed receipt。 */
  completeAgentSlotCreation(
    slot: AgentSlotDto,
    attachment: RuntimeAttachmentRecord,
    roleSnapshot: AgentSlotRoleSnapshotRecord,
    receipt: CommandReceiptRecord,
  ): Promise<'created' | 'receipt_conflict'>
  /** 获取 AgentSlot 的私有 Role snapshot。 */
  getAgentSlotRoleSnapshot(slotId: string): Promise<AgentSlotRoleSnapshotRecord | null>
  /** 读取 Task 使用的不可变 ContextSource 引用。 */
  getTaskContextSources(taskId: string): Promise<ContextSourceRecord[]>
  /** 获取 Session 的 AgentSlot。 */
  listAgentSlots(sessionId: string): Promise<AgentSlotDto[]>
  /** 按 id 读取仍活动的 AgentSlot。 */
  getAgentSlot(slotId: string): Promise<AgentSlotDto | null>
  /** 原子软删除非默认且无活动 Run 的 Slot，保留 Runtime attachment 供清理。 */
  softDeleteAgentSlot(sessionId: string, slotId: string, deletedAt: string): Promise<AgentSlotDeletionResult>
  /** 在同一事务中保存 Run、Task 和用户 Message。 */
  createTurn(run: RunDto, task: TaskDto, message: MessageDto): Promise<void>
  /** 原子创建 start 的 Run/Task/Message 并取得 Slot claim；Slot 已有活动 Run 时返回 false。 */
  createTurnWithClaim(run: RunDto, task: TaskDto, message: MessageDto, now: string): Promise<boolean>
  /**
   * 原子创建 start 的 Run/Task/Message、取得 claim，并把引用写回 receipt。
   *
   * receipt 保持 `reserved/not_started`（或调用方期望的失败边界），真正的
   * `running/started` 只会在调用 Runtime 前由 CAS 推进；创建与回执引用必须
   * 同一事务提交，便于崩溃后同 key 复用既有 Run。
   */
  createTurnWithReceipt(
    run: RunDto,
    task: TaskDto,
    message: MessageDto,
    receipt: CommandReceiptRecord,
    expected: {
      status: CommandReceiptStatus
      dispatch_state: CommandDispatchState
      target_id: string
      target_slot_id: string | null
    },
    now: string,
  ): Promise<'created' | 'slot_busy' | 'slot_unavailable' | 'receipt_conflict'>
  /** 以 state_revision CAS 原子收敛 Run/Task/claim（可选事件）。 */
  finalizeRun(input: {
    run: RunDto
    expectedStateRevision: number
    taskId: string
    taskStatus: TaskDto['status']
    slotId: string
    releaseClaim: boolean
    event?: Omit<EventEnvelope, 'sequence'>
  }): Promise<{ run: RunDto; task: TaskDto } | null>
  /** 仅在 receipt 仍处于未派发状态且引用该 child 时原子回滚 retry。 */
  rollbackRetryTurn(
    receipt: CommandReceiptRecord,
    childRunId: string,
    parentRunId: string,
    slotId: string,
  ): Promise<boolean>
  /** 列出全部非终态 Run（启动扫描用）。 */
  listNonTerminalRuns(): Promise<RunDto[]>
  /** 保存 Run。 */
  saveRun(run: RunDto): Promise<RunDto>
  /** 获取 Run。 */
  getRun(id: string): Promise<RunDto | null>
  /** 保存 Task。 */
  saveTask(task: TaskDto): Promise<TaskDto>
  /** 保存 Message。 */
  saveMessage(message: MessageDto): Promise<MessageDto>
  /** 获取 Session 的历史消息。 */
  listMessages(sessionId: string): Promise<MessageDto[]>
  /** 在一致性读事务中读取重连所需的完整快照。 */
  getSessionSnapshot(sessionId: string): Promise<SessionSnapshotDto | null>
  /** 追加带有下一 sequence 的事件。 */
  appendEvent(event: Omit<EventEnvelope, 'sequence'>): Promise<EventEnvelope>
  /** 从某个 sequence 之后重放事件。 */
  replayEvents(runId: string, afterSequence: number): Promise<EventEnvelope[]>
  /** 获取 Run 最新 sequence。 */
  getLatestSequence(runId: string): Promise<number>
  /** 获取事件 sequence 边界，用于检测 replay 缺口。 */
  getEventBounds(runId: string): Promise<{ first: number | null; last: number | null }>
  /** 服务启动时将无法重新挂接 Runtime 的权限请求收敛为过期。 */
  reconcileUnattachedPermissions(now: Date): Promise<number>
  /** 原子保存 Session、AgentSlot 与 Runtime attachment。 */
  saveSessionWithAttachment(
    session: SessionDto,
    slot: AgentSlotDto,
    attachment: RuntimeAttachmentRecord,
    roleSnapshot?: AgentSlotRoleSnapshotRecord,
  ): Promise<void>
  /** 读取 Slot 的 Runtime attachment。 */
  getRuntimeAttachment(slotId: string): Promise<RuntimeAttachmentRecord | null>
  /** 列出仍活动 Slot 的 Runtime attachment（用于正常启动恢复）。 */
  listRuntimeAttachments(): Promise<RuntimeAttachmentRecord[]>
  /** 列出已软删除 Slot 的 attachment cleanup record。 */
  listDeletedSlotRuntimeAttachments(): Promise<RuntimeAttachmentRecord[]>
  /** 写入或替换 Slot 的 Runtime attachment（retry 建立新 ACP Session 后使用）。 */
  saveRuntimeAttachment(attachment: RuntimeAttachmentRecord): Promise<void>
  /** 删除 Slot 的 Runtime attachment。 */
  deleteRuntimeAttachment(slotId: string): Promise<void>
  /** 读取命令回执。 */
  getCommandReceipt(
    workspaceId: string,
    requestId: string,
    command: string,
  ): Promise<CommandReceiptRecord | null>
  /** 列出启动时需要收敛的未完成回执（reserved / running）。 */
  listIncompleteCommandReceipts(): Promise<CommandReceiptRecord[]>
  /** 插入新回执；已存在同键时返回既有回执。 */
  insertCommandReceipt(receipt: CommandReceiptRecord): Promise<CommandReceiptRecord>
  /** 按状态 CAS 更新回执；不匹配返回 null。 */
  updateCommandReceipt(
    receipt: CommandReceiptRecord,
    expectedStatus: CommandReceiptStatus,
    expectedDispatchState: CommandDispatchState,
    expectedReferences?: {
      run_id: string | null
      task_id: string | null
      message_id: string | null
    },
  ): Promise<CommandReceiptRecord | null>
  /** 读取 Slot 活动 claim。 */
  getSlotActivityClaim(slotId: string): Promise<SlotActivityClaimRecord | null>
  /** 列出全部 Slot claim（用于启动核对）。 */
  listSlotActivityClaims(): Promise<SlotActivityClaimRecord[]>
  /** 取得 Slot 活动 claim；已被占用时返回 false。 */
  claimSlotActivity(slotId: string, runId: string, now: string): Promise<boolean>
  /** 释放仍属于指定 Run 的 Slot claim。 */
  releaseSlotActivity(slotId: string, runId: string): Promise<void>
  /** 把 claim 从父 Run 移交给子 Run。 */
  transferSlotActivity(slotId: string, fromRunId: string, toRunId: string): Promise<boolean>
  /** 清空 Slot claim（启动重建 claim 前使用）。 */
  resetSlotActivity(slotId: string): Promise<void>
  /** 读取 Run 当前 `state_revision`；不存在返回 null。 */
  getRunStateRevision(runId: string): Promise<number | null>
  /** 把 Slot claim 置为 recovery_conflict hold（run_id 为空）。 */
  setSlotRecoveryConflict(slotId: string, now: string): Promise<void>
  /** 按 `state_revision` CAS 保存 Run 并自增 revision。 */
  updateRunIfRevision(run: RunDto, expectedStateRevision: number): Promise<RunDto | null>
  /** 读取 Run 的内部输入消息。 */
  getRunInputMessage(runId: string): Promise<MessageDto | null>
  /** 原子创建 retry 子 Run、Task、ContextSource 与 receipt refs；失败返回 null。 */
  createRetryTurn(
    parentRunId: string,
    run: RunDto,
    task: TaskDto,
    receipt: CommandReceiptRecord,
    expected: {
      status: CommandReceiptStatus
      dispatch_state: CommandDispatchState
      run_id: string | null
      task_id: string | null
      message_id: string | null
    },
    now: string,
  ): Promise<CommandReceiptRecord | null>
  /** 按 Session + 私有幂等键读取既有 handoff Message；不存在返回 null。 */
  getHandoffMessageByRequest(sessionId: string, requestId: string): Promise<MessageDto | null>
  /** 读取 handoff 来源（来源 Run 完成水位与唯一 Task）；不可用返回 null。 */
  getHandoffSource(sessionId: string, runId: string): Promise<HandoffSourceRecord | null>
  /** 按单一 Run sequence 区间读取有界 Event 页；两阶段同一读快照。 */
  readRunEventPage(runId: string, afterSequence: number, limit: number): Promise<RunEventPage>
  /** 原子写入 handoff Message、私有幂等键与 post-completion metadata Event。 */
  createHandoffMessage(input: CreateHandoffMessageInput): Promise<CreateHandoffMessageResult>
  /** 关闭数据库资源。 */
  close(): Promise<void>
}
