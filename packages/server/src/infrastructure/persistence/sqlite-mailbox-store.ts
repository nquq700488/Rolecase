import type { MailboxMessageDetailDto, MailboxPageDto, MailboxPageQuery } from '@rolecast/contract'

import type { MailboxReadResult } from '../../application/ports/mailbox-repository-port.js'
import { appendMailboxReadMetadataEventSync } from './sqlite-event-sequence.js'
import { toMessage } from './sqlite-mappers.js'
import type { SqliteDatabase } from './sqlite-database.js'

type Row = Record<string, unknown>

/** 目标 Slot 在该 Session 内的可见性；不存在或越界一律视为不可用。 */
const MAILBOX_MESSAGE_WHERE = `
  m.session_id = ? AND m.kind = 'handoff' AND m.to_slot_id = ?
  AND m.sender_id IS NOT NULL AND m.run_id IS NOT NULL
`

/** handoff 收件摘要、详情与 read marker 的 SQLite 实现。 */
export class SqliteMailboxStore {
  constructor(private readonly database: SqliteDatabase) {}

  /** 有界 keyset 摘要页；不读取 Message 正文。 */
  async listMailboxMessages(sessionId: string, query: MailboxPageQuery): Promise<MailboxPageDto | null> {
    return this.database.transaction(() => {
      if (!this.slotBelongsToSession(sessionId, query.slot_id)) {
        return null
      }
      let cursor: { created_at: string; id: string } | null = null
      if (query.cursor !== undefined) {
        cursor = this.readVisibleCursor(sessionId, query.slot_id, query.cursor)
        if (cursor === null) {
          return null
        }
      }
      const limit = Math.max(1, Math.min(query.limit, 100))
      const parameters: unknown[] = [sessionId, query.slot_id]
      let keyset = ''
      if (cursor !== null) {
        keyset = 'AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))'
        parameters.push(cursor.created_at, cursor.created_at, cursor.id)
      }
      const rows = this.database
        .prepare(
          `SELECT m.id, m.session_id, m.sender_id, m.to_slot_id, m.created_at, mk.read_at
             FROM messages m
             LEFT JOIN mailbox_read_markers mk ON mk.message_id = m.id
            WHERE ${MAILBOX_MESSAGE_WHERE} ${keyset}
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT ?`,
        )
        .all(...parameters, limit + 1) as Row[]
      const items = rows.slice(0, limit).map(toSummary)
      return {
        items,
        next_cursor: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null,
      }
    })
  }

  /** 单条详情；读取本身不写收件状态。 */
  async getMailboxMessage(
    sessionId: string,
    messageId: string,
    slotId: string,
  ): Promise<MailboxMessageDetailDto | null> {
    return this.database.transaction(() => {
      if (!this.slotBelongsToSession(sessionId, slotId)) {
        return null
      }
      const row = this.database
        .prepare(
          `SELECT m.*, mk.read_at
             FROM messages m
             LEFT JOIN mailbox_read_markers mk ON mk.message_id = m.id
            WHERE m.id = ? AND ${MAILBOX_MESSAGE_WHERE}`,
        )
        .get(messageId, sessionId, slotId) as Row | undefined
      return row === undefined ? null : toDetail(row)
    })
  }

  /** marker 与 metadata-only Event 同一事务提交；重复标记不新增 Event。 */
  async markMailboxMessageRead(input: {
    readonly session_id: string
    readonly message_id: string
    readonly slot_id: string
    readonly read_at: string
    readonly event_id: string
  }): Promise<MailboxReadResult> {
    return this.database.transaction(() => {
      if (!this.slotBelongsToSession(input.session_id, input.slot_id)) {
        return { kind: 'unavailable' as const }
      }
      const row = this.database
        .prepare(
          `SELECT m.*, mk.read_at
             FROM messages m
             LEFT JOIN mailbox_read_markers mk ON mk.message_id = m.id
            WHERE m.id = ? AND ${MAILBOX_MESSAGE_WHERE}`,
        )
        .get(input.message_id, input.session_id, input.slot_id) as Row | undefined
      if (row === undefined) {
        return { kind: 'unavailable' as const }
      }
      if (row.read_at !== null && row.read_at !== undefined) {
        return { kind: 'already_read' as const, read_at: String(row.read_at) }
      }
      const workspace = this.database
        .prepare('SELECT workspace_id FROM sessions WHERE id = ?')
        .get(input.session_id) as { workspace_id: string }
      this.database
        .prepare(
          `INSERT INTO mailbox_read_markers(message_id, session_id, recipient_slot_id, read_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(input.message_id, input.session_id, input.slot_id, input.read_at)
      const event = appendMailboxReadMetadataEventSync(this.database, {
        event_id: input.event_id,
        schema_version: 1,
        workspace_id: String(workspace.workspace_id),
        session_id: input.session_id,
        run_id: String(row.run_id),
        type: 'message.read',
        source: 'mailbox',
        occurred_at: input.read_at,
        payload: {
          message_id: input.message_id,
          recipient_slot_id: input.slot_id,
          read_at: input.read_at,
        },
      })
      return { kind: 'marked' as const, read_at: input.read_at, event }
    })
  }

  private slotBelongsToSession(sessionId: string, slotId: string): boolean {
    const row = this.database
      .prepare('SELECT 1 AS found FROM agent_slots WHERE id = ? AND session_id = ? AND deleted_at IS NULL')
      .get(slotId, sessionId)
    return row !== undefined
  }

  private readVisibleCursor(
    sessionId: string,
    slotId: string,
    messageId: string,
  ): { created_at: string; id: string } | null {
    const row = this.database
      .prepare(`SELECT m.created_at FROM messages m WHERE m.id = ? AND ${MAILBOX_MESSAGE_WHERE}`)
      .get(messageId, sessionId, slotId) as { created_at?: string } | undefined
    return row === undefined ? null : { created_at: String(row.created_at), id: messageId }
  }
}

function toSummary(row: Row): MailboxPageDto['items'][number] {
  const readAt = row.read_at === null || row.read_at === undefined ? null : String(row.read_at)
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    sender_id: String(row.sender_id),
    to_slot_id: String(row.to_slot_id),
    created_at: String(row.created_at),
    status: readAt === null ? 'unread' : 'read',
    read_at: readAt,
  }
}

function toDetail(row: Row): MailboxMessageDetailDto {
  const summary = toSummary(row)
  return {
    message: toMessage(row),
    status: summary.status,
    read_at: summary.read_at,
  }
}
