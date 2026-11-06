import type {
  AgentSlotDto,
  EventEnvelope,
  MessageDto,
  RunDto,
  SessionDto,
  TaskDto,
} from '@rolecast/contract'

import type {
  AgentSlotDeletionResult,
  CommandDispatchState,
  CommandReceiptRecord,
  CommandReceiptStatus,
  AgentSlotRoleSnapshotRecord,
  ContextSourceRecord,
  RuntimeAttachmentRecord,
  SlotActivityClaimRecord,
} from '../../application/ports/repository-port.js'
import { toAgentSlotRoleSnapshot, toRuntimeAttachment } from './sqlite-mappers.js'
import { insertTaskContextSources as insertTaskContextSourceRows } from './sqlite-context-source-writer.js'
import { SqliteDatabase } from './sqlite-database.js'
import {
  appendRunScopedEventSync,
  isTerminallyClosedStatus,
  readRunSequenceRow,
} from './sqlite-event-sequence.js'

type Row = Record<string, unknown>

/**
 * Run/Session 闭环的私有持久化操作。
 *
 * 全部在同一 SQLite 事务内完成跨表写入，避免 attachment、claim 与 Run 状态分裂。
 */
export class SqliteRunClosureStore {
  constructor(private readonly database: SqliteDatabase) {}

  /** 原子保存 Session、AgentSlot 与 Runtime attachment。 */
  async saveSessionWithAttachment(
    session: SessionDto,
    slot: AgentSlotDto,
    attachment: RuntimeAttachmentRecord,
    roleSnapshot?: AgentSlotRoleSnapshotRecord,
  ): Promise<void> {
    this.database.transaction(() => {
      if (slot.session_id !== session.id || attachment.session_id !== session.id || attachment.slot_id !== slot.id) {
        throw new Error('Session, Slot and attachment identity mismatch')
      }
      if ((slot.role_binding_id === undefined) !== (roleSnapshot === undefined)) {
        throw new Error('Role snapshot must match Slot binding state')
      }
      if (roleSnapshot !== undefined && (
        roleSnapshot.slot_id !== slot.id
        || roleSnapshot.role_binding_id !== slot.role_binding_id
        || roleSnapshot.workspace_id !== session.workspace_id
      )) {
        throw new Error('Role snapshot identity mismatch')
      }
      this.database
        .prepare(
          `INSERT INTO sessions(id, workspace_id, name, status, created_at, updated_at)
           VALUES (@id, @workspace_id, @name, @status, @created_at, @updated_at)`,
        )
        .run(session)
      this.database
        .prepare(
          `INSERT INTO agent_slots(id, session_id, model_id, role_binding_id, status, created_at)
           VALUES (@id, @session_id, @model_id, @role_binding_id, @status, @created_at)`,
        )
        .run({
          ...slot,
          role_binding_id: slot.role_binding_id ?? null,
        })
      this.upsertAttachment(attachment)
      if (roleSnapshot !== undefined) {
        this.database
          .prepare(`INSERT INTO agent_slot_role_snapshots(
                      slot_id, workspace_id, role_binding_id, role_binding_version, role_id,
                      role_version, role_name, system_prompt, required_guidelines_json,
                      output_contract, created_at
                    ) VALUES (
                      @slot_id, @workspace_id, @role_binding_id, @role_binding_version, @role_id,
                      @role_version, @role_name, @system_prompt, @required_guidelines_json,
                      @output_contract, @created_at
                    )`)
          .run({ ...roleSnapshot, required_guidelines_json: JSON.stringify(roleSnapshot.required_guidelines) })
      }
    })
  }

  async getAgentSlotRoleSnapshot(slotId: string): Promise<AgentSlotRoleSnapshotRecord | null> {
    const row = this.database
      .prepare('SELECT * FROM agent_slot_role_snapshots WHERE slot_id = ?')
      .get(slotId) as Row | undefined
    return row === undefined ? null : toAgentSlotRoleSnapshot(row)
  }

  async getTaskContextSources(taskId: string): Promise<ContextSourceRecord[]> {
    const rows = this.database
      .prepare(`SELECT * FROM context_sources WHERE task_id = ?
               ORDER BY CASE source_type WHEN 'role' THEN 0 WHEN 'role_binding' THEN 1 ELSE 2 END, source_id`)
      .all(taskId) as Row[]
    return rows.map((row) => ({
      task_id: String(row.task_id),
      source_type: row.source_type as ContextSourceRecord['source_type'],
      source_id: String(row.source_id),
      source_version: Number(row.source_version),
      created_at: String(row.created_at),
    }))
  }

  /** 在调用方当前 SQLite 事务内登记 Task 的 source references。 */
  insertTaskContextSources(taskId: string, slotId: string, messageId: string, createdAt: string): void {
    insertTaskContextSourceRows(this.database, taskId, slotId, messageId, createdAt)
  }

  async getRuntimeAttachment(slotId: string): Promise<RuntimeAttachmentRecord | null> {
    const row = this.database
      .prepare('SELECT * FROM runtime_attachments WHERE slot_id = ?')
      .get(slotId) as Row | undefined
    return row === undefined ? null : toRuntimeAttachment(row)
  }

  /** retry 建立新 ACP Session 后原子替换该 Slot 的 attachment。 */
  async saveRuntimeAttachment(attachment: RuntimeAttachmentRecord): Promise<void> {
    this.upsertAttachment(attachment)
  }

  async deleteRuntimeAttachment(slotId: string): Promise<void> {
    this.database.prepare('DELETE FROM runtime_attachments WHERE slot_id = ?').run(slotId)
  }

  async getCommandReceipt(
    workspaceId: string,
    requestId: string,
    command: string,
  ): Promise<CommandReceiptRecord | null> {
    const row = this.database
      .prepare('SELECT * FROM command_receipts WHERE workspace_id = ? AND request_id = ? AND command = ?')
      .get(workspaceId, requestId, command) as Row | undefined
    return row === undefined ? null : toReceipt(row)
  }

  async listIncompleteCommandReceipts(): Promise<CommandReceiptRecord[]> {
    const rows = this.database
      .prepare("SELECT * FROM command_receipts WHERE status IN ('reserved', 'running') ORDER BY updated_at")
      .all() as Row[]
    return rows.map(toReceipt)
  }

  /** 插入回执；同键已存在时返回既有回执（不覆盖）。 */
  async insertCommandReceipt(receipt: CommandReceiptRecord): Promise<CommandReceiptRecord> {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO command_receipts(
            workspace_id, request_id, command, target_id, target_slot_id, status, dispatch_state,
            run_id, task_id, message_id, input_digest, error_code, updated_at
          ) VALUES (@workspace_id, @request_id, @command, @target_id, @target_slot_id, @status, @dispatch_state,
            @run_id, @task_id, @message_id, @input_digest, @error_code, @updated_at)
          ON CONFLICT(workspace_id, request_id, command) DO NOTHING`,
        )
        .run(receiptParameters(receipt))
    })
    const existing = await this.getCommandReceipt(receipt.workspace_id, receipt.request_id, receipt.command)
    if (existing === null) {
      throw new Error('command receipt insert disappeared')
    }
    return existing
  }

  /** 按状态与派发边界 CAS 更新；不匹配返回 null。 */
  async updateCommandReceipt(
    receipt: CommandReceiptRecord,
    expectedStatus: CommandReceiptStatus,
    expectedDispatchState: CommandDispatchState,
    expectedReferences?: { run_id: string | null; task_id: string | null; message_id: string | null },
  ): Promise<CommandReceiptRecord | null> {
    const expected = expectedReferences ?? {
      run_id: receipt.run_id ?? null,
      task_id: receipt.task_id ?? null,
      message_id: receipt.message_id ?? null,
    }
    const changed = this.database.transaction(() => this.database
      .prepare(
        `UPDATE command_receipts SET
          status = @status, dispatch_state = @dispatch_state, run_id = @run_id,
          task_id = @task_id, message_id = @message_id, error_code = @error_code,
          updated_at = @updated_at
         WHERE workspace_id = @workspace_id AND request_id = @request_id AND command = @command
           AND status = @expected_status AND dispatch_state = @expected_dispatch_state
           AND run_id IS @expected_run_id AND task_id IS @expected_task_id AND message_id IS @expected_message_id`,
      )
      .run({
        ...receiptParameters(receipt),
        expected_status: expectedStatus,
        expected_dispatch_state: expectedDispatchState,
        expected_run_id: expected.run_id,
        expected_task_id: expected.task_id,
        expected_message_id: expected.message_id,
      }))
    if (changed.changes !== 1) {
      return null
    }
    return this.getCommandReceipt(receipt.workspace_id, receipt.request_id, receipt.command)
  }

  async getSlotActivityClaim(slotId: string): Promise<SlotActivityClaimRecord | null> {
    const row = this.database
      .prepare('SELECT * FROM slot_activity_claims WHERE slot_id = ?')
      .get(slotId) as Row | undefined
    return row === undefined ? null : toClaim(row)
  }

  async listSlotActivityClaims(): Promise<SlotActivityClaimRecord[]> {
    const rows = this.database
      .prepare('SELECT * FROM slot_activity_claims ORDER BY slot_id')
      .all() as Row[]
    return rows.map(toClaim)
  }

  /** 取得 Slot 活动 claim；已被任何 Run 或 recovery hold 占用时返回 false。 */
  async claimSlotActivity(slotId: string, runId: string, now: string): Promise<boolean> {
    return this.database.transaction(() => {
      const existing = this.database
        .prepare('SELECT run_id, state FROM slot_activity_claims WHERE slot_id = ?')
        .get(slotId) as { run_id?: string | null; state?: string } | undefined
      if (existing !== undefined) {
        // recovery hold 或已有活动 Run 都会阻止新的 claim；不排队。
        if (existing.state === 'recovery_conflict') {
          return false
        }
        if (existing.run_id !== null && existing.run_id !== undefined) {
          return false
        }
      }
      this.database
        .prepare(
          `INSERT INTO slot_activity_claims(slot_id, run_id, state, updated_at)
           VALUES (?, ?, 'active', ?)
           ON CONFLICT(slot_id) DO UPDATE SET run_id = excluded.run_id, state = 'active',
             updated_at = excluded.updated_at`,
        )
        .run(slotId, runId, now)
      return true
    })
  }

  /** 释放仍属于指定 Run 的 claim；不属于则不动。 */
  async releaseSlotActivity(slotId: string, runId: string): Promise<void> {
    this.database
      .prepare("DELETE FROM slot_activity_claims WHERE slot_id = ? AND run_id = ? AND state = 'active'")
      .run(slotId, runId)
  }

  /** 清空 Slot claim；启动重建 claim 时使用。 */
  async resetSlotActivity(slotId: string): Promise<void> {
    this.database.prepare('DELETE FROM slot_activity_claims WHERE slot_id = ?').run(slotId)
  }

  /** 把 claim 从父 Run 移交给子 Run。 */
  async transferSlotActivity(slotId: string, fromRunId: string, toRunId: string): Promise<boolean> {
    const changed = this.database
      .prepare(
        `UPDATE slot_activity_claims SET run_id = ?, updated_at = ?
         WHERE slot_id = ? AND run_id = ? AND state = 'active'`,
      )
      .run(toRunId, new Date().toISOString(), slotId, fromRunId)
    return changed.changes === 1
  }

  async getRunStateRevision(runId: string): Promise<number | null> {
    const row = this.database
      .prepare('SELECT state_revision FROM runs WHERE id = ?')
      .get(runId) as { state_revision?: number } | undefined
    return row === undefined ? null : Number(row.state_revision)
  }

  async setSlotRecoveryConflict(slotId: string, now: string): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO slot_activity_claims(slot_id, run_id, state, updated_at)
         VALUES (?, NULL, 'recovery_conflict', ?)
         ON CONFLICT(slot_id) DO UPDATE SET run_id = NULL, state = 'recovery_conflict',
           updated_at = excluded.updated_at`,
      )
      .run(slotId, now)
  }

  /** 按 `state_revision` CAS 保存 Run 并自增 revision。 */
  async updateRunIfRevision(run: RunDto, expectedStateRevision: number): Promise<RunDto | null> {
    const changed = this.database.transaction(() => this.database
      .prepare(
        `UPDATE runs SET
          status = @status, started_at = @started_at, ended_at = @ended_at,
          error_code = @error_code, retry_of_run_id = @retry_of_run_id,
          updated_at = @updated_at, state_revision = state_revision + 1
         WHERE id = @id AND state_revision = @expected_state_revision`,
      )
      .run({
        ...runParameters(run),
        expected_state_revision: expectedStateRevision,
      }))
    if (changed.changes !== 1) {
      return null
    }
    const row = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(run.id) as Row | undefined
    return row === undefined ? null : toRun(row)
  }

  /** 读取 Run 的内部输入消息；不暴露到 DTO。 */
  async getRunInputMessage(runId: string): Promise<MessageDto | null> {
    const row = this.database
      .prepare(
        `SELECT messages.* FROM messages
           JOIN tasks ON tasks.input_message_id = messages.id
          WHERE tasks.run_id = ?`,
      )
      .get(runId) as Row | undefined
    return row === undefined ? null : toMessage(row)
  }

  /**
   * 原子创建 start 的 Run/Task/用户 Message 并取得 Slot claim。
   *
   * 返回 false 表示该 Slot 已有活动 Run（不排队，调用方返回 409）。
   */
  async createTurnWithClaim(run: RunDto, task: TaskDto, message: MessageDto, now: string): Promise<boolean> {
    return this.database.transaction(() => {
      const activeSlot = this.database
        .prepare('SELECT 1 AS found FROM agent_slots WHERE id = ? AND session_id = ? AND deleted_at IS NULL')
        .get(task.slot_id, task.session_id)
      if (activeSlot === undefined) {
        return false
      }
      const claimed = this.database
        .prepare('SELECT run_id, state FROM slot_activity_claims WHERE slot_id = ?')
        .get(task.slot_id) as { run_id?: string | null; state?: string } | undefined
      if (claimed !== undefined && (claimed.run_id !== null || claimed.state === 'recovery_conflict')) {
        return false
      }
      this.database
        .prepare(
          `INSERT INTO slot_activity_claims(slot_id, run_id, state, updated_at)
           VALUES (?, ?, 'active', ?)
           ON CONFLICT(slot_id) DO UPDATE SET run_id = excluded.run_id, state = 'active',
             updated_at = excluded.updated_at`,
        )
        .run(task.slot_id, run.id, now)
      insertRun(this.database, run)
      insertTask(this.database, task, message.id)
      insertMessage(this.database, message)
      this.insertTaskContextSources(task.id, task.slot_id, message.id, message.created_at)
      return true
    })
  }

  /**
   * 原子创建 start 的 Run/Task/Message、取得 claim 并把引用写回 receipt。
   *
   * 回执在创建事务内保持调用方期望的边界（`reserved/not_started` 或
   * `failed/not_started`），只有真正调用 Runtime 前才推进到 `running/started`。
   * 这样崩溃后同 key 可以复用既有 Run，而不会重复创建。
   */
  async createTurnWithReceipt(
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
  ): Promise<'created' | 'slot_busy' | 'slot_unavailable' | 'receipt_conflict'> {
    return this.database.transaction(() => {
      const current = this.database
        .prepare(
          `SELECT status, dispatch_state, target_id, target_slot_id, run_id, task_id, message_id
             FROM command_receipts
            WHERE workspace_id = ? AND request_id = ? AND command = ?`,
        )
        .get(receipt.workspace_id, receipt.request_id, receipt.command) as
        | {
            status: string
            dispatch_state: string
            target_id: string
            target_slot_id?: string | null
            run_id?: string | null
            task_id?: string | null
            message_id?: string | null
          }
        | undefined
      if (
        current === undefined
        || current.status !== expected.status
        || current.dispatch_state !== expected.dispatch_state
        || current.target_id !== expected.target_id
        || (typeof current.target_slot_id === 'string' ? current.target_slot_id : null) !== expected.target_slot_id
        || (current.run_id !== undefined && current.run_id !== null)
        || (current.task_id !== undefined && current.task_id !== null)
        || (current.message_id !== undefined && current.message_id !== null)
      ) {
        // 回执已被并发推进或指向别的目标：不创建任何 Run。
        return 'receipt_conflict'
      }
      const activeSlot = this.database
        .prepare('SELECT 1 AS found FROM agent_slots WHERE id = ? AND session_id = ? AND deleted_at IS NULL')
        .get(task.slot_id, task.session_id)
      if (activeSlot === undefined) {
        this.database
          .prepare(`UPDATE command_receipts SET status = 'failed', dispatch_state = 'not_started',
                    error_code = 'not_found', updated_at = ?
                    WHERE workspace_id = ? AND request_id = ? AND command = ?
                      AND status = ? AND dispatch_state = ?`)
          .run(now, receipt.workspace_id, receipt.request_id, receipt.command, expected.status, expected.dispatch_state)
        return 'slot_unavailable'
      }
      const claimed = this.database
        .prepare('SELECT run_id, state FROM slot_activity_claims WHERE slot_id = ?')
        .get(task.slot_id) as { run_id?: string | null; state?: string } | undefined
      if (claimed !== undefined && (claimed.run_id !== null || claimed.state === 'recovery_conflict')) {
        // Slot 已被占用：回执转可安全重试的失败边界，不留下 Run/Task/Message。
        this.database
          .prepare(
            `UPDATE command_receipts SET status = 'failed', dispatch_state = 'not_started',
              error_code = 'slot_busy', updated_at = ?
             WHERE workspace_id = ? AND request_id = ? AND command = ?
               AND status = ? AND dispatch_state = ?`,
          )
          .run(
            now,
            receipt.workspace_id,
            receipt.request_id,
            receipt.command,
            expected.status,
            expected.dispatch_state,
          )
        return 'slot_busy'
      }
      this.database
        .prepare(
          `INSERT INTO slot_activity_claims(slot_id, run_id, state, updated_at)
           VALUES (?, ?, 'active', ?)
           ON CONFLICT(slot_id) DO UPDATE SET run_id = excluded.run_id, state = 'active',
             updated_at = excluded.updated_at`,
        )
        .run(task.slot_id, run.id, now)
      insertRun(this.database, run)
      insertTask(this.database, task, message.id)
      insertMessage(this.database, message)
      this.insertTaskContextSources(task.id, task.slot_id, message.id, now)
      const changed = this.database
        .prepare(
          `UPDATE command_receipts SET run_id = ?, task_id = ?, message_id = ?, updated_at = ?
           WHERE workspace_id = ? AND request_id = ? AND command = ?
             AND status = ? AND dispatch_state = ?`,
        )
        .run(
          run.id,
          task.id,
          message.id,
          now,
          receipt.workspace_id,
          receipt.request_id,
          receipt.command,
          expected.status,
          expected.dispatch_state,
        )
      if (changed.changes !== 1) {
        // 回执在事务内被并发推进：整体回滚，避免出现无回执的 Run。
        throw new Error('command receipt was claimed concurrently')
      }
      return 'created'
    })
  }

  /**
   * 终态事务：以 expected state_revision CAS Run，并在同一事务内更新 Task、
   * 释放或保留 claim、追加事件。迟到写入返回 null 且不改任何表。
   */
  async finalizeRun(input: {
    run: RunDto
    expectedStateRevision: number
    taskId: string
    taskStatus: TaskDto['status']
    slotId: string
    releaseClaim: boolean
    event?: Omit<EventEnvelope, 'sequence'>
  }): Promise<{ run: RunDto; task: TaskDto } | null> {
    return this.database.transaction(() => {
      const current = readRunSequenceRow(this.database, input.run.id)
      if (current === null) {
        return null
      }
      // 完成水位在 CAS 前按同一游标计算：closure Event 先占用下一个 sequence。
      const completedSequence = input.run.status === 'completed' && current.event_sequence !== null
        ? current.event_sequence + (input.event === undefined ? 0 : 1)
        : current.completed_sequence
      const changed = this.database
        .prepare(
          `UPDATE runs SET
            status = @status, started_at = @started_at, ended_at = @ended_at,
            error_code = @error_code, updated_at = @updated_at,
            completed_sequence = @completed_sequence,
            state_revision = state_revision + 1
           WHERE id = @id AND state_revision = @expected_state_revision`,
        )
        .run({
          ...runParameters(input.run),
          expected_state_revision: input.expectedStateRevision,
          completed_sequence: completedSequence,
        })
      if (changed.changes !== 1) {
        return null
      }
      const taskRow = this.database
        .prepare('SELECT * FROM tasks WHERE id = ?')
        .get(input.taskId) as Row | undefined
      if (taskRow === undefined) {
        throw new Error('task disappeared during finalize')
      }
      this.database
        .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
        .run(input.taskStatus, input.run.updated_at ?? new Date().toISOString(), input.taskId)
      if (input.releaseClaim) {
        this.database
          .prepare("DELETE FROM slot_activity_claims WHERE slot_id = ? AND run_id = ? AND state = 'active'")
          .run(input.slotId, input.run.id)
      }
      if (input.event !== undefined) {
        // 同一事务内分配 sequence；终态 closure Event 由本事务授权。
        appendRunScopedEventSync(this.database, input.event, {
          allowTerminal: isTerminallyClosedStatus(input.run.status),
        })
      }
      const updatedRun = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(input.run.id) as Row
      const updatedTask = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(input.taskId) as Row
      return { run: toRun(updatedRun), task: toTask(updatedTask) }
    })
  }

  /** 列出全部非终态 Run（用于启动扫描孤儿现场）。 */
  async listNonTerminalRuns(): Promise<RunDto[]> {
    const rows = this.database
      .prepare(
        `SELECT * FROM runs
          WHERE status NOT IN ('completed', 'failed', 'cancelled')
          ORDER BY session_id, attempt`,
      )
      .all() as Row[]
    return rows.map(toRun)
  }

  /** 写入或更新 attachment（服务启动恢复成功后刷新）。 */
  upsertAttachment(attachment: RuntimeAttachmentRecord): void {
    this.database
      .prepare(
        `INSERT INTO runtime_attachments(
          slot_id, session_id, provider_connection_id, provider_kind, config_revision,
          adapter_version, adapter_fingerprint, cwd, runtime_directory,
          acp_session_id, updated_at
        ) VALUES (@slot_id, @session_id, @provider_connection_id, @provider_kind, @config_revision,
          @adapter_version, @adapter_fingerprint, @cwd, @runtime_directory,
          @acp_session_id, @updated_at)
        ON CONFLICT(slot_id) DO UPDATE SET
          provider_connection_id = excluded.provider_connection_id,
          provider_kind = excluded.provider_kind,
          config_revision = excluded.config_revision,
          adapter_version = excluded.adapter_version,
          adapter_fingerprint = excluded.adapter_fingerprint,
          cwd = excluded.cwd,
          runtime_directory = excluded.runtime_directory,
          acp_session_id = excluded.acp_session_id,
          updated_at = excluded.updated_at`,
      )
      .run(attachmentParameters(attachment))
  }
}

/** 插入 Run；`chainId` 指定 retry chain（子 Run 沿用父链）。 */
export function insertRun(database: SqliteDatabase, run: RunDto, chainId = run.id): void {
  database
    .prepare(
      `INSERT INTO runs(
        id, workspace_id, session_id, status, attempt, started_at, ended_at,
        error_code, retry_of_run_id, retry_chain_id, created_at, updated_at, event_sequence
      ) VALUES (@id, @workspace_id, @session_id, @status, @attempt, @started_at, @ended_at,
        @error_code, @retry_of_run_id, @retry_chain_id, @created_at, @updated_at, 0)`,
    )
    .run({ ...runParameters(run), retry_chain_id: chainId })
}

/**
 * @name insertTask
 * @description 插入 Task 与私有 lineage；输入消息只存内部关联。
 * @param database SQLite 数据库
 * @param task 公共 Task DTO
 * @param inputMessageId 内部输入消息 ID
 * @param lineage 私有 lineage，普通单 Agent Task 默认 agent/1
 * @returns 无返回值
 */
export function insertTask(
  database: SqliteDatabase,
  task: TaskDto,
  inputMessageId: string | null,
  lineage: { nodeKey: string; attempt: number; retryOfTaskId: string | null } = {
    nodeKey: 'agent',
    attempt: 1,
    retryOfTaskId: null,
  },
): void {
  database
    .prepare(
      `INSERT INTO tasks(
        id, workspace_id, session_id, run_id, slot_id, title, status,
        input_message_id, node_key, attempt, retry_of_task_id, created_at, updated_at
      ) VALUES (@id, @workspace_id, @session_id, @run_id, @slot_id, @title, @status,
        @input_message_id, @node_key, @lineage_attempt, @retry_of_task_id, @created_at, @updated_at)`,
    )
    .run({
      ...task,
      input_message_id: inputMessageId,
      node_key: lineage.nodeKey,
      lineage_attempt: lineage.attempt,
      retry_of_task_id: lineage.retryOfTaskId,
    })
}

/**
 * @name saveTaskWithDefaultLineage
 * @description 写入 Task 并补充私有 lineage。公共 TaskDto 不携带节点身份，
 *   只有 Run 内首个 Task 采用单 Agent 默认 lineage（agent/1）；后续 Task 写 NULL 表示未知，
 *   避免与 (run_id, node_key, attempt) 唯一索引冲突。更新已有 Task 时保留原 lineage。
 * @param database SQLite 数据库
 * @param task 公共 Task DTO
 * @returns 无返回值
 */
export function saveTaskWithDefaultLineage(database: SqliteDatabase, task: TaskDto): void {
  database
    .prepare(
      `INSERT INTO tasks(
        id, workspace_id, session_id, run_id, slot_id, title, status,
        node_key, attempt, retry_of_task_id, created_at, updated_at
      ) VALUES (@id, @workspace_id, @session_id, @run_id, @slot_id, @title, @status,
        CASE WHEN EXISTS(SELECT 1 FROM tasks WHERE run_id = @run_id) THEN NULL ELSE 'agent' END,
        CASE WHEN EXISTS(SELECT 1 FROM tasks WHERE run_id = @run_id) THEN NULL ELSE 1 END,
        NULL, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        updated_at = excluded.updated_at`,
    )
    .run(task)
}

/** 插入用户/Agent Message。 */
export function insertMessage(database: SqliteDatabase, message: MessageDto): void {
  database
    .prepare(
      `INSERT INTO messages(id, session_id, run_id, sender_kind, sender_id, content, created_at)
       VALUES (@id, @session_id, @run_id, @sender_kind, @sender_id, @content, @created_at)`,
    )
    .run({
      ...message,
      run_id: message.run_id ?? null,
      sender_id: message.sender_id ?? null,
    })
}

const runParameters = (run: RunDto): Record<string, unknown> => ({
  ...run,
  started_at: run.started_at ?? null,
  ended_at: run.ended_at ?? null,
  error_code: run.error_code ?? null,
  retry_of_run_id: run.retry_of_run_id ?? null,
  retry_chain_id: run.id,
  created_at: run.created_at ?? new Date().toISOString(),
  updated_at: run.updated_at ?? new Date().toISOString(),
})

const attachmentParameters = (attachment: RuntimeAttachmentRecord): Record<string, unknown> => ({
  ...attachment,
  adapter_fingerprint: attachment.adapter_fingerprint ?? null,
})

const receiptParameters = (receipt: CommandReceiptRecord): Record<string, unknown> => ({
  ...receipt,
  target_slot_id: receipt.target_slot_id ?? null,
  run_id: receipt.run_id ?? null,
  task_id: receipt.task_id ?? null,
  message_id: receipt.message_id ?? null,
  input_digest: receipt.input_digest ?? null,
  error_code: receipt.error_code ?? null,
})

const toReceipt = (row: Row): CommandReceiptRecord => ({
  workspace_id: String(row.workspace_id),
  request_id: String(row.request_id),
  command: String(row.command),
  target_id: String(row.target_id),
  ...(typeof row.target_slot_id === 'string' ? { target_slot_id: row.target_slot_id } : {}),
  status: row.status as CommandReceiptStatus,
  dispatch_state: row.dispatch_state as CommandDispatchState,
  ...(typeof row.run_id === 'string' ? { run_id: row.run_id } : {}),
  ...(typeof row.task_id === 'string' ? { task_id: row.task_id } : {}),
  ...(typeof row.message_id === 'string' ? { message_id: row.message_id } : {}),
  ...(typeof row.input_digest === 'string' ? { input_digest: row.input_digest } : {}),
  ...(typeof row.error_code === 'string' ? { error_code: row.error_code } : {}),
  updated_at: String(row.updated_at),
})

const toClaim = (row: Row): SlotActivityClaimRecord => ({
  slot_id: String(row.slot_id),
  run_id: typeof row.run_id === 'string' ? row.run_id : null,
  state: row.state as SlotActivityClaimRecord['state'],
  updated_at: String(row.updated_at),
})

const toRun = (row: Row): RunDto => ({
  id: String(row.id),
  workspace_id: String(row.workspace_id),
  session_id: String(row.session_id),
  status: row.status as RunDto['status'],
  attempt: Number(row.attempt),
  ...(typeof row.started_at === 'string' ? { started_at: row.started_at } : {}),
  ...(typeof row.ended_at === 'string' ? { ended_at: row.ended_at } : {}),
  ...(typeof row.error_code === 'string' ? { error_code: row.error_code } : {}),
  ...(typeof row.retry_of_run_id === 'string' ? { retry_of_run_id: row.retry_of_run_id } : {}),
  ...(typeof row.created_at === 'string' ? { created_at: row.created_at } : {}),
  ...(typeof row.updated_at === 'string' ? { updated_at: row.updated_at } : {}),
})

const toTask = (row: Row): TaskDto => ({
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

const toMessage = (row: Row): MessageDto => ({
  id: String(row.id),
  session_id: String(row.session_id),
  run_id: typeof row.run_id === 'string' ? row.run_id : null,
  sender_kind: row.sender_kind as MessageDto['sender_kind'],
  sender_id: typeof row.sender_id === 'string' ? row.sender_id : null,
  content: String(row.content),
  created_at: String(row.created_at),
})
