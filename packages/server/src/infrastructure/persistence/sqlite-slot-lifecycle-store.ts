import type { AgentSlotDto } from '@rolecast/contract'

import type {
  AgentSlotCreationReservation,
  AgentSlotDeletionResult,
  AgentSlotRoleSnapshotRecord,
  CommandReceiptRecord,
  CommandReceiptStatus,
  CommandDispatchState,
  RuntimeAttachmentRecord,
} from '../../application/ports/repository-port.js'
import { toRuntimeAttachment } from './sqlite-mappers.js'
import { SqliteDatabase } from './sqlite-database.js'

type Row = Record<string, unknown>

/**
 * @name SqliteSlotLifecycleStore
 * @description 持久化 AgentSlot 创建幂等、软删除与 Runtime cleanup attachment
 */
export class SqliteSlotLifecycleStore {
  constructor(private readonly database: SqliteDatabase) {}

  /** 原子保存新增 Slot、私有 Runtime attachment 与不可变 Role snapshot。 */
  async addAgentSlotWithAttachmentAndRoleSnapshot(
    slot: AgentSlotDto,
    attachment: RuntimeAttachmentRecord,
    roleSnapshot: AgentSlotRoleSnapshotRecord,
  ): Promise<void> {
    this.database.transaction(() => this.insertSlotBundle(slot, attachment, roleSnapshot))
  }

  /**
   * @name reserveAgentSlotCreation
   * @description 预留 add_slot receipt 与稳定 Slot ID；同键并发时只有一个调用者可继续
   * @param {CommandReceiptRecord} receipt 候选 reservation，必须含目标 Session、Slot 与输入摘要
   * @return {Promise<AgentSlotCreationReservation>} 已取得、已完成、进行中或冲突
   */
  async reserveAgentSlotCreation(receipt: CommandReceiptRecord): Promise<AgentSlotCreationReservation> {
    return this.database.transaction(() => {
      if (receipt.command !== 'add_slot' || receipt.target_slot_id === undefined || receipt.input_digest === undefined) {
        return { kind: 'conflict' }
      }
      const inserted = this.database
        .prepare(`INSERT INTO command_receipts(
                    workspace_id, request_id, command, target_id, target_slot_id, status, dispatch_state,
                    run_id, task_id, message_id, input_digest, error_code, updated_at
                  ) VALUES (?, ?, 'add_slot', ?, ?, 'reserved', 'not_started', NULL, NULL, NULL, ?, NULL, ?)
                  ON CONFLICT(workspace_id, request_id, command) DO NOTHING`)
        .run(
          receipt.workspace_id,
          receipt.request_id,
          receipt.target_id,
          receipt.target_slot_id,
          receipt.input_digest,
          receipt.updated_at,
        )
      const currentRow = this.database
        .prepare('SELECT * FROM command_receipts WHERE workspace_id = ? AND request_id = ? AND command = ?')
        .get(receipt.workspace_id, receipt.request_id, receipt.command) as Row | undefined
      if (currentRow === undefined) {
        return { kind: 'conflict' }
      }
      const current = toReceipt(currentRow)
      if (current.target_id !== receipt.target_id || current.input_digest !== receipt.input_digest) {
        return { kind: 'conflict' }
      }
      if (inserted.changes === 1 || current.status === 'reserved' && current.dispatch_state === 'not_started') {
        return inserted.changes === 1
          ? { kind: 'reserved', receipt: current }
          : { kind: 'in_progress' }
      }
      if (current.status === 'completed') {
        return { kind: 'completed', receipt: current }
      }
      if (
        current.status !== 'failed'
        || current.dispatch_state !== 'not_started'
        || current.run_id !== undefined
        || current.task_id !== undefined
        || current.message_id !== undefined
        || current.target_slot_id === undefined
      ) {
        return { kind: 'conflict' }
      }
      const changed = this.database
        .prepare(`UPDATE command_receipts SET status = 'reserved', dispatch_state = 'not_started',
                    error_code = NULL, updated_at = ?
                  WHERE workspace_id = ? AND request_id = ? AND command = ? AND target_id = ?
                    AND target_slot_id = ? AND input_digest = ? AND status = 'failed'
                    AND dispatch_state = 'not_started' AND run_id IS NULL AND task_id IS NULL AND message_id IS NULL`)
        .run(
          receipt.updated_at,
          receipt.workspace_id,
          receipt.request_id,
          receipt.command,
          receipt.target_id,
          current.target_slot_id,
          receipt.input_digest,
        )
      if (changed.changes !== 1) {
        return { kind: 'in_progress' }
      }
      return { kind: 'reserved', receipt: retryableReceipt(current, receipt.updated_at) }
    })
  }

  /** 原子提交 Slot、attachment、Role snapshot 与 completed add_slot receipt。 */
  async completeAgentSlotCreation(
    slot: AgentSlotDto,
    attachment: RuntimeAttachmentRecord,
    roleSnapshot: AgentSlotRoleSnapshotRecord,
    receipt: CommandReceiptRecord,
  ): Promise<'created' | 'receipt_conflict'> {
    return this.database.transaction(() => {
      if (
        receipt.command !== 'add_slot'
        || receipt.status !== 'reserved'
        || receipt.dispatch_state !== 'not_started'
        || receipt.target_id !== slot.session_id
        || receipt.target_slot_id !== slot.id
        || receipt.input_digest === undefined
      ) {
        return 'receipt_conflict'
      }
      const current = this.database
        .prepare(`SELECT status, dispatch_state, target_id, target_slot_id, input_digest,
                         run_id, task_id, message_id
                  FROM command_receipts WHERE workspace_id = ? AND request_id = ? AND command = ?`)
        .get(receipt.workspace_id, receipt.request_id, receipt.command) as {
          status: string
          dispatch_state: string
          target_id: string
          target_slot_id?: string | null
          input_digest?: string | null
          run_id?: string | null
          task_id?: string | null
          message_id?: string | null
        } | undefined
      if (
        current === undefined
        || current.status !== 'reserved'
        || current.dispatch_state !== 'not_started'
        || current.target_id !== slot.session_id
        || current.target_slot_id !== slot.id
        || current.input_digest !== receipt.input_digest
        || current.run_id !== null
        || current.task_id !== null
        || current.message_id !== null
      ) {
        return 'receipt_conflict'
      }
      this.insertSlotBundle(slot, attachment, roleSnapshot)
      const changed = this.database
        .prepare(`UPDATE command_receipts SET status = 'completed', error_code = NULL, updated_at = ?
                  WHERE workspace_id = ? AND request_id = ? AND command = ?
                    AND status = 'reserved' AND dispatch_state = 'not_started'
                    AND target_id = ? AND target_slot_id = ? AND input_digest = ?
                    AND run_id IS NULL AND task_id IS NULL AND message_id IS NULL`)
        .run(
          receipt.updated_at,
          receipt.workspace_id,
          receipt.request_id,
          receipt.command,
          slot.session_id,
          slot.id,
          receipt.input_digest,
        )
      if (changed.changes !== 1) {
        throw new Error('add_slot receipt changed during completion')
      }
      return 'created'
    })
  }

  /** 原子软删除非默认且没有活动 Run 的 Slot，保留 attachment 供后续清理。 */
  async softDeleteAgentSlot(
    sessionId: string,
    slotId: string,
    deletedAt: string,
  ): Promise<AgentSlotDeletionResult> {
    return this.database.transaction(() => {
      const slot = this.database
        .prepare('SELECT session_id, role_binding_id, deleted_at FROM agent_slots WHERE id = ?')
        .get(slotId) as { session_id: string; role_binding_id?: string | null; deleted_at?: string | null } | undefined
      if (slot === undefined || slot.session_id !== sessionId) {
        return 'not_found'
      }
      if (slot.deleted_at !== undefined && slot.deleted_at !== null) {
        return 'already_deleted'
      }
      if (slot.role_binding_id === undefined || slot.role_binding_id === null) {
        return 'default_slot'
      }
      const claim = this.database
        .prepare('SELECT 1 AS found FROM slot_activity_claims WHERE slot_id = ? LIMIT 1')
        .get(slotId)
      const activeRun = this.database
        .prepare(`SELECT 1 AS found FROM tasks
                  JOIN runs ON runs.id = tasks.run_id
                  WHERE tasks.slot_id = ?
                    AND runs.status NOT IN ('completed', 'failed', 'cancelled') LIMIT 1`)
        .get(slotId)
      if (claim !== undefined || activeRun !== undefined) {
        return 'slot_busy'
      }
      const changed = this.database
        .prepare("UPDATE agent_slots SET status = 'stopped', deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(deletedAt, slotId)
      if (changed.changes !== 1) {
        return 'already_deleted'
      }
      this.database.prepare('DELETE FROM slot_activity_claims WHERE slot_id = ?').run(slotId)
      return 'deleted'
    })
  }

  /** 查询活动 Slot 的 Runtime attachment，供正常恢复使用。 */
  async listActiveRuntimeAttachments(): Promise<RuntimeAttachmentRecord[]> {
    const rows = this.database
      .prepare(`SELECT attachment.* FROM runtime_attachments AS attachment
                JOIN agent_slots AS slot ON slot.id = attachment.slot_id
                WHERE slot.deleted_at IS NULL ORDER BY attachment.updated_at, attachment.slot_id`)
      .all() as Row[]
    return rows.map(toRuntimeAttachment)
  }

  /** 查询已软删除 Slot 的 cleanup attachment，不用于正常 Runtime 恢复。 */
  async listDeletedSlotRuntimeAttachments(): Promise<RuntimeAttachmentRecord[]> {
    const rows = this.database
      .prepare(`SELECT attachment.* FROM runtime_attachments AS attachment
                JOIN agent_slots AS slot ON slot.id = attachment.slot_id
                WHERE slot.deleted_at IS NOT NULL ORDER BY attachment.updated_at, attachment.slot_id`)
      .all() as Row[]
    return rows.map(toRuntimeAttachment)
  }

  private insertSlotBundle(
    slot: AgentSlotDto,
    attachment: RuntimeAttachmentRecord,
    roleSnapshot: AgentSlotRoleSnapshotRecord,
  ): void {
    if (
      slot.role_binding_id === undefined
      || slot.id !== attachment.slot_id
      || slot.session_id !== attachment.session_id
      || slot.id !== roleSnapshot.slot_id
      || slot.role_binding_id !== roleSnapshot.role_binding_id
    ) {
      throw new Error('AgentSlot, attachment and Role snapshot identity mismatch')
    }
    const session = this.database
      .prepare('SELECT workspace_id FROM sessions WHERE id = ?')
      .get(slot.session_id) as { workspace_id?: string } | undefined
    if (session === undefined || session.workspace_id !== roleSnapshot.workspace_id) {
      throw new Error('Role snapshot workspace does not match Session')
    }
    this.database
      .prepare(`INSERT INTO agent_slots(id, session_id, role_binding_id, model_id, status, created_at)
                VALUES (@id, @session_id, @role_binding_id, @model_id, @status, @created_at)`)
      .run(slot)
    this.database
      .prepare(`INSERT INTO runtime_attachments(
                  slot_id, session_id, provider_connection_id, provider_kind, config_revision,
                  adapter_version, adapter_fingerprint, cwd, runtime_directory, acp_session_id, updated_at
                ) VALUES (
                  @slot_id, @session_id, @provider_connection_id, @provider_kind, @config_revision,
                  @adapter_version, @adapter_fingerprint, @cwd, @runtime_directory, @acp_session_id, @updated_at
                )`)
      .run({ ...attachment, adapter_fingerprint: attachment.adapter_fingerprint ?? null })
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
}

const toReceipt = (row: Row): CommandReceiptRecord => ({
  workspace_id: String(row.workspace_id),
  request_id: String(row.request_id),
  command: String(row.command),
  target_id: String(row.target_id),
  ...(typeof row.target_slot_id === 'string' ? { target_slot_id: row.target_slot_id } : {}),
  status: row.status as CommandReceiptStatus,
  dispatch_state: row.dispatch_state as CommandReceiptRecord['dispatch_state'],
  ...(typeof row.run_id === 'string' ? { run_id: row.run_id } : {}),
  ...(typeof row.task_id === 'string' ? { task_id: row.task_id } : {}),
  ...(typeof row.message_id === 'string' ? { message_id: row.message_id } : {}),
  ...(typeof row.input_digest === 'string' ? { input_digest: row.input_digest } : {}),
  ...(typeof row.error_code === 'string' ? { error_code: row.error_code } : {}),
  updated_at: String(row.updated_at),
})

const retryableReceipt = (receipt: CommandReceiptRecord, updatedAt: string): CommandReceiptRecord => ({
  workspace_id: receipt.workspace_id,
  request_id: receipt.request_id,
  command: receipt.command,
  target_id: receipt.target_id,
  ...(receipt.target_slot_id === undefined ? {} : { target_slot_id: receipt.target_slot_id }),
  status: 'reserved',
  dispatch_state: 'not_started',
  ...(receipt.input_digest === undefined ? {} : { input_digest: receipt.input_digest }),
  updated_at: updatedAt,
})
