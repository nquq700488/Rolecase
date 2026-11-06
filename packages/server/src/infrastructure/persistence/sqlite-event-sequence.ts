import type { EventEnvelope } from '@rolecast/contract'

import type { SqliteDatabase } from './sqlite-database.js'

/**
 * Run-scoped Event 的唯一 sequence 分配规则。
 *
 * 调用方必须已经处于 SQLite 写事务中：游标更新、Event 插入与业务状态
 * 不得拆事务。legacy Run（`event_sequence IS NULL`）沿用 MAX+1 兼容续写，
 * 但绝不初始化或推进可信游标。
 */

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export const isTerminallyClosedStatus = (status: string): boolean => TERMINAL_RUN_STATUSES.has(status)

export interface RunSequenceRow {
  readonly status: string
  readonly event_sequence: number | null
  readonly completed_sequence: number | null
}

export function readRunSequenceRow(database: SqliteDatabase, runId: string): RunSequenceRow | null {
  const row = database
    .prepare('SELECT status, event_sequence, completed_sequence FROM runs WHERE id = ?')
    .get(runId) as { status?: string; event_sequence?: number | null; completed_sequence?: number | null } | undefined
  if (row === undefined) {
    return null
  }
  return {
    status: String(row.status),
    event_sequence: typeof row.event_sequence === 'number' ? row.event_sequence : null,
    completed_sequence: typeof row.completed_sequence === 'number' ? row.completed_sequence : null,
  }
}

/**
 * 在调用方事务内分配 per-Run sequence 并插入 Event。
 *
 * @param allowTerminal 仅供 Run closure / handoff metadata writer 在事务内使用。
 */
export function appendRunScopedEventSync(
  database: SqliteDatabase,
  event: Omit<EventEnvelope, 'sequence'>,
  options: { allowTerminal?: boolean } = {},
): EventEnvelope {
  const run = readRunSequenceRow(database, event.run_id)
  if (run !== null && isTerminallyClosedStatus(run.status) && options.allowTerminal !== true) {
    throw new Error('run is terminally closed')
  }

  let sequence: number
  if (run === null || run.event_sequence === null) {
    // 未登记 Run 或 legacy Run：只能沿用 MAX+1，绝不伪造可信游标。
    const row = database
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE run_id = ?')
      .get(event.run_id) as { sequence: number }
    sequence = Number(row.sequence) + 1
  } else {
    sequence = run.event_sequence + 1
    database.prepare('UPDATE runs SET event_sequence = ? WHERE id = ?').run(sequence, event.run_id)
  }

  const stored: EventEnvelope = { ...event, sequence }
  database
    .prepare(
      `INSERT INTO events(
        event_id, schema_version, workspace_id, session_id, run_id, sequence,
        type, source, occurred_at, payload_json
      ) VALUES (@event_id, @schema_version, @workspace_id, @session_id, @run_id, @sequence,
        @type, @source, @occurred_at, @payload_json)`,
    )
    .run({ ...stored, payload_json: JSON.stringify(stored.payload) })
  return stored
}

/**
 * handoff 专用的 completed-Run metadata Event writer。
 *
 * 只接受 `message.created`，是 completed 来源 Run 唯一的 post-completion
 * Event 例外；`completed_sequence` 保持不变。
 */
export function appendHandoffMetadataEventSync(
  database: SqliteDatabase,
  event: Omit<EventEnvelope, 'sequence'>,
): EventEnvelope {
  if (event.type !== 'message.created') {
    throw new Error('handoff metadata event must be message.created')
  }
  const run = readRunSequenceRow(database, event.run_id)
  if (run === null) {
    throw new Error('handoff source run not found')
  }
  if (run.status !== 'completed' || run.event_sequence === null || run.completed_sequence === null) {
    throw new Error('handoff source run has no trusted sequence')
  }
  return appendRunScopedEventSync(database, event, { allowTerminal: true })
}

/** Artifact 专用的 completed-Run metadata Event writer；不改变完成水位。 */
export function appendArtifactMetadataEventSync(
  database: SqliteDatabase,
  event: Omit<EventEnvelope, 'sequence'>,
): EventEnvelope {
  if (event.type !== 'artifact.created') {
    throw new Error('artifact metadata event must be artifact.created')
  }
  const run = readRunSequenceRow(database, event.run_id)
  if (
    run === null
    || run.status !== 'completed'
    || !Number.isSafeInteger(run.event_sequence)
    || !Number.isSafeInteger(run.completed_sequence)
    || (run.event_sequence ?? -1) < (run.completed_sequence ?? 0)
    || (run.completed_sequence ?? 0) <= 0
  ) {
    throw new Error('artifact source run has no trusted sequence')
  }
  return appendRunScopedEventSync(database, event, { allowTerminal: true })
}

/** Mailbox 专用的 completed-Run metadata Event writer；不改变完成水位。 */
export function appendMailboxReadMetadataEventSync(
  database: SqliteDatabase,
  event: Omit<EventEnvelope, 'sequence'>,
): EventEnvelope {
  if (event.type !== 'message.read') {
    throw new Error('mailbox metadata event must be message.read')
  }
  const run = readRunSequenceRow(database, event.run_id)
  if (
    run === null
    || run.status !== 'completed'
    || !Number.isSafeInteger(run.event_sequence)
    || !Number.isSafeInteger(run.completed_sequence)
    || (run.event_sequence ?? -1) < (run.completed_sequence ?? 0)
    || (run.completed_sequence ?? 0) <= 0
  ) {
    throw new Error('mailbox source run has no trusted sequence')
  }
  return appendRunScopedEventSync(database, event, { allowTerminal: true })
}
