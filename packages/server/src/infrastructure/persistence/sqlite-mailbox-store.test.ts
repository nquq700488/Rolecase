import { describe, expect, it } from 'vitest'

import { SqliteDatabase } from './sqlite-database.js'
import { SqliteMailboxStore } from './sqlite-mailbox-store.js'

const timestamp = '2026-11-05T10:00:00.000Z'

type Fixture = {
  readonly database: SqliteDatabase
  readonly store: SqliteMailboxStore
}

/** 建立两个 Workspace/三个 Slot 的最小收件场景；所有正文都可被断言。 */
const createFixture = (): Fixture => {
  const database = new SqliteDatabase(':memory:')
  database.prepare('INSERT INTO workspaces(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('workspace-1', 'Workspace 1', timestamp, timestamp)
  database.prepare('INSERT INTO workspaces(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('workspace-2', 'Workspace 2', timestamp, timestamp)
  for (const [sessionId, workspaceId] of [['session-1', 'workspace-1'], ['session-2', 'workspace-2']]) {
    database
      .prepare('INSERT INTO sessions(id, workspace_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, workspaceId, sessionId, 'active', timestamp, timestamp)
    database
      .prepare('INSERT INTO agent_slots(id, session_id, model_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(`slot-${sessionId}`, sessionId, 'model-1', 'idle', timestamp)
    database
      .prepare('INSERT INTO agent_slots(id, session_id, model_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(`slot-${sessionId}-other`, sessionId, 'model-1', 'idle', timestamp)
  }
  database
    .prepare(
      `INSERT INTO runs(
        id, workspace_id, session_id, status, attempt, created_at, updated_at,
        event_sequence, completed_sequence
      ) VALUES (?, ?, ?, 'completed', 1, ?, ?, 3, 3)`,
    )
    .run('run-1', 'workspace-1', 'session-1', timestamp, timestamp)
  database
    .prepare(
      `INSERT INTO runs(
        id, workspace_id, session_id, status, attempt, created_at, updated_at,
        event_sequence, completed_sequence
      ) VALUES (?, ?, ?, 'failed', 1, ?, ?, NULL, NULL)`,
    )
    .run('run-failed', 'workspace-1', 'session-1', timestamp, timestamp)
  return { database, store: new SqliteMailboxStore(database) }
}

const insertHandoff = (
  database: SqliteDatabase,
  input: {
    id: string
    sessionId?: string
    toSlotId?: string
    createdAt?: string
    content?: string
    runId?: string
  },
): void => {
  database
    .prepare(
      `INSERT INTO messages(
        id, session_id, run_id, sender_kind, sender_id, content, created_at, kind, to_slot_id
      ) VALUES (?, ?, ?, 'agent', 'slot-sender', ?, ?, 'handoff', ?)`,
    )
    .run(
      input.id,
      input.sessionId ?? 'session-1',
      input.runId ?? 'run-1',
      input.content ?? `body-${input.id}`,
      input.createdAt ?? timestamp,
      input.toSlotId ?? 'slot-session-1',
    )
}

describe('SqliteMailboxStore', () => {
  it('只返回目标 Slot 的 handoff 摘要且不含正文', async () => {
    const { database, store } = createFixture()
    insertHandoff(database, { id: 'message-1' })
    insertHandoff(database, { id: 'message-2', toSlotId: 'slot-session-1-other' })
    insertHandoff(database, { id: 'message-3', sessionId: 'session-2', toSlotId: 'slot-session-2' })
    database
      .prepare(
        `INSERT INTO messages(id, session_id, run_id, sender_kind, sender_id, content, created_at)
         VALUES (?, ?, ?, 'user', NULL, ?, ?)`,
      )
      .run('plain-message', 'session-1', 'run-1', 'plain body', timestamp)

    const page = await store.listMailboxMessages('session-1', { slot_id: 'slot-session-1', limit: 50 })

    expect(page).not.toBeNull()
    expect(page?.items.map((item) => item.id)).toEqual(['message-1'])
    expect(page?.items[0]).toEqual({
      id: 'message-1',
      session_id: 'session-1',
      sender_id: 'slot-sender',
      to_slot_id: 'slot-session-1',
      created_at: timestamp,
      status: 'unread',
      read_at: null,
    })
    expect(page?.items[0]).not.toHaveProperty('content')
    expect(page?.next_cursor).toBeNull()
  })

  it('Slot 不属于该 Session 时拒绝查询', async () => {
    const { store } = createFixture()

    await expect(store.listMailboxMessages('session-1', { slot_id: 'slot-session-2', limit: 50 })).resolves.toBeNull()
    await expect(store.getMailboxMessage('session-1', 'message-x', 'slot-session-2')).resolves.toBeNull()
  })

  it('按 created_at DESC, id DESC 稳定分页且其余 Slot 的游标被拒绝', async () => {
    const { database, store } = createFixture()
    insertHandoff(database, { id: 'message-a', createdAt: '2026-11-05T09:00:00.000Z' })
    insertHandoff(database, { id: 'message-c', createdAt: '2026-11-05T10:00:00.000Z' })
    insertHandoff(database, { id: 'message-b', createdAt: '2026-11-05T10:00:00.000Z' })
    insertHandoff(database, { id: 'message-other', toSlotId: 'slot-session-1-other' })

    const first = await store.listMailboxMessages('session-1', { slot_id: 'slot-session-1', limit: 2 })
    expect(first?.items.map((item) => item.id)).toEqual(['message-c', 'message-b'])
    expect(first?.next_cursor).toBe('message-b')

    const second = await store.listMailboxMessages('session-1', {
      slot_id: 'slot-session-1', limit: 2, cursor: 'message-b',
    })
    expect(second?.items.map((item) => item.id)).toEqual(['message-a'])
    expect(second?.next_cursor).toBeNull()

    await expect(store.listMailboxMessages('session-1', {
      slot_id: 'slot-session-1', limit: 2, cursor: 'message-other',
    })).resolves.toBeNull()
    await expect(store.listMailboxMessages('session-1', {
      slot_id: 'slot-session-1', limit: 2, cursor: 'missing-message',
    })).resolves.toBeNull()
  })

  it('详情返回正文但不写 read 状态', async () => {
    const { database, store } = createFixture()
    insertHandoff(database, { id: 'message-1', content: 'handoff body' })

    const detail = await store.getMailboxMessage('session-1', 'message-1', 'slot-session-1')

    expect(detail?.message.content).toBe('handoff body')
    expect(detail).toMatchObject({ status: 'unread', read_at: null })
    const markers = database.prepare('SELECT COUNT(*) AS count FROM mailbox_read_markers').get() as { count: number }
    const events = database.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'message.read'").get() as {
      count: number
    }
    expect(markers.count).toBe(0)
    expect(events.count).toBe(0)
  })

  it('跨 Session、错误 Slot 与非 handoff 消息的详情统一不可用', async () => {
    const { database, store } = createFixture()
    insertHandoff(database, { id: 'message-1' })
    database
      .prepare(
        `INSERT INTO messages(id, session_id, run_id, sender_kind, sender_id, content, created_at)
         VALUES (?, ?, ?, 'user', NULL, ?, ?)`,
      )
      .run('plain-message', 'session-1', 'run-1', 'plain body', timestamp)

    await expect(store.getMailboxMessage('session-2', 'message-1', 'slot-session-2')).resolves.toBeNull()
    await expect(store.getMailboxMessage('session-1', 'message-1', 'slot-session-1-other')).resolves.toBeNull()
    await expect(store.getMailboxMessage('session-1', 'plain-message', 'slot-session-1')).resolves.toBeNull()
  })

  it('首次标记已读在同一事务写入 marker 与 metadata-only Event', async () => {
    const { database, store } = createFixture()
    insertHandoff(database, { id: 'message-1', content: 'secret body' })
    const readAt = '2026-11-05T12:00:00.000Z'

    const result = await store.markMailboxMessageRead({
      session_id: 'session-1',
      message_id: 'message-1',
      slot_id: 'slot-session-1',
      read_at: readAt,
      event_id: 'event-read-1',
    })

    expect(result.kind).toBe('marked')
    const markers = database
      .prepare('SELECT message_id, session_id, recipient_slot_id, read_at FROM mailbox_read_markers')
      .all() as Array<Record<string, unknown>>
    expect(markers).toEqual([{
      message_id: 'message-1', session_id: 'session-1', recipient_slot_id: 'slot-session-1', read_at: readAt,
    }])
    const eventRows = database
      .prepare("SELECT * FROM events WHERE event_id = 'event-read-1'")
      .all() as Array<Record<string, unknown>>
    expect(eventRows).toHaveLength(1)
    expect(eventRows[0]?.type).toBe('message.read')
    expect(JSON.parse(String(eventRows[0]?.payload_json))).toEqual({
      message_id: 'message-1', recipient_slot_id: 'slot-session-1', read_at: readAt,
    })
    expect(String(eventRows[0]?.payload_json)).not.toContain('secret body')
    const run = database
      .prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?')
      .get('run-1') as { event_sequence: number; completed_sequence: number }
    expect(run.completed_sequence).toBe(3)
    expect(run.event_sequence).toBe(4)

    const page = await store.listMailboxMessages('session-1', { slot_id: 'slot-session-1', limit: 50 })
    expect(page?.items[0]).toMatchObject({ status: 'read', read_at: readAt })
  })

  it('重复标记返回既有 read_at 且不新增 marker/Event', async () => {
    const { database, store } = createFixture()
    insertHandoff(database, { id: 'message-1' })
    const first = {
      session_id: 'session-1', message_id: 'message-1', slot_id: 'slot-session-1',
      read_at: '2026-11-05T12:00:00.000Z', event_id: 'event-read-1',
    }
    await store.markMailboxMessageRead(first)

    const result = await store.markMailboxMessageRead({
      ...first, read_at: '2026-11-05T13:00:00.000Z', event_id: 'event-read-2',
    })

    expect(result).toEqual({ kind: 'already_read', read_at: first.read_at })
    const markers = database.prepare('SELECT COUNT(*) AS count FROM mailbox_read_markers').get() as { count: number }
    const events = database.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'message.read'").get() as {
      count: number
    }
    expect(markers.count).toBe(1)
    expect(events.count).toBe(1)
  })

  it('来源 Run 无可信完成水位时整笔回滚且不写 marker', async () => {
    const { database, store } = createFixture()
    insertHandoff(database, { id: 'message-1', runId: 'run-failed' })

    await expect(store.markMailboxMessageRead({
      session_id: 'session-1',
      message_id: 'message-1',
      slot_id: 'slot-session-1',
      read_at: '2026-11-05T12:00:00.000Z',
      event_id: 'event-read-1',
    })).rejects.toThrow()

    const markers = database.prepare('SELECT COUNT(*) AS count FROM mailbox_read_markers').get() as { count: number }
    const events = database.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'message.read'").get() as {
      count: number
    }
    expect(markers.count).toBe(0)
    expect(events.count).toBe(0)
  })

  it('越权或不可见目标不能写入 read 状态', async () => {
    const { database, store } = createFixture()
    insertHandoff(database, { id: 'message-1' })

    for (const input of [
      { session_id: 'session-2', slot_id: 'slot-session-2' },
      { session_id: 'session-1', slot_id: 'slot-session-1-other' },
      { session_id: 'session-1', slot_id: 'slot-session-1', message_id: 'missing-message' },
    ]) {
      await expect(store.markMailboxMessageRead({
        message_id: 'message-1', read_at: timestamp, event_id: 'event-x', ...input,
      })).resolves.toEqual({ kind: 'unavailable' })
    }
    const markers = database.prepare('SELECT COUNT(*) AS count FROM mailbox_read_markers').get() as { count: number }
    expect(markers.count).toBe(0)
  })
})
