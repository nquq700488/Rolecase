import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SqliteDatabase } from './sqlite-database.js'

const fixtureDirectories: string[] = []

async function createMigratedV11Fixture(): Promise<SqliteDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'rolecast-task-lineage-v11-'))
  fixtureDirectories.push(directory)
  const filename = join(directory, 'legacy.sqlite')
  const legacy = new Database(filename)
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES (11, '2026-11-06T10:00:00.000Z');
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      retry_of_run_id TEXT,
      status TEXT NOT NULL,
      event_sequence INTEGER,
      completed_sequence INTEGER
    );
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(run_id, sequence)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      kind TEXT,
      handoff_request_id TEXT
    );
    INSERT INTO runs(id, retry_of_run_id, status, event_sequence, completed_sequence) VALUES
      ('run-parent', NULL, 'completed', 10, 8),
      ('run-child', 'run-parent', 'completed', 20, 17),
      ('run-ambiguous', NULL, 'completed', 30, 26),
      ('run-empty', NULL, 'completed', 40, 35);
    INSERT INTO tasks(id, run_id, status) VALUES
      ('task-parent', 'run-parent', 'completed'),
      ('task-child', 'run-child', 'completed'),
      ('task-ambiguous-a', 'run-ambiguous', 'completed'),
      ('task-ambiguous-b', 'run-ambiguous', 'completed');
    INSERT INTO events(event_id, run_id, sequence, type, payload_json) VALUES
      ('event-agent', 'run-child', 1, 'agent.message', '{"text":"synthetic"}'),
      ('event-handoff', 'run-child', 2, 'message.created', '{}'),
      ('event-ambiguous', 'run-ambiguous', 1, 'agent.message', '{"text":"unknown"}');
    INSERT INTO messages(id, run_id, kind, handoff_request_id) VALUES
      ('message-known', 'run-child', 'handoff', 'request-known'),
      ('message-ambiguous', 'run-ambiguous', 'handoff', 'request-ambiguous');
  `)
  legacy.close()
  return new SqliteDatabase(filename)
}

afterEach(async () => {
  await Promise.all(fixtureDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('SQLite Task lineage v12 migration', () => {
  it('只回填可证明的 Task、Event 与历史 handoff 来源并保留完成水位', async () => {
    const database = await createMigratedV11Fixture()
    try {
      const tasks = database.prepare(`
        SELECT id, node_key, attempt, retry_of_task_id FROM tasks ORDER BY id
      `).all()
      const events = database.prepare(`
        SELECT event_id, task_id, node_key, attempt FROM events ORDER BY event_id
      `).all()
      const messages = database.prepare(`
        SELECT id, source_task_id, source_task_omitted FROM messages ORDER BY id
      `).all()
      const runs = database.prepare(`
        SELECT id, event_sequence, completed_sequence FROM runs ORDER BY id
      `).all()
      const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()

      expect(version).toEqual({ version: 12 })
      expect(tasks).toEqual([
        { id: 'task-ambiguous-a', node_key: null, attempt: null, retry_of_task_id: null },
        { id: 'task-ambiguous-b', node_key: null, attempt: null, retry_of_task_id: null },
        { id: 'task-child', node_key: 'legacy', attempt: 1, retry_of_task_id: 'task-parent' },
        { id: 'task-parent', node_key: 'legacy', attempt: 1, retry_of_task_id: null },
      ])
      expect(events).toEqual([
        { event_id: 'event-agent', task_id: 'task-child', node_key: 'legacy', attempt: 1 },
        { event_id: 'event-ambiguous', task_id: null, node_key: null, attempt: null },
        { event_id: 'event-handoff', task_id: null, node_key: null, attempt: null },
      ])
      expect(messages).toEqual([
        { id: 'message-ambiguous', source_task_id: null, source_task_omitted: null },
        { id: 'message-known', source_task_id: 'task-child', source_task_omitted: 1 },
      ])
      expect(runs).toEqual([
        { id: 'run-ambiguous', event_sequence: 30, completed_sequence: 26 },
        { id: 'run-child', event_sequence: 20, completed_sequence: 17 },
        { id: 'run-empty', event_sequence: 40, completed_sequence: 35 },
        { id: 'run-parent', event_sequence: 10, completed_sequence: 8 },
      ])
    } finally {
      database.close()
    }
  })

  it('拒绝部分填写的 Task lineage', async () => {
    const database = await createMigratedV11Fixture()
    try {
      const columns = database.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'node_key', 'attempt', 'retry_of_task_id',
      ]))
      expect(() => database.prepare(`
        UPDATE tasks SET node_key = 'agent', attempt = NULL WHERE id = 'task-ambiguous-a'
      `).run()).toThrow()
      expect(() => database.prepare(`
        UPDATE tasks SET node_key = NULL, attempt = 2 WHERE id = 'task-ambiguous-a'
      `).run()).toThrow()
    } finally {
      database.close()
    }
  })

  it('拒绝未知 Task lineage 携带 retry 父 Task', async () => {
    const database = await createMigratedV11Fixture()
    try {
      const columns = database.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
      expect(columns.map((column) => column.name)).toContain('retry_of_task_id')
      expect(() => database.prepare(`
        UPDATE tasks SET retry_of_task_id = 'task-parent' WHERE id = 'task-ambiguous-a'
      `).run()).toThrow()
    } finally {
      database.close()
    }
  })

  it('拒绝重复的已知逻辑节点 attempt', async () => {
    const database = await createMigratedV11Fixture()
    try {
      const columns = database.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['node_key', 'attempt']))
      database.prepare("UPDATE tasks SET node_key = 'agent', attempt = 1 WHERE id = 'task-ambiguous-a'").run()
      expect(() => database.prepare(
        "UPDATE tasks SET node_key = 'agent', attempt = 1 WHERE id = 'task-ambiguous-b'",
      ).run()).toThrow()
    } finally {
      database.close()
    }
  })

  it('拒绝部分填写的 Event provenance', async () => {
    const database = await createMigratedV11Fixture()
    try {
      const columns = database.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'task_id', 'node_key', 'attempt',
      ]))
      expect(() => database.prepare(`
        UPDATE events SET task_id = 'task-child', node_key = 'agent', attempt = NULL
        WHERE event_id = 'event-ambiguous'
      `).run()).toThrow()
      expect(() => database.prepare(`
        UPDATE events SET task_id = NULL, node_key = 'agent', attempt = 1
        WHERE event_id = 'event-ambiguous'
      `).run()).toThrow()
    } finally {
      database.close()
    }
  })

  it.each([1.5, 'not-an-integer'])('拒绝非整数 Task attempt：%s', async (attempt) => {
    const database = await createMigratedV11Fixture()
    try {
      expect(() => database.prepare(`
        UPDATE tasks SET node_key = 'agent', attempt = ? WHERE id = 'task-ambiguous-a'
      `).run(attempt)).toThrow()
    } finally {
      database.close()
    }
  })

  it.each([1.5, 'not-an-integer'])('拒绝非整数 Event provenance attempt：%s', async (attempt) => {
    const database = await createMigratedV11Fixture()
    try {
      expect(() => database.prepare(`
        UPDATE events SET task_id = 'task-child', node_key = 'agent', attempt = ?
        WHERE event_id = 'event-ambiguous'
      `).run(attempt)).toThrow()
    } finally {
      database.close()
    }
  })

  it('拒绝来源 Task 已知但省略语义为空的 handoff 身份', async () => {
    const database = await createMigratedV11Fixture()
    try {
      const columns = database.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'source_task_id', 'source_task_omitted',
      ]))
      expect(() => database.prepare(`
        UPDATE messages SET source_task_id = 'task-parent', source_task_omitted = NULL
        WHERE id = 'message-ambiguous'
      `).run()).toThrow()
    } finally {
      database.close()
    }
  })

  it('旧版 Run 表缺少 retry_of_run_id 时仍迁移唯一 Task lineage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-task-lineage-no-run-retry-'))
    fixtureDirectories.push(directory)
    const filename = join(directory, 'legacy.sqlite')
    const legacy = new Database(filename)
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (11, '2026-11-06T10:00:00.000Z');
      CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL);
      INSERT INTO runs(id, status) VALUES ('run-legacy', 'completed');
      INSERT INTO tasks(id, run_id, status) VALUES ('task-legacy', 'run-legacy', 'completed');
    `)
    legacy.close()

    const database = new SqliteDatabase(filename)
    try {
      expect(database.prepare(`
        SELECT node_key, attempt, retry_of_task_id FROM tasks WHERE id = 'task-legacy'
      `).get()).toEqual({ node_key: 'legacy', attempt: 1, retry_of_task_id: null })
    } finally {
      database.close()
    }
  })
})
