import type { MessageDto } from '@rolecast/contract'

import type {
  CreateHandoffMessageInput,
  CreateHandoffMessageResult,
  HandoffSourceRecord,
  RunEventPage,
} from '../../application/ports/repository-port.js'
import { appendHandoffMetadataEventSync } from './sqlite-event-sequence.js'
import { toEvent, toMessage, toRun, toTask } from './sqlite-mappers.js'
import type { SqliteDatabase } from './sqlite-database.js'

type Row = Record<string, unknown>

/** handoff 来源读取、两阶段 Event 分页与原子 Message 写入。 */
export class SqliteHandoffStore {
  constructor(private readonly database: SqliteDatabase) {}

  /** 按 Session + 私有幂等键读取既有 handoff Message；不校验来源/目标状态。 */
  async getHandoffMessageByRequest(sessionId: string, requestId: string): Promise<MessageDto | null> {
    return this.getHandoffMessageByRequestSync(sessionId, requestId)
  }

  /** handoff 来源必须已完成、拥有可信水位且恰好一个 Task。 */
  async getHandoffSource(sessionId: string, runId: string): Promise<HandoffSourceRecord | null> {
    return this.database.transaction(() => {
      const runRow = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Row | undefined
      if (runRow === undefined) {
        return null
      }
      const run = toRun(runRow)
      const sequenceRow = this.database
        .prepare('SELECT completed_sequence FROM runs WHERE id = ?')
        .get(runId) as { completed_sequence?: number | null }
      const completedSequence = sequenceRow.completed_sequence
      if (
        run.session_id !== sessionId
        || run.status !== 'completed'
        || typeof completedSequence !== 'number'
        || completedSequence <= 0
      ) {
        return null
      }
      const taskRows = this.database.prepare('SELECT * FROM tasks WHERE run_id = ?').all(runId) as Row[]
      if (taskRows.length !== 1) {
        return null
      }
      const task = toTask(taskRows[0] as Row)
      return { run, task, from_slot_id: task.slot_id, completed_sequence: completedSequence }
    })
  }

  /**
   * 两阶段有界读取：同一读事务内先取 SQLite 字节长度，只有全部通过才取 payload。
   * 超限时 payload 不会进入 JS、不会被 JSON.parse 或映射。
   */
  async readRunEventPage(runId: string, afterSequence: number, limit: number): Promise<RunEventPage> {
    const pageLimit = Math.max(1, Math.min(limit, 8))
    return this.database.transaction(() => {
      const metadata = this.database
        .prepare(
          `SELECT event_id, sequence, length(CAST(payload_json AS BLOB)) AS size
             FROM events WHERE run_id = ? AND sequence > ?
            ORDER BY sequence LIMIT ?`,
        )
        .all(runId, afterSequence, pageLimit) as Array<{ event_id: string; sequence: number; size: number }>
      let totalBytes = 0
      for (const row of metadata) {
        const size = Number(row.size)
        if (size > 512 * 1024 || (totalBytes += size) > 4 * 1024 * 1024) {
          return { kind: 'too_large' as const }
        }
      }
      if (metadata.length === 0) {
        return { kind: 'ok' as const, events: [], nextSequence: afterSequence }
      }
      for (let index = 0; index < metadata.length; index += 1) {
        if (Number(metadata[index]?.sequence) !== afterSequence + index + 1) {
          return { kind: 'inconsistent' as const }
        }
      }
      const first = afterSequence + 1
      const last = Number(metadata[metadata.length - 1]?.sequence)
      const rows = this.database
        .prepare('SELECT * FROM events WHERE run_id = ? AND sequence BETWEEN ? AND ? ORDER BY sequence')
        .all(runId, first, last) as Row[]
      if (rows.length !== metadata.length) {
        return { kind: 'inconsistent' as const }
      }
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] as Row
        const meta = metadata[index]
        if (String(row.event_id) !== String(meta?.event_id) || Number(row.sequence) !== Number(meta?.sequence)) {
          return { kind: 'inconsistent' as const }
        }
      }
      return { kind: 'ok' as const, events: rows.map(toEvent), nextSequence: last }
    })
  }

  /** handoff Message + 私有幂等键 + post-completion metadata Event 原子写入。 */
  async createHandoffMessage(input: CreateHandoffMessageInput): Promise<CreateHandoffMessageResult> {
    try {
      return this.database.transaction(() => {
        const existing = this.getHandoffMessageByRequestSync(input.message.session_id, input.requestId)
        if (existing !== null) {
          return classifyHandoffReplay(existing, input)
        }
        const source = this.getHandoffSourceSync(input.message.session_id, input.runId)
        if (source === null || source.from_slot_id !== input.fromSlotId) {
          return { kind: 'source_unavailable' as const }
        }
        const target = this.database
          .prepare('SELECT 1 AS found FROM agent_slots WHERE id = ? AND session_id = ? AND deleted_at IS NULL')
          .get(input.toSlotId, input.message.session_id)
        if (target === undefined || input.toSlotId === input.fromSlotId) {
          return { kind: 'invalid_target' as const }
        }
        this.database
          .prepare(
            `INSERT INTO messages(
              id, session_id, run_id, sender_kind, sender_id, content, created_at,
              kind, to_slot_id, handoff_request_id
            ) VALUES (@id, @session_id, @run_id, @sender_kind, @sender_id, @content, @created_at,
              'handoff', @to_slot_id, @handoff_request_id)`,
          )
          .run({
            ...input.message,
            run_id: input.message.run_id ?? null,
            sender_id: input.message.sender_id ?? null,
            to_slot_id: input.toSlotId,
            handoff_request_id: input.requestId,
          })
        const event = appendHandoffMetadataEventSync(this.database, input.event)
        return { kind: 'created' as const, message: input.message, event }
      })
    } catch (error: unknown) {
      // 唯一索引兜底并发：事务外按 key 复核参数，相同则返回原 Message。
      const existing = this.getHandoffMessageByRequestSync(input.message.session_id, input.requestId)
      if (existing !== null) {
        return classifyHandoffReplay(existing, input)
      }
      throw error
    }
  }

  private getHandoffMessageByRequestSync(sessionId: string, requestId: string): MessageDto | null {
    const row = this.database
      .prepare('SELECT * FROM messages WHERE session_id = ? AND handoff_request_id = ?')
      .get(sessionId, requestId) as Row | undefined
    return row === undefined ? null : toMessage(row)
  }

  private getHandoffSourceSync(sessionId: string, runId: string): HandoffSourceRecord | null {
    const runRow = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Row | undefined
    if (runRow === undefined) {
      return null
    }
    const run = toRun(runRow)
    const sequenceRow = this.database
      .prepare('SELECT completed_sequence FROM runs WHERE id = ?')
      .get(runId) as { completed_sequence?: number | null }
    const completedSequence = sequenceRow.completed_sequence
    if (
      run.session_id !== sessionId
      || run.status !== 'completed'
      || typeof completedSequence !== 'number'
      || completedSequence <= 0
    ) {
      return null
    }
    const taskRows = this.database.prepare('SELECT * FROM tasks WHERE run_id = ?').all(runId) as Row[]
    if (taskRows.length !== 1) {
      return null
    }
    const task = toTask(taskRows[0] as Row)
    return { run, task, from_slot_id: task.slot_id, completed_sequence: completedSequence }
  }
}

/** 幂等重放：同 Session/key 且来源 Run/目标 Slot 一致才返回原 Message。 */
function classifyHandoffReplay(
  message: MessageDto,
  input: CreateHandoffMessageInput,
): CreateHandoffMessageResult {
  if (message.kind !== 'handoff' || message.run_id !== input.runId || message.to_slot_id !== input.toSlotId) {
    return { kind: 'conflict' }
  }
  return { kind: 'replayed', message }
}
