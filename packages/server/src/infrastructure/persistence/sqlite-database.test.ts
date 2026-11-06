import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SqliteDatabase } from './sqlite-database.js'

describe('SQLite migrations', () => {
  it('将版本 1 数据库升级到当前 schema 版本', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-migration-'))
    const filename = join(directory, 'rolecast.sqlite')
    const legacy = new Database(filename)
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-10-14T10:00:00.000Z');
      CREATE TABLE permission_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        description TEXT NOT NULL,
        adapter_options_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        soft_timeout_at TEXT NOT NULL,
        overdue_at TEXT,
        expires_at TEXT,
        expired_at TEXT,
        answered_at TEXT,
        selected_option_id TEXT,
        expiration_reason TEXT,
        decision_id TEXT,
        lease_until TEXT
      );
      CREATE TABLE provider_connections (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        provider_definition_id TEXT,
        provider_kind TEXT NOT NULL,
        connection_kind TEXT NOT NULL,
        base_url TEXT,
        credential_ref TEXT,
        environment_mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    legacy.close()

    const database = new SqliteDatabase(filename)
    const columns = database.prepare('PRAGMA table_info(permission_requests)').all() as Array<{ name: string }>
    const providerColumns = database.prepare('PRAGMA table_info(provider_connections)').all() as Array<{ name: string }>
    const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
    expect(columns.some((column) => column.name === 'adapter_request_id')).toBe(true)
    expect(columns.some((column) => column.name === 'adapter_request_id_encoded')).toBe(true)
    const hasRuns = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
      .get() !== undefined
    if (hasRuns) {
      const runColumns = database.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>
      expect(runColumns.some((column) => column.name === 'state_revision')).toBe(true)
    }
    expect(providerColumns.some((column) => column.name === 'codex_config_json')).toBe(true)
    expect(providerColumns.some((column) => column.name === 'config_revision')).toBe(true)
    expect(version.version).toBe(12)
    database.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('迁移把历史 adapter_request_id 裸文本按 string 身份写入编码列', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-migration-legacy-id-'))
    const filename = join(directory, 'rolecast.sqlite')
    const legacy = new Database(filename)
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (3, '2026-10-14T10:00:00.000Z');
      CREATE TABLE permission_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        description TEXT NOT NULL,
        adapter_options_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        soft_timeout_at TEXT NOT NULL,
        overdue_at TEXT,
        expires_at TEXT,
        expired_at TEXT,
        answered_at TEXT,
        selected_option_id TEXT,
        adapter_request_id TEXT,
        expiration_reason TEXT,
        decision_id TEXT,
        lease_until TEXT
      );
      INSERT INTO permission_requests(
        id, run_id, task_id, slot_id, capability, description, adapter_options_json,
        status, requested_at, soft_timeout_at, adapter_request_id
      ) VALUES ('permission-legacy', 'run-001', 'task-001', 'slot-001', 'execute', '执行命令', '[]',
        'pending', '2026-10-14T10:00:00.000Z', '2026-10-14T10:05:00.000Z', '900');
    `)
    legacy.close()

    const database = new SqliteDatabase(filename)
    const row = database
      .prepare("SELECT adapter_request_id, adapter_request_id_encoded FROM permission_requests WHERE id = 'permission-legacy'")
      .get() as { adapter_request_id: string; adapter_request_id_encoded: string }
    // 旧值只有文本，无法证明原本是 number，因此固定按 string 身份迁移（与旧版本用法一致）。
    expect(row.adapter_request_id).toBe('900')
    expect(row.adapter_request_id_encoded).toBe('s:900')
    database.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('已是 v5 的数据库升级到当前版本并补齐 Slot 快照与 context source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-migration-v5-to-current-'))
    const filename = join(directory, 'rolecast.sqlite')
    const legacy = new Database(filename)
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (5, '2026-10-14T10:00:00.000Z');
      CREATE TABLE agent_slots (id TEXT PRIMARY KEY);
      CREATE TABLE command_receipts (
        workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, command TEXT NOT NULL,
        target_id TEXT NOT NULL, status TEXT NOT NULL, dispatch_state TEXT NOT NULL,
        run_id TEXT, task_id TEXT, message_id TEXT, error_code TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, request_id, command)
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
        run_id TEXT NOT NULL, slot_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
        input_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
    legacy.close()

    const database = new SqliteDatabase(filename)
    const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
    expect(version.version).toBe(12)
    const receiptColumns = database.prepare('PRAGMA table_info(command_receipts)').all() as Array<{ name: string }>
    expect(receiptColumns.some((column) => column.name === 'target_slot_id')).toBe(true)
    for (const table of ['agent_slot_role_snapshots', 'context_sources']) {
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
        .toBeDefined()
    }
    database.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('已是 v6 的数据库升级到 v7 并保留 Slot 历史行', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-migration-v6-to-v7-'))
    const filename = join(directory, 'rolecast.sqlite')
    const legacy = new Database(filename)
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (6, '2026-10-14T10:00:00.000Z');
      CREATE TABLE agent_slots (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL);
      INSERT INTO agent_slots(id, session_id, status) VALUES ('slot-001', 'session-001', 'idle');
    `)
    legacy.close()

    const database = new SqliteDatabase(filename)
    const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
    const columns = database.prepare('PRAGMA table_info(agent_slots)').all() as Array<{ name: string }>
    const slot = database.prepare("SELECT id, deleted_at FROM agent_slots WHERE id = 'slot-001'").get() as
      { id: string; deleted_at: string | null }
    expect(version.version).toBe(12)
    expect(columns.some((column) => column.name === 'deleted_at')).toBe(true)
    expect(slot).toEqual({ id: 'slot-001', deleted_at: null })
    database.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('v5 迁移建立 attachment/receipt/claim 并只回填唯一输入消息', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-migration-v5-'))
    const filename = join(directory, 'rolecast.sqlite')
    const legacy = new Database(filename)
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (4, '2026-10-14T10:00:00.000Z');
      CREATE TABLE agent_slots (id TEXT PRIMARY KEY);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
        status TEXT NOT NULL, attempt INTEGER NOT NULL, started_at TEXT, ended_at TEXT,
        error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
        run_id TEXT NOT NULL, slot_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, sender_kind TEXT NOT NULL,
        sender_id TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO agent_slots(id) VALUES ('slot-001');
      INSERT INTO runs(id, workspace_id, session_id, status, attempt, created_at, updated_at)
        VALUES ('run-unique', 'w', 's', 'completed', 1, 't', 't');
      INSERT INTO runs(id, workspace_id, session_id, status, attempt, created_at, updated_at)
        VALUES ('run-ambiguous', 'w', 's', 'completed', 1, 't', 't');
      INSERT INTO tasks(id, workspace_id, session_id, run_id, slot_id, title, status, created_at, updated_at)
        VALUES ('task-1', 'w', 's', 'run-unique', 'slot-001', 't', 'completed', 't', 't');
      INSERT INTO tasks(id, workspace_id, session_id, run_id, slot_id, title, status, created_at, updated_at)
        VALUES ('task-2', 'w', 's', 'run-ambiguous', 'slot-001', 't', 'completed', 't', 't');
      INSERT INTO messages(id, session_id, run_id, sender_kind, content, created_at)
        VALUES ('msg-1', 's', 'run-unique', 'user', 'hello', 't');
      INSERT INTO messages(id, session_id, run_id, sender_kind, content, created_at)
        VALUES ('msg-2', 's', 'run-ambiguous', 'user', 'a', 't');
      INSERT INTO messages(id, session_id, run_id, sender_kind, content, created_at)
        VALUES ('msg-3', 's', 'run-ambiguous', 'user', 'b', 't');
    `)
    legacy.close()

    const database = new SqliteDatabase(filename)
    const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
    expect(version.version).toBe(12)

    for (const table of [
      'runtime_attachments', 'command_receipts', 'slot_activity_claims',
      'agent_slot_role_snapshots', 'context_sources',
    ]) {
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
        .toBeDefined()
    }
    const receiptColumns = database.prepare('PRAGMA table_info(command_receipts)').all() as Array<{ name: string }>
    expect(receiptColumns.some((column) => column.name === 'target_slot_id')).toBe(true)
    const run = database.prepare("SELECT retry_chain_id, state_revision FROM runs WHERE id = 'run-unique'")
      .get() as { retry_chain_id: string; state_revision: number }
    expect(run).toEqual({ retry_chain_id: 'run-unique', state_revision: 1 })

    // 唯一输入消息可回填；两条用户消息的保持 NULL，不猜。
    const uniqueTask = database.prepare("SELECT input_message_id FROM tasks WHERE id = 'task-1'").get() as { input_message_id: string }
    const ambiguousTask = database.prepare("SELECT input_message_id FROM tasks WHERE id = 'task-2'").get() as { input_message_id: string | null }
    expect(uniqueTask.input_message_id).toBe('msg-1')
    expect(ambiguousTask.input_message_id).toBeNull()
    const contextSource = database.prepare("SELECT source_id, source_version FROM context_sources WHERE task_id = 'task-1'").get() as
      { source_id: string; source_version: number }
    expect(contextSource).toEqual({ source_id: 'msg-1', source_version: 1 })
    expect(database.prepare("SELECT 1 FROM context_sources WHERE task_id = 'task-2'").get()).toBeUndefined()
    database.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('v8 只新增 nullable handoff 字段与 Run 游标，不回填旧记录', () => {
    const database = new SqliteDatabase(':memory:')
    const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
    expect(version.version).toBe(12)

    const messageColumns = database.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    for (const column of ['kind', 'to_slot_id', 'handoff_request_id']) {
      expect(messageColumns.some((entry) => entry.name === column)).toBe(true)
    }
    const runColumns = database.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>
    for (const column of ['event_sequence', 'completed_sequence']) {
      expect(runColumns.some((entry) => entry.name === column)).toBe(true)
    }
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'messages_handoff_request_idx'",
    ).get()).toBeDefined()

    // 旧行不要求新列：以旧列插入后保持 NULL。
    database.prepare("INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w', 'w', 't', 't')").run()
    database.prepare(
      "INSERT INTO sessions(id, workspace_id, name, status, created_at, updated_at) VALUES ('s', 'w', 's', 'active', 't', 't')",
    ).run()
    database.prepare(
      "INSERT INTO runs(id, workspace_id, session_id, status, attempt, created_at, updated_at) VALUES ('run-old', 'w', 's', 'completed', 1, 't', 't')",
    ).run()
    database.prepare(
      "INSERT INTO messages(id, session_id, run_id, sender_kind, content, created_at) VALUES ('msg-old', 's', 'run-old', 'agent', 'hello', 't')",
    ).run()
    expect(database.prepare(
      "SELECT kind, to_slot_id, handoff_request_id FROM messages WHERE id = 'msg-old'",
    ).get()).toEqual({ kind: null, to_slot_id: null, handoff_request_id: null })
    expect(database.prepare(
      "SELECT event_sequence, completed_sequence FROM runs WHERE id = 'run-old'",
    ).get()).toEqual({ event_sequence: null, completed_sequence: null })

    // 同 Session 同一私有 handoff key 只能有一条 Message。
    database.prepare(
      "INSERT INTO messages(id, session_id, run_id, sender_kind, content, created_at, kind, to_slot_id, handoff_request_id) VALUES ('msg-h1', 's', 'run-old', 'agent', 'x', 't', 'handoff', 'slot-2', 'key-1')",
    ).run()
    expect(() => database.prepare(
      "INSERT INTO messages(id, session_id, run_id, sender_kind, content, created_at, kind, to_slot_id, handoff_request_id) VALUES ('msg-h2', 's', 'run-old', 'agent', 'y', 't', 'handoff', 'slot-2', 'key-1')",
    ).run()).toThrow()
    database.close()
  })

  it('连接打开后迁移失败时关闭连接并保留原始错误', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-init-close-'))
    const filename = join(directory, 'broken.sqlite')
    const fixture = new Database(filename)
    // 连接可正常打开，但迁移 001 的 INSERT 会因缺少 applied_at 列失败。
    fixture.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)')
    fixture.close()

    const originalClose = Database.prototype.close
    let closeCalls = 0
    Database.prototype.close = function (this: Database.Database) {
      closeCalls += 1
      return originalClose.call(this)
    }
    try {
      let caught: unknown
      try {
        new SqliteDatabase(filename)
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain('SQLite 初始化失败')
      const cause = (caught as Error & { cause?: unknown }).cause
      expect(cause).toBeInstanceOf(Error)
      expect((cause as Error).message).toContain('applied_at')
      expect(closeCalls).toBe(1)
    } finally {
      Database.prototype.close = originalClose
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('初始化失败且关闭连接失败时同时保留两个错误', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-init-close-'))
    const filename = join(directory, 'broken.sqlite')
    const fixture = new Database(filename)
    fixture.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)')
    fixture.close()

    const originalClose = Database.prototype.close
    const closeError = new Error('injected close failure')
    let openedConnection: Database.Database | null = null
    Database.prototype.close = function (this: Database.Database) {
      openedConnection = this
      throw closeError
    }
    try {
      let caught: unknown
      try {
        new SqliteDatabase(filename)
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AggregateError)
      const aggregate = caught as AggregateError
      expect(aggregate.errors).toContain(closeError)
      expect(aggregate.errors.some(
        (entry) => entry instanceof Error && entry.message.includes('applied_at'),
      )).toBe(true)
      expect((aggregate as AggregateError & { cause?: unknown }).cause)
        .toMatchObject({ message: expect.stringContaining('applied_at') })
      expect(aggregate.message).toContain('SQLite 初始化失败')
    } finally {
      Database.prototype.close = originalClose
      if (openedConnection !== null) {
        originalClose.call(openedConnection)
      }
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('非 Error 初始化抛值保留为 cause 并安全格式化', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-init-raw-'))
    const filename = join(directory, 'raw-init.sqlite')
    const originalPragma = Database.prototype.pragma
    const originalClose = Database.prototype.close
    const rawInit = { reason: 'raw-init' }
    let closeCalls = 0
    Database.prototype.pragma = function () {
      throw rawInit
    }
    Database.prototype.close = function (this: Database.Database) {
      closeCalls += 1
      return originalClose.call(this)
    }
    try {
      let caught: unknown
      try {
        new SqliteDatabase(filename)
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error & { cause?: unknown }).cause).toBe(rawInit)
      expect((caught as Error).message).toContain('SQLite 初始化失败')
      expect((caught as Error).message).toContain('raw-init')
      expect(closeCalls).toBe(1)
    } finally {
      Database.prototype.pragma = originalPragma
      Database.prototype.close = originalClose
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('初始化抛值的格式化自身失败时仍保留原始值', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-init-raw-'))
    const filename = join(directory, 'raw-bigint.sqlite')
    const originalPragma = Database.prototype.pragma
    const originalClose = Database.prototype.close
    const rawInit = 10n
    Database.prototype.pragma = function () {
      throw rawInit
    }
    Database.prototype.close = function (this: Database.Database) {
      return originalClose.call(this)
    }
    try {
      let caught: unknown
      try {
        new SqliteDatabase(filename)
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error & { cause?: unknown }).cause).toBe(rawInit)
      expect((caught as Error).message).toContain('SQLite 初始化失败')
      expect((caught as Error).message).toContain('10')
    } finally {
      Database.prototype.pragma = originalPragma
      Database.prototype.close = originalClose
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('Error.message getter 抛错时仍保留原始 init throw 并关闭连接', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-init-getter-'))
    const filename = join(directory, 'getter-init.sqlite')
    const originalPragma = Database.prototype.pragma
    const originalClose = Database.prototype.close
    const rawInit = new Error('placeholder')
    Object.defineProperty(rawInit, 'message', {
      get() {
        throw new Error('message getter exploded')
      },
    })
    let closeCalls = 0
    Database.prototype.pragma = function () {
      throw rawInit
    }
    Database.prototype.close = function (this: Database.Database) {
      closeCalls += 1
      return originalClose.call(this)
    }
    try {
      let caught: unknown
      try {
        new SqliteDatabase(filename)
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error & { cause?: unknown }).cause).toBe(rawInit)
      expect((caught as Error).message).toContain('SQLite 初始化失败')
      expect((caught as Error).message).toContain('未知错误')
      expect((caught as Error).message).not.toContain('getter exploded')
      expect(closeCalls).toBe(1)
    } finally {
      Database.prototype.pragma = originalPragma
      Database.prototype.close = originalClose
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('init/close 的 Error.message getter 都抛错时仍保留原始值与 cause', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-init-getter-'))
    const filename = join(directory, 'getter-close.sqlite')
    const originalPragma = Database.prototype.pragma
    const originalClose = Database.prototype.close
    const rawInit = new Error('placeholder-init')
    const rawClose = new Error('placeholder-close')
    for (const value of [rawInit, rawClose]) {
      Object.defineProperty(value, 'message', {
        get() {
          throw new Error('message getter exploded')
        },
      })
    }
    let openedConnection: Database.Database | null = null
    Database.prototype.pragma = function () {
      throw rawInit
    }
    Database.prototype.close = function (this: Database.Database) {
      openedConnection = this
      throw rawClose
    }
    try {
      let caught: unknown
      try {
        new SqliteDatabase(filename)
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AggregateError)
      const aggregate = caught as AggregateError
      expect(aggregate.errors[0]).toBe(rawInit)
      expect(aggregate.errors[1]).toBe(rawClose)
      expect((aggregate as AggregateError & { cause?: unknown }).cause).toBe(rawInit)
      expect(aggregate.message).toContain('SQLite 初始化失败')
      expect(aggregate.message).toContain('未知错误')
      expect(aggregate.message).not.toContain('getter exploded')
    } finally {
      Database.prototype.pragma = originalPragma
      Database.prototype.close = originalClose
      if (openedConnection !== null) {
        originalClose.call(openedConnection)
      }
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('非 Error 初始化与关闭抛值同时保留在 AggregateError', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-init-raw-'))
    const filename = join(directory, 'raw-close.sqlite')
    const originalPragma = Database.prototype.pragma
    const originalClose = Database.prototype.close
    const rawInit = { reason: 'raw-init' }
    const rawClose = { reason: 'raw-close' }
    let openedConnection: Database.Database | null = null
    Database.prototype.pragma = function () {
      throw rawInit
    }
    Database.prototype.close = function (this: Database.Database) {
      openedConnection = this
      throw rawClose
    }
    try {
      let caught: unknown
      try {
        new SqliteDatabase(filename)
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AggregateError)
      const aggregate = caught as AggregateError
      expect(aggregate.errors[0]).toBe(rawInit)
      expect(aggregate.errors[1]).toBe(rawClose)
      expect((aggregate as AggregateError & { cause?: unknown }).cause).toBe(rawInit)
      expect(aggregate.message).toContain('SQLite 初始化失败')
      expect(aggregate.message).toContain('raw-init')
      expect(aggregate.message).toContain('raw-close')
    } finally {
      Database.prototype.pragma = originalPragma
      Database.prototype.close = originalClose
      if (openedConnection !== null) {
        originalClose.call(openedConnection)
      }
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('v9 迁移为历史 Workspace 保留 NULL 根路径', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-workspace-root-migration-'))
    const filename = join(directory, 'legacy.sqlite')
    const legacy = new Database(filename)
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (8, '2026-11-04T10:00:00.000Z');
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO workspaces(id, name, created_at, updated_at)
        VALUES ('old-1', '旧工作区 1', 't', 't'), ('old-2', '旧工作区 2', 't', 't');
    `)
    legacy.close()

    const database = new SqliteDatabase(filename)
    try {
      const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
      const workspaces = database.prepare('SELECT id, root_path FROM workspaces ORDER BY id').all()
      expect(version.version).toBe(12)
      expect(workspaces).toEqual([
        { id: 'old-1', root_path: null },
        { id: 'old-2', root_path: null },
      ])
    } finally {
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('v9 升级到当前版本并保留已配置的 Workspace 根路径', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-artifact-migration-'))
    const filename = join(directory, 'legacy-v9.sqlite')
    const legacy = new Database(filename)
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (9, '2026-11-04T10:00:00.000Z');
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, root_path TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, event_sequence INTEGER, completed_sequence INTEGER);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL, slot_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE events (event_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL, UNIQUE(run_id, sequence));
      INSERT INTO workspaces(id, name, created_at, updated_at, root_path) VALUES ('workspace-1', 'w', 't', 't', '/workspace/root');
    `)
    legacy.close()

    const database = new SqliteDatabase(filename)
    try {
      const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
      const rootPath = database.prepare('SELECT root_path FROM workspaces WHERE id = ?').get('workspace-1') as { root_path: string }
      const artifactTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'").get()
      expect(version.version).toBe(12)
      expect(rootPath.root_path).toBe('/workspace/root')
      expect(artifactTable).toBeDefined()
    } finally {
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('v10 升级到当前版本时为历史 handoff 保留 unread 且不写 marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-mailbox-migration-'))
    const filename = join(directory, 'legacy-v10.sqlite')
    const legacy = new Database(filename)
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (10, '2026-11-05T10:00:00.000Z');
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, root_path TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE agent_slots (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role_binding_id TEXT, model_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE runs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, event_sequence INTEGER, completed_sequence INTEGER);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, sender_kind TEXT NOT NULL, sender_id TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT, to_slot_id TEXT, handoff_request_id TEXT);
      CREATE TABLE events (event_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL, UNIQUE(run_id, sequence));
      INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('workspace-1', 'w', 't', 't');
      INSERT INTO sessions(id, workspace_id, name, status, created_at, updated_at) VALUES ('session-1', 'workspace-1', 's', 'active', 't', 't');
      INSERT INTO agent_slots(id, session_id, model_id, status, created_at) VALUES ('slot-1', 'session-1', 'model-1', 'idle', 't');
      INSERT INTO runs(id, workspace_id, session_id, status, attempt, created_at, updated_at, event_sequence, completed_sequence) VALUES ('run-1', 'workspace-1', 'session-1', 'completed', 1, 't', 't', 1, 1);
      INSERT INTO messages(id, session_id, run_id, sender_kind, sender_id, content, created_at, kind, to_slot_id) VALUES ('message-1', 'session-1', 'run-1', 'agent', 'slot-sender', 'legacy body', '2026-11-05T09:00:00.000Z', 'handoff', 'slot-1');
    `)
    legacy.close()

    const database = new SqliteDatabase(filename)
    try {
      const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
      const markers = database.prepare('SELECT COUNT(*) AS count FROM mailbox_read_markers').get() as { count: number }
      const message = database.prepare('SELECT content FROM messages WHERE id = ?').get('message-1') as { content: string }
      expect(version.version).toBe(12)
      expect(markers.count).toBe(0)
      expect(message.content).toBe('legacy body')
    } finally {
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('v9 允许多个未配置 Workspace 但拒绝重复 canonical 根路径', () => {
    const database = new SqliteDatabase(':memory:')
    try {
      const insert = database.prepare(
        'INSERT INTO workspaces(id, name, created_at, updated_at, root_path) VALUES (?, ?, ?, ?, ?)',
      )
      expect(() => {
        insert.run('null-1', '未配置 1', 't', 't', null)
        insert.run('null-2', '未配置 2', 't', 't', null)
        insert.run('root-1', '根目录 1', 't', 't', '/canonical/root')
        insert.run('root-2', '根目录 2', 't', 't', '/canonical/root')
      }).toThrow()
    } finally {
      database.close()
    }
  })
})
