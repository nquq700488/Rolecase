import { randomUUID } from 'node:crypto'

import {
  type AgentSlotDto,
  type EventEnvelope,
  type MessageDto,
  type ModelCatalogEntryDto,
  type PermissionRequestDto,
  type ProviderConnectionDto,
  type RunDto,
  type SessionDto,
  type SessionSnapshotDto,
  type TaskDto,
  type WorkspaceDto,
} from '@rolecast/contract'

import type {
  PermissionEventType,
} from '../../application/permission/permission-state-coordinator.js'
import type {
  CreateHandoffMessageInput,
  CreateHandoffMessageResult,
  HandoffSourceRecord,
  RunEventPage,
} from '../../application/ports/repository-port.js'
import type { EventBusPort } from '../../application/ports/event-bus-port.js'
import type { RepositoryPort } from '../../application/ports/repository-port.js'
import { encodeJsonRpcRequestId } from './json-rpc-request-id-codec.js'
import {
  permissionParameters,
  toAgentSlot,
  toEvent,
  toMessage,
  toPermission,
  toRun,
  toSession,
  toTask,
  toWorkspace,
} from './sqlite-mappers.js'
import { SqliteDatabase } from './sqlite-database.js'
import { appendHandoffMetadataEventSync, appendRunScopedEventSync } from './sqlite-event-sequence.js'
import { SqlitePermissionEventStore } from './sqlite-permission-event-store.js'
import { SqlitePermissionRecoveryStore } from './sqlite-permission-recovery-store.js'
import { SqliteProviderStore } from './sqlite-provider-store.js'
import { SqliteRunClosureStore } from './sqlite-run-closure.js'
import { SqliteSlotLifecycleStore } from './sqlite-slot-lifecycle-store.js'
import { SqliteRetryStore } from './sqlite-retry-store.js'
import { SqliteHandoffStore } from './sqlite-handoff-store.js'

type Row = Record<string, unknown>

/** 把编码列还原为 DTO 的可选字段；解不出的值不猜测类型。 */
const toOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const toNullableString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null
const toJson = (value: unknown): string => JSON.stringify(value)
const parseJson = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string') {
    return {}
  }
  const parsed: unknown = JSON.parse(value)
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

/**
 * @name SqliteRepository
 * @description Phase 1A 的 SQLite Repository 和 PermissionStateStore 实现
 */
export class SqliteRepository implements RepositoryPort {
  private readonly closure: SqliteRunClosureStore
  private readonly slotLifecycle: SqliteSlotLifecycleStore
  private readonly retryStore: SqliteRetryStore
  private readonly handoffs: SqliteHandoffStore

  constructor(
    private readonly database: SqliteDatabase,
    private readonly eventBus: EventBusPort | null = null,
  ) {
    this.closure = new SqliteRunClosureStore(database)
    this.slotLifecycle = new SqliteSlotLifecycleStore(database)
    this.retryStore = new SqliteRetryStore(database)
    this.handoffs = new SqliteHandoffStore(database)
    this.providers = new SqliteProviderStore(database)
  }

  private readonly providers: SqliteProviderStore

  createProviderConnection(connection: ProviderConnectionDto) {
    return this.providers.createProviderConnection(connection)
  }

  updateProviderConnection(...args: Parameters<SqliteProviderStore['updateProviderConnection']>) {
    return this.providers.updateProviderConnection(...args)
  }

  getProviderConnection(id: string) {
    return this.providers.getProviderConnection(id)
  }

  listProviderConnections(workspaceId: string) {
    return this.providers.listProviderConnections(workspaceId)
  }

  saveModelsIfCurrentRevision(...args: Parameters<SqliteProviderStore['saveModelsIfCurrentRevision']>) {
    return this.providers.saveModelsIfCurrentRevision(...args)
  }

  listModels(providerConnectionId: string) {
    return this.providers.listModels(providerConnectionId)
  }

  /** 委托给 Run/Session 闭环存储。 */
  saveSessionWithAttachment(
    ...args: Parameters<SqliteRunClosureStore['saveSessionWithAttachment']>
  ): ReturnType<SqliteRunClosureStore['saveSessionWithAttachment']> {
    return this.closure.saveSessionWithAttachment(...args)
  }

  getRuntimeAttachment(slotId: string) {
    return this.closure.getRuntimeAttachment(slotId)
  }

  listRuntimeAttachments() {
    return this.slotLifecycle.listActiveRuntimeAttachments()
  }

  listDeletedSlotRuntimeAttachments() {
    return this.slotLifecycle.listDeletedSlotRuntimeAttachments()
  }

  saveRuntimeAttachment(...args: Parameters<SqliteRunClosureStore['saveRuntimeAttachment']>) {
    return this.closure.saveRuntimeAttachment(...args)
  }

  deleteRuntimeAttachment(slotId: string) {
    return this.closure.deleteRuntimeAttachment(slotId)
  }

  getCommandReceipt(...args: Parameters<SqliteRunClosureStore['getCommandReceipt']>) {
    return this.closure.getCommandReceipt(...args)
  }

  listIncompleteCommandReceipts() {
    return this.closure.listIncompleteCommandReceipts()
  }

  insertCommandReceipt(...args: Parameters<SqliteRunClosureStore['insertCommandReceipt']>) {
    return this.closure.insertCommandReceipt(...args)
  }

  updateCommandReceipt(...args: Parameters<SqliteRunClosureStore['updateCommandReceipt']>) {
    return this.closure.updateCommandReceipt(...args)
  }

  getSlotActivityClaim(slotId: string) {
    return this.closure.getSlotActivityClaim(slotId)
  }

  listSlotActivityClaims() {
    return this.closure.listSlotActivityClaims()
  }

  claimSlotActivity(...args: Parameters<SqliteRunClosureStore['claimSlotActivity']>) {
    return this.closure.claimSlotActivity(...args)
  }

  releaseSlotActivity(slotId: string, runId: string) {
    return this.closure.releaseSlotActivity(slotId, runId)
  }

  transferSlotActivity(...args: Parameters<SqliteRunClosureStore['transferSlotActivity']>) {
    return this.closure.transferSlotActivity(...args)
  }

  resetSlotActivity(slotId: string) {
    return this.closure.resetSlotActivity(slotId)
  }

  getRunStateRevision(runId: string) {
    return this.closure.getRunStateRevision(runId)
  }

  setSlotRecoveryConflict(slotId: string, now: string) {
    return this.closure.setSlotRecoveryConflict(slotId, now)
  }

  updateRunIfRevision(...args: Parameters<SqliteRunClosureStore['updateRunIfRevision']>) {
    return this.closure.updateRunIfRevision(...args)
  }

  getRunInputMessage(runId: string) {
    return this.closure.getRunInputMessage(runId)
  }

  finalizeRun(...args: Parameters<SqliteRunClosureStore['finalizeRun']>) {
    return this.closure.finalizeRun(...args)
  }

  createTurnWithReceipt(...args: Parameters<SqliteRunClosureStore['createTurnWithReceipt']>) {
    return this.closure.createTurnWithReceipt(...args)
  }

  rollbackRetryTurn(...args: Parameters<SqliteRetryStore['rollbackRetryTurn']>) {
    return this.retryStore.rollbackRetryTurn(...args)
  }

  listNonTerminalRuns() {
    return this.closure.listNonTerminalRuns()
  }

  createTurnWithClaim(...args: Parameters<SqliteRunClosureStore['createTurnWithClaim']>) {
    return this.closure.createTurnWithClaim(...args)
  }

  createRetryTurn(...args: Parameters<SqliteRetryStore['createRetryTurn']>) {
    return this.retryStore.createRetryTurn(...args)
  }

  async createWorkspace(workspace: WorkspaceDto): Promise<WorkspaceDto> {
    this.database
      .prepare(
        `INSERT INTO workspaces(id, name, created_at, updated_at)
         VALUES (@id, @name, @created_at, @updated_at)`,
      )
      .run(workspace)
    return workspace
  }

  async listWorkspaces(): Promise<WorkspaceDto[]> {
    const rows = this.database
      .prepare('SELECT id, name, created_at, updated_at FROM workspaces ORDER BY updated_at DESC, id')
      .all() as Row[]
    return rows.map(toWorkspace)
  }

  async getWorkspace(id: string): Promise<WorkspaceDto | null> {
    const row = this.database
      .prepare('SELECT id, name, created_at, updated_at FROM workspaces WHERE id = ?')
      .get(id) as Row | undefined
    return row === undefined ? null : toWorkspace(row)
  }







  async createSession(session: SessionDto): Promise<SessionDto> {
    this.database
      .prepare(
        `INSERT INTO sessions(id, workspace_id, name, status, created_at, updated_at)
         VALUES (@id, @workspace_id, @name, @status, @created_at, @updated_at)`,
      )
      .run(session)
    return session
  }

  async saveSession(session: SessionDto): Promise<SessionDto> {
    const changed = this.database
      .prepare(
        `UPDATE sessions SET name = @name, status = @status, updated_at = @updated_at WHERE id = @id`,
      )
      .run(session)
    if (changed.changes !== 1) {
      throw new Error('session not found')
    }
    const row = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) as Row | undefined
    if (row === undefined) {
      throw new Error('session not found')
    }
    return { ...session }
  }

  async getSession(id: string): Promise<SessionDto | null> {
    const row = this.database
      .prepare('SELECT id, workspace_id, name, status, created_at, updated_at FROM sessions WHERE id = ?')
      .get(id) as Row | undefined
    return row === undefined ? null : toSession(row)
  }

  async listSessions(workspaceId: string): Promise<SessionDto[]> {
    const rows = this.database
      .prepare(
        `SELECT id, workspace_id, name, status, created_at, updated_at
         FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC, id`,
      )
      .all(workspaceId) as Row[]
    return rows.map(toSession)
  }

  async createAgentSlot(slot: AgentSlotDto): Promise<AgentSlotDto> {
    this.database
      .prepare(
        `INSERT INTO agent_slots(id, session_id, role_binding_id, model_id, status, created_at)
         VALUES (@id, @session_id, @role_binding_id, @model_id, @status, @created_at)`,
      )
      .run({ ...slot, role_binding_id: slot.role_binding_id ?? null })
    return slot
  }

  addAgentSlotWithAttachmentAndRoleSnapshot(
    ...args: Parameters<SqliteSlotLifecycleStore['addAgentSlotWithAttachmentAndRoleSnapshot']>
  ): Promise<void> {
    return this.slotLifecycle.addAgentSlotWithAttachmentAndRoleSnapshot(...args)
  }

  reserveAgentSlotCreation(...args: Parameters<SqliteSlotLifecycleStore['reserveAgentSlotCreation']>) {
    return this.slotLifecycle.reserveAgentSlotCreation(...args)
  }

  completeAgentSlotCreation(...args: Parameters<SqliteSlotLifecycleStore['completeAgentSlotCreation']>) {
    return this.slotLifecycle.completeAgentSlotCreation(...args)
  }

  getAgentSlotRoleSnapshot(slotId: string) {
    return this.closure.getAgentSlotRoleSnapshot(slotId)
  }

  getTaskContextSources(taskId: string) {
    return this.closure.getTaskContextSources(taskId)
  }

  softDeleteAgentSlot(sessionId: string, slotId: string, deletedAt: string) {
    return this.slotLifecycle.softDeleteAgentSlot(sessionId, slotId, deletedAt)
  }

  async getAgentSlot(slotId: string): Promise<AgentSlotDto | null> {
    const row = this.database
      .prepare('SELECT * FROM agent_slots WHERE id = ? AND deleted_at IS NULL')
      .get(slotId) as Row | undefined
    return row === undefined ? null : toAgentSlot(row)
  }

  async listAgentSlots(sessionId: string): Promise<AgentSlotDto[]> {
    const rows = this.database
      .prepare(
        `SELECT id, session_id, role_binding_id, model_id, status, created_at
         FROM agent_slots WHERE session_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
      )
      .all(sessionId) as Row[]
    return rows.map(toAgentSlot)
  }

  async createTurn(run: RunDto, task: TaskDto, message: MessageDto): Promise<void> {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO runs(
            id, workspace_id, session_id, status, attempt, started_at, ended_at,
            error_code, created_at, updated_at, event_sequence
          ) VALUES (@id, @workspace_id, @session_id, @status, @attempt, @started_at, @ended_at,
            @error_code, @created_at, @updated_at, 0)`,
        )
        .run({
          ...run,
          started_at: run.started_at ?? null,
          ended_at: run.ended_at ?? null,
          error_code: run.error_code ?? null,
          created_at: run.created_at ?? new Date().toISOString(),
          updated_at: run.updated_at ?? new Date().toISOString(),
        })
      this.database
        .prepare(
          `INSERT INTO tasks(
            id, workspace_id, session_id, run_id, slot_id, title, status, created_at, updated_at
          ) VALUES (@id, @workspace_id, @session_id, @run_id, @slot_id, @title, @status,
            @created_at, @updated_at)`,
        )
        .run(task)
      this.database
        .prepare(
          `INSERT INTO messages(id, session_id, run_id, sender_kind, sender_id, content, created_at)
           VALUES (@id, @session_id, @run_id, @sender_kind, @sender_id, @content, @created_at)`,
        )
        .run({ ...message, run_id: message.run_id ?? null, sender_id: message.sender_id ?? null })
      this.closure.insertTaskContextSources(task.id, task.slot_id, message.id, message.created_at)
    })
  }

  async saveRun(run: RunDto): Promise<RunDto> {
    this.database
      .prepare(
        `INSERT INTO runs(
          id, workspace_id, session_id, status, attempt, started_at, ended_at,
          error_code, created_at, updated_at, event_sequence
        ) VALUES (@id, @workspace_id, @session_id, @status, @attempt, @started_at, @ended_at,
          @error_code, @created_at, @updated_at, 0)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          attempt = excluded.attempt,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          error_code = excluded.error_code,
          updated_at = excluded.updated_at`,
      )
      .run({
        ...run,
        started_at: run.started_at ?? null,
        ended_at: run.ended_at ?? null,
        error_code: run.error_code ?? null,
        created_at: run.created_at ?? new Date().toISOString(),
        updated_at: run.updated_at ?? new Date().toISOString(),
      })
    return run
  }

  async getRun(id: string): Promise<RunDto | null> {
    const row = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? null : toRun(row)
  }

  async saveTask(task: TaskDto): Promise<TaskDto> {
    this.database
      .prepare(
        `INSERT INTO tasks(
          id, workspace_id, session_id, run_id, slot_id, title, status, created_at, updated_at
        ) VALUES (@id, @workspace_id, @session_id, @run_id, @slot_id, @title, @status,
          @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run(task)
    return task
  }

  async saveMessage(message: MessageDto): Promise<MessageDto> {
    this.database
      .prepare(
        `INSERT INTO messages(id, session_id, run_id, sender_kind, sender_id, content, created_at)
         VALUES (@id, @session_id, @run_id, @sender_kind, @sender_id, @content, @created_at)`,
      )
      .run({ ...message, run_id: message.run_id ?? null, sender_id: message.sender_id ?? null })
    return message
  }

  async listMessages(sessionId: string): Promise<MessageDto[]> {
    const rows = this.database
      .prepare(
        `SELECT id, session_id, run_id, sender_kind, sender_id, content, created_at,
                kind, to_slot_id
         FROM messages WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(sessionId) as Row[]
    return rows.map(toMessage)
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshotDto | null> {
    return this.database.transaction(() => {
      const session = this.getSessionSync(sessionId)
      if (session === null) {
        return null
      }
      const agentSlots = this.listAgentSlotsSync(sessionId)
      const runs = this.listRunsSync(sessionId)
      const tasks = this.listTasksSync(sessionId)
      const messages = this.listMessagesSync(sessionId)
      const permissions = this.listPermissionsSync(runs.map((run) => run.id))
      const latestSequences = this.latestSequencesSync(runs.map((run) => run.id))
      return {
        session,
        agent_slots: agentSlots,
        runs,
        tasks,
        messages,
        permissions,
        latest_sequences: latestSequences,
      }
    })
  }

  async appendEvent(event: Omit<EventEnvelope, 'sequence'>): Promise<EventEnvelope> {
    return this.database.transaction(() => this.appendEventSync(event))
  }

  private appendEventSync(event: Omit<EventEnvelope, 'sequence'>): EventEnvelope {
    // 普通 Event writer 不提供终态豁免；completed/failed/cancelled 一律拒绝。
    return appendRunScopedEventSync(this.database, event)
  }

  async replayEvents(runId: string, afterSequence: number): Promise<EventEnvelope[]> {
    const rows = this.database
      .prepare(
        `SELECT event_id, schema_version, workspace_id, session_id, run_id, sequence,
          type, source, occurred_at, payload_json
         FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence`,
      )
      .all(runId, afterSequence) as Row[]
    return rows.map(toEvent)
  }

  async getLatestSequence(runId: string): Promise<number> {
    const row = this.database
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE run_id = ?')
      .get(runId) as { sequence: number }
    return row.sequence
  }

  async getEventBounds(runId: string): Promise<{ first: number | null; last: number | null }> {
    const row = this.database
      .prepare('SELECT MIN(sequence) AS first, MAX(sequence) AS last FROM events WHERE run_id = ?')
      .get(runId) as { first?: number | null; last?: number | null }
    return { first: row.first ?? null, last: row.last ?? null }
  }

  async getPermissionRequest(id: string): Promise<PermissionRequestDto | null> {
    const row = this.database.prepare('SELECT * FROM permission_requests WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? null : toPermission(row)
  }

  async savePermissionRequest(request: PermissionRequestDto): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO permission_requests(
          id, run_id, task_id, slot_id, capability, description, adapter_options_json, status,
          requested_at, soft_timeout_at, overdue_at, expires_at, expired_at, answered_at,
          selected_option_id, adapter_request_id_encoded, expiration_reason, decision_id, lease_until
        ) VALUES (@id, @run_id, @task_id, @slot_id, @capability, @description, @adapter_options_json,
          @status, @requested_at, @soft_timeout_at, @overdue_at, @expires_at, @expired_at,
          @answered_at, @selected_option_id, @adapter_request_id_encoded, @expiration_reason, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          overdue_at = excluded.overdue_at,
          expires_at = excluded.expires_at,
          expired_at = excluded.expired_at,
          answered_at = excluded.answered_at,
          selected_option_id = excluded.selected_option_id,
          adapter_request_id_encoded = excluded.adapter_request_id_encoded,
          expiration_reason = excluded.expiration_reason`,
      )
      .run({ ...permissionParameters(request), adapter_options_json: toJson(request.adapter_options) })
  }

  async updatePermissionIfCurrent(
    _requestId: string,
    expectedStatus: PermissionRequestDto['status'],
    request: PermissionRequestDto,
  ): Promise<boolean> {
    return new SqlitePermissionEventStore(this.database, this.eventBus)
      .updatePermissionIfCurrent(expectedStatus, request)
  }

  async beginPermissionDecision(
    requestId: string,
    expectedStatus: 'pending',
    decisionId: string,
    leaseUntil: Date,
  ): Promise<PermissionRequestDto | null> {
    const now = new Date().toISOString()
    const result = this.database
      .prepare(
        `UPDATE permission_requests
         SET decision_id = ?, lease_until = ?
         WHERE id = ? AND status = ? AND (decision_id IS NULL OR lease_until <= ?)`,
      )
      .run(decisionId, leaseUntil.toISOString(), requestId, expectedStatus, now)
    if (result.changes !== 1) {
      return null
    }
    return this.getPermissionRequest(requestId)
  }

  async completePermissionDecision(
    decisionId: string,
    request: PermissionRequestDto,
    runStatus: 'running' | 'interrupted' | 'unchanged',
    taskStatus: 'paused' | 'running' | 'unchanged',
  ): Promise<boolean> {
    const events: EventEnvelope[] = []
    const updated = this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE permission_requests SET
            status = @status, overdue_at = @overdue_at, expired_at = @expired_at,
            answered_at = @answered_at, selected_option_id = @selected_option_id,
            expiration_reason = @expiration_reason, decision_id = NULL, lease_until = NULL
           WHERE id = @id AND decision_id = @decision_id`,
        )
        .run({
          ...permissionParameters(request),
          decision_id: decisionId,
        })
      if (result.changes !== 1) {
        return false
      }
      // 终态 Run/Task 不能被权限决定反向覆盖；unchanged 表示调用方已自行收敛。
      if (runStatus !== 'unchanged') {
        this.database
          .prepare("UPDATE runs SET status = ? WHERE id = ? AND status IN ('waiting_user', 'running')")
          .run(runStatus, request.run_id)
      }
      if (taskStatus !== 'unchanged') {
        this.database
          .prepare("UPDATE tasks SET status = ? WHERE id = ? AND status IN ('running', 'paused')")
          .run(taskStatus, request.task_id)
      }
      const run = this.database
        .prepare('SELECT workspace_id, session_id FROM runs WHERE id = ?')
        .get(request.run_id) as { workspace_id: string; session_id: string }
      const occurredAt = new Date().toISOString()
      events.push(this.appendEventSync({
        event_id: randomUUID(),
        schema_version: 1,
        workspace_id: run.workspace_id,
        session_id: run.session_id,
        run_id: request.run_id,
        type: request.status === 'expired' ? 'agent.permission_expired' : 'agent.permission_answered',
        source: 'permission-state-coordinator',
        occurred_at: occurredAt,
        payload: {
          permission_id: request.id,
          status: request.status,
          ...(request.expiration_reason === undefined ? {} : { expiration_reason: request.expiration_reason }),
        },
      }))
      // 用户取消 Run 引起的权限过期不是 Run 中断证据；Run 由 conversation 用例收敛。
      if (request.status === 'expired' && request.expiration_reason !== 'cancelled') {
        events.push(this.appendEventSync({
          event_id: randomUUID(),
          schema_version: 1,
          workspace_id: run.workspace_id,
          session_id: run.session_id,
          run_id: request.run_id,
          type: 'run.interrupted',
          source: 'permission-state-coordinator',
          occurred_at: occurredAt,
          payload: { permission_id: request.id },
        }))
      }
      return true
    })
    if (updated && this.eventBus !== null) {
      for (const event of events) {
        await this.eventBus.publish(event)
      }
    }
    return updated
  }

  async releasePermissionDecision(decisionId: string): Promise<void> {
    this.database
      .prepare('UPDATE permission_requests SET decision_id = NULL, lease_until = NULL WHERE decision_id = ?')
      .run(decisionId)
  }

  async recoverPermissionDecisions(now: Date): Promise<number> {
    const result = this.database
      .prepare(
        'UPDATE permission_requests SET decision_id = NULL, lease_until = NULL WHERE lease_until IS NOT NULL AND lease_until <= ?',
      )
      .run(now.toISOString())
    return result.changes
  }

  async transitionRun(runId: string, status: 'waiting_user' | 'running' | 'interrupted'): Promise<void> {
    this.database
      .prepare("UPDATE runs SET status = ? WHERE id = ? AND status IN ('waiting_user', 'running')")
      .run(status, runId)
  }

  async transitionTask(taskId: string, status: 'paused' | 'running'): Promise<void> {
    this.database
      .prepare("UPDATE tasks SET status = ? WHERE id = ? AND status IN ('running', 'paused')")
      .run(status, taskId)
  }

  async publish(type: PermissionEventType | 'run.interrupted', request?: PermissionRequestDto): Promise<void> {
    if (request === undefined) {
      return
    }
    const run = await this.getRun(request.run_id)
    if (run === null) {
      return
    }
    const existing = this.database
      .prepare("SELECT 1 AS found FROM events WHERE run_id = ? AND type = ? AND json_extract(payload_json, '$.permission_id') = ? LIMIT 1")
      .get(run.id, type, request.id) as { found?: number } | undefined
    if (existing?.found === 1) {
      return
    }
    const event = await this.appendEvent({
      event_id: randomUUID(),
      schema_version: 1,
      workspace_id: run.workspace_id,
      session_id: run.session_id,
      run_id: run.id,
      type,
      source: 'permission-state-coordinator',
      occurred_at: new Date().toISOString(),
      payload: {
        permission_id: request.id,
        status: request.status,
        ...(request.expiration_reason === undefined ? {} : { expiration_reason: request.expiration_reason }),
      },
    })
    if (this.eventBus !== null) {
      await this.eventBus.publish(event)
    }
  }

  async createSystemMessage(kind: 'permission_expired'): Promise<void> {
    this.database
      .prepare('INSERT INTO system_messages(id, kind, created_at) VALUES (?, ?, ?)')
      .run(randomUUID(), kind, new Date().toISOString())
  }

  async reconcileUnattachedPermissions(now: Date): Promise<number> {
    return new SqlitePermissionRecoveryStore(this.database, this.eventBus).reconcile(now)
  }

  getHandoffMessageByRequest(...args: Parameters<SqliteHandoffStore['getHandoffMessageByRequest']>) {
    return this.handoffs.getHandoffMessageByRequest(...args)
  }

  getHandoffSource(...args: Parameters<SqliteHandoffStore['getHandoffSource']>) {
    return this.handoffs.getHandoffSource(...args)
  }

  readRunEventPage(...args: Parameters<SqliteHandoffStore['readRunEventPage']>) {
    return this.handoffs.readRunEventPage(...args)
  }

  createHandoffMessage(...args: Parameters<SqliteHandoffStore['createHandoffMessage']>) {
    return this.handoffs.createHandoffMessage(...args)
  }

  async close(): Promise<void> {
    this.database.close()
  }

  private getSessionSync(id: string): SessionDto | null {
    const row = this.database
      .prepare('SELECT id, workspace_id, name, status, created_at, updated_at FROM sessions WHERE id = ?')
      .get(id) as Row | undefined
    return row === undefined ? null : toSession(row)
  }

  private listAgentSlotsSync(sessionId: string): AgentSlotDto[] {
    const rows = this.database
      .prepare('SELECT id, session_id, role_binding_id, model_id, status, created_at FROM agent_slots WHERE session_id = ? AND deleted_at IS NULL ORDER BY created_at, id')
      .all(sessionId) as Row[]
    return rows.map(toAgentSlot)
  }

  private listRunsSync(sessionId: string): RunDto[] {
    const rows = this.database
      .prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY created_at, id')
      .all(sessionId) as Row[]
    return rows.map(toRun)
  }

  private listTasksSync(sessionId: string): TaskDto[] {
    const rows = this.database
      .prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at, id')
      .all(sessionId) as Row[]
    return rows.map(toTask)
  }

  private listMessagesSync(sessionId: string): MessageDto[] {
    const rows = this.database
      .prepare('SELECT id, session_id, run_id, sender_kind, sender_id, content, created_at, kind, to_slot_id FROM messages WHERE session_id = ? ORDER BY created_at, id')
      .all(sessionId) as Row[]
    return rows.map(toMessage)
  }

  private listPermissionsSync(runIds: readonly string[]): PermissionRequestDto[] {
    if (runIds.length === 0) {
      return []
    }
    const placeholders = runIds.map(() => '?').join(', ')
    const rows = this.database
      .prepare(`SELECT * FROM permission_requests WHERE run_id IN (${placeholders}) ORDER BY requested_at, id`)
      .all(...runIds) as Row[]
    return rows.map(toPermission)
  }

  private latestSequencesSync(runIds: readonly string[]): Record<string, number> {
    return Object.fromEntries(runIds.map((runId) => [runId, this.getLatestSequenceSync(runId)]))
  }

  private getLatestSequenceSync(runId: string): number {
    const row = this.database
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE run_id = ?')
      .get(runId) as { sequence: number }
    return row.sequence
  }
}
