import Database from 'better-sqlite3'

import { encodeJsonRpcRequestId } from './json-rpc-request-id-codec.js'

const CURRENT_SCHEMA_VERSION = 12

/**
 * 安全格式化任意 throw 值用于错误 message。
 *
 * 只影响诊断文本；调用方仍需通过 cause/AggregateError.errors 观察原始值，
 * 因此这里绝不包装或替换原始 throw。JSON.stringify 或 String 自身抛错时
 * 回退到稳定占位符，不能覆盖原始错误。
 */
function formatThrownValue(value: unknown): string {
  try {
    if (value instanceof Error) {
      // message 可能是抛错的 getter 或恶意 Proxy；读取失败只回退文本。
      try {
        const message = value.message
        return typeof message === 'string' ? message : String(message)
      } catch {
        return '未知错误'
      }
    }
    if (typeof value === 'string') {
      return value
    }
    try {
      const serialized = JSON.stringify(value)
      if (typeof serialized === 'string') {
        return serialized
      }
    } catch {
      // BigInt、循环引用或抛错的 toJSON：继续使用安全回退。
    }
    try {
      return String(value)
    } catch {
      return '未知错误'
    }
  } catch {
    // instanceof / Symbol.hasInstance / getPrototypeOf 自身抛错也不能覆盖原始 throw。
    return '未知错误'
  }
}

/**
 * @name SqliteDatabase
 * @description 管理 Rolecast SQLite 连接、迁移和本地事务边界
 */
export class SqliteDatabase {
  private readonly connection: Database.Database

  constructor(filename: string) {
    let connection: Database.Database | null = null
    try {
      connection = new Database(filename)
      connection.pragma('foreign_keys = ON')
      connection.pragma('journal_mode = WAL')
      this.connection = connection
      this.runMigrations()
    } catch (initThrown: unknown) {
      let closeThrown: unknown
      let closeFailed = false
      if (connection !== null) {
        try {
          connection.close()
        } catch (caught: unknown) {
          closeFailed = true
          closeThrown = caught
        }
      }
      if (closeFailed) {
        throw new AggregateError(
          [initThrown, closeThrown],
          `SQLite 初始化失败且连接关闭失败: ${formatThrownValue(initThrown)}; close: ${formatThrownValue(closeThrown)}`,
          { cause: initThrown },
        )
      }
      // 保留原始 init throw（含非 Error 值）作为 cause，便于诊断 PRAGMA/migration 失败。
      throw new Error(`SQLite 初始化失败: ${formatThrownValue(initThrown)}`, { cause: initThrown })
    }
  }

  /** @description 执行同步事务，供同步数据库操作使用 */
  transaction<T>(operation: () => T): T {
    const runTransaction = this.connection.transaction(operation)
    return runTransaction()
  }

  /** @description 执行参数化 SQL。仅供 Persistence 实现使用。 */
  prepare(sql: string): Database.Statement {
    return this.connection.prepare(sql)
  }

  /** @description 关闭 SQLite 连接 */
  close(): void {
    if (this.connection.open) {
      this.connection.close()
    }
  }

  private runMigrations(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `)
    const row = this.connection
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version?: number | null }
    const version = row.version ?? 0
    if (version >= CURRENT_SCHEMA_VERSION) {
      return
    }

    if (version === 0) {
      const applyMigration = this.connection.transaction(() => {
      this.connection.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE provider_connections (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          provider_definition_id TEXT,
          provider_kind TEXT NOT NULL,
          connection_kind TEXT NOT NULL,
          base_url TEXT,
          credential_ref TEXT,
          environment_mode TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX provider_connections_workspace_idx
          ON provider_connections(workspace_id);
        CREATE TABLE model_catalog (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          provider_connection_id TEXT NOT NULL REFERENCES provider_connections(id),
          provider_kind TEXT NOT NULL,
          model_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          observed_at TEXT NOT NULL
        );
        CREATE INDEX model_catalog_connection_idx
          ON model_catalog(provider_connection_id);
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX sessions_workspace_idx ON sessions(workspace_id, updated_at);
        CREATE TABLE agent_slots (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          role_binding_id TEXT,
          model_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX agent_slots_session_idx ON agent_slots(session_id);
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          session_id TEXT NOT NULL REFERENCES sessions(id),
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX runs_session_idx ON runs(session_id, updated_at);
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          session_id TEXT NOT NULL REFERENCES sessions(id),
          run_id TEXT NOT NULL REFERENCES runs(id),
          slot_id TEXT NOT NULL REFERENCES agent_slots(id),
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX tasks_run_status_idx ON tasks(run_id, status);
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          run_id TEXT,
          sender_kind TEXT NOT NULL,
          sender_id TEXT,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX messages_session_created_idx ON messages(session_id, created_at, id);
        CREATE TABLE permission_requests (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          task_id TEXT NOT NULL REFERENCES tasks(id),
          slot_id TEXT NOT NULL REFERENCES agent_slots(id),
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
        CREATE INDEX permission_status_expiry_idx
          ON permission_requests(status, expires_at);
        CREATE TABLE events (
          event_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          type TEXT NOT NULL,
          source TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE(run_id, sequence)
        );
        CREATE INDEX events_run_sequence_idx ON events(run_id, sequence);
        CREATE TABLE system_messages (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `)
      this.connection
        .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(1, new Date().toISOString())
      })
      try {
        applyMigration()
      } catch (error: unknown) {
        throw new Error(`SQLite migration 失败: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }

    const latestRow = this.connection
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version?: number | null }
    if ((latestRow.version ?? 0) < 2) {
      const applyPermissionRequestMigration = this.connection.transaction(() => {
        const columns = this.connection.prepare('PRAGMA table_info(permission_requests)').all() as Array<{ name: string }>
        if (!columns.some((column) => column.name === 'adapter_request_id')) {
          this.connection.exec('ALTER TABLE permission_requests ADD COLUMN adapter_request_id TEXT')
        }
        this.connection
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(2, new Date().toISOString())
      })
      try {
        applyPermissionRequestMigration()
      } catch (error: unknown) {
        throw new Error(`SQLite migration 002 失败: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }

    const currentVersion = this.connection
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version?: number | null }
    if ((currentVersion.version ?? 0) < 3) {
      const applyProviderConfigMigration = this.connection.transaction(() => {
        const columns = this.connection.prepare('PRAGMA table_info(provider_connections)').all() as Array<{ name: string }>
        if (!columns.some((column) => column.name === 'codex_config_json')) {
          this.connection.exec('ALTER TABLE provider_connections ADD COLUMN codex_config_json TEXT')
        }
        if (!columns.some((column) => column.name === 'config_revision')) {
          this.connection.exec('ALTER TABLE provider_connections ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1')
        }
        this.connection
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(3, new Date().toISOString())
      })
      try {
        applyProviderConfigMigration()
      } catch (error: unknown) {
        throw new Error(`SQLite migration 003 失败: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }

    const permissionIdVersion = this.connection
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version?: number | null }
    if ((permissionIdVersion.version ?? 0) < 4) {
      const applyPermissionIdMigration = this.connection.transaction(() => {
        const columns = this.connection.prepare('PRAGMA table_info(permission_requests)').all() as Array<{ name: string }>
        if (!columns.some((column) => column.name === 'adapter_request_id_encoded')) {
          this.connection.exec('ALTER TABLE permission_requests ADD COLUMN adapter_request_id_encoded TEXT')
        }
        // 旧列 adapter_request_id 只有文本，无法还原原本是 number 还是 string；
        // 因此历史值一律按 string 身份迁移（旧版本确实按 string 使用该字段）。
        copyLegacyAdapterRequestIds(this.connection)
        this.connection
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(4, new Date().toISOString())
      })
      try {
        applyPermissionIdMigration()
      } catch (error: unknown) {
        throw new Error(`SQLite migration 004 失败: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }

    const runClosureVersion = this.connection
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version?: number | null }
    if ((runClosureVersion.version ?? 0) < 5) {
      const applyRunClosureMigration = this.connection.transaction(() => {
        const hasRuns = tableExists(this.connection, 'runs')
        const hasTasks = tableExists(this.connection, 'tasks')
        const hasSlots = tableExists(this.connection, 'agent_slots')
        if (hasRuns) {
          addColumnIfMissing(this.connection, 'runs', 'retry_of_run_id', 'TEXT')
          addColumnIfMissing(this.connection, 'runs', 'retry_chain_id', 'TEXT')
          addColumnIfMissing(this.connection, 'runs', 'state_revision', 'INTEGER NOT NULL DEFAULT 1')
        }
        if (hasTasks) {
          addColumnIfMissing(this.connection, 'tasks', 'input_message_id', 'TEXT')
        }
        // 部分历史库可能缺少这些表；缺表时不创建引用不存在父表的附件表。
        if (hasSlots) {
          this.connection.exec(`
          CREATE TABLE IF NOT EXISTS runtime_attachments (
            slot_id TEXT PRIMARY KEY REFERENCES agent_slots(id),
            session_id TEXT NOT NULL,
            provider_connection_id TEXT NOT NULL,
            provider_kind TEXT NOT NULL,
            config_revision INTEGER NOT NULL,
            adapter_version TEXT NOT NULL,
            adapter_fingerprint TEXT,
            cwd TEXT NOT NULL,
            runtime_directory TEXT NOT NULL,
            acp_session_id TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS command_receipts (
            workspace_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            command TEXT NOT NULL,
            target_id TEXT NOT NULL,
            status TEXT NOT NULL,
            dispatch_state TEXT NOT NULL,
            run_id TEXT,
            task_id TEXT,
            message_id TEXT,
            error_code TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (workspace_id, request_id, command)
          );
          CREATE TABLE IF NOT EXISTS slot_activity_claims (
            slot_id TEXT PRIMARY KEY REFERENCES agent_slots(id),
            run_id TEXT,
            state TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `)
        }
        if (hasRuns) {
          // 历史 Run 自成一条 retry chain；祖先关系从 NULL 开始。
          this.connection.exec('UPDATE runs SET retry_chain_id = id WHERE retry_chain_id IS NULL')
          this.connection.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS runs_retry_chain_attempt_idx
              ON runs(retry_chain_id, attempt) WHERE retry_chain_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS runs_retry_of_idx
              ON runs(retry_of_run_id) WHERE retry_of_run_id IS NOT NULL;
          `)
        }
        if (hasTasks && tableExists(this.connection, 'messages')) {
          // 只回填可唯一确定的输入消息；无法证明唯一对应的保持 NULL（不可恢复）。
          this.connection.exec(`
            UPDATE tasks SET input_message_id = (
              SELECT messages.id FROM messages
               WHERE messages.run_id = tasks.run_id AND messages.sender_kind = 'user'
            )
            WHERE input_message_id IS NULL
              AND (SELECT COUNT(*) FROM messages
                    WHERE messages.run_id = tasks.run_id AND messages.sender_kind = 'user') = 1
          `)
        }
        this.connection
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(5, new Date().toISOString())
      })
      try {
        applyRunClosureMigration()
      } catch (error: unknown) {
        throw new Error(`SQLite migration 005 失败: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }

    const contextSourceVersion = this.connection
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version?: number | null }
    if ((contextSourceVersion.version ?? 0) < 6) {
      const applyContextSourceMigration = this.connection.transaction(() => {
        if (tableExists(this.connection, 'command_receipts')) {
          addColumnIfMissing(this.connection, 'command_receipts', 'target_slot_id', 'TEXT')
          // 未创建 Run 的同键失败也必须能判定输入是否变化，因此只存不可逆摘要。
          addColumnIfMissing(this.connection, 'command_receipts', 'input_digest', 'TEXT')
        }
        if (tableExists(this.connection, 'agent_slots')) {
          this.connection.exec(`
            CREATE TABLE IF NOT EXISTS agent_slot_role_snapshots (
              slot_id TEXT PRIMARY KEY REFERENCES agent_slots(id),
              workspace_id TEXT NOT NULL,
              role_binding_id TEXT NOT NULL,
              role_binding_version INTEGER NOT NULL,
              role_id TEXT NOT NULL,
              role_version INTEGER NOT NULL,
              role_name TEXT NOT NULL,
              system_prompt TEXT NOT NULL,
              required_guidelines_json TEXT NOT NULL,
              output_contract TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
          `)
        }
        if (tableExists(this.connection, 'tasks')) {
          this.connection.exec(`
            CREATE TABLE IF NOT EXISTS context_sources (
              task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
              source_type TEXT NOT NULL CHECK(source_type IN ('role', 'role_binding', 'message')),
              source_id TEXT NOT NULL,
              source_version INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY(task_id, source_type, source_id)
            );
          `)
          this.connection.exec(`
            INSERT OR IGNORE INTO context_sources(task_id, source_type, source_id, source_version, created_at)
            SELECT id, 'message', input_message_id, 1, COALESCE(updated_at, created_at, '')
              FROM tasks WHERE input_message_id IS NOT NULL
          `)
        }
        this.connection
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(6, new Date().toISOString())
      })
      try {
        applyContextSourceMigration()
      } catch (error: unknown) {
        throw new Error(`SQLite migration 006 失败: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }

    const softDeleteVersion = this.connection
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version?: number | null }
    if ((softDeleteVersion.version ?? 0) < 7) {
      const applySoftDeleteMigration = this.connection.transaction(() => {
        if (tableExists(this.connection, 'agent_slots')) {
          addColumnIfMissing(this.connection, 'agent_slots', 'deleted_at', 'TEXT')
        }
        this.connection
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(7, new Date().toISOString())
      })
      try {
        applySoftDeleteMigration()
      } catch (error: unknown) {
        throw new Error(`SQLite migration 007 失败: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }

    const handoffVersion = this.connection
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version?: number | null }
    if ((handoffVersion.version ?? 0) < 8) {
      const applyHandoffMigration = this.connection.transaction(() => {
        if (tableExists(this.connection, 'runs')) {
          // 旧 Run 保持 NULL：不为历史事件猜测可信游标或完成水位。
          addColumnIfMissing(this.connection, 'runs', 'event_sequence', 'INTEGER')
          addColumnIfMissing(this.connection, 'runs', 'completed_sequence', 'INTEGER')
        }
        if (tableExists(this.connection, 'messages')) {
          addColumnIfMissing(this.connection, 'messages', 'kind', 'TEXT')
          addColumnIfMissing(this.connection, 'messages', 'to_slot_id', 'TEXT')
          addColumnIfMissing(this.connection, 'messages', 'handoff_request_id', 'TEXT')
          this.connection.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS messages_handoff_request_idx
              ON messages(session_id, handoff_request_id)
              WHERE handoff_request_id IS NOT NULL;
          `)
        }
        this.connection
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(8, new Date().toISOString())
      })
      try {
        applyHandoffMigration()
      } catch (error: unknown) {
        throw new Error(`SQLite migration 008 失败: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }

    const workspaceRootPathVersion = this.connection
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version?: number | null }
    if ((workspaceRootPathVersion.version ?? 0) < 9) {
      const applyWorkspaceRootPathMigration = this.connection.transaction(() => {
        if (tableExists(this.connection, 'workspaces')) {
          addColumnIfMissing(this.connection, 'workspaces', 'root_path', 'TEXT')
          this.connection.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS workspaces_root_path_unique_idx
              ON workspaces(root_path)
              WHERE root_path IS NOT NULL;
          `)
        }
        this.connection
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(9, new Date().toISOString())
      })
      try {
        applyWorkspaceRootPathMigration()
      } catch (error: unknown) {
        throw new Error(`SQLite migration 009 失败: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }

    const artifactVersion = this.connection
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version?: number | null }
    if ((artifactVersion.version ?? 0) < 10) {
      const applyArtifactMigration = this.connection.transaction(() => {
        this.connection.exec(`
          CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            session_id TEXT NOT NULL REFERENCES sessions(id),
            task_id TEXT NOT NULL REFERENCES tasks(id),
            source_run_id TEXT NOT NULL REFERENCES runs(id),
            request_id TEXT NOT NULL,
            media_type TEXT NOT NULL CHECK(media_type = 'text/plain; charset=utf-8'),
            storage_kind TEXT NOT NULL CHECK(storage_kind = 'inline'),
            status TEXT NOT NULL CHECK(status = 'ready'),
            size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 65536),
            sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
            content_blob BLOB NOT NULL CHECK(typeof(content_blob) = 'blob' AND length(content_blob) = size_bytes),
            created_at TEXT NOT NULL,
            UNIQUE(session_id, request_id)
          );
          CREATE INDEX IF NOT EXISTS artifacts_workspace_session_idx
            ON artifacts(workspace_id, session_id, created_at, id);
          CREATE TRIGGER IF NOT EXISTS artifacts_source_guard
          BEFORE INSERT ON artifacts
          BEGIN
            SELECT CASE WHEN NOT EXISTS (
              SELECT 1
                FROM workspaces AS w
                JOIN sessions AS s ON s.workspace_id = w.id
                JOIN runs AS r ON r.workspace_id = w.id AND r.session_id = s.id
                JOIN tasks AS t ON t.workspace_id = w.id AND t.session_id = s.id AND t.run_id = r.id
               WHERE w.id = NEW.workspace_id
                 AND w.root_path IS NOT NULL
                 AND s.id = NEW.session_id
                 AND r.id = NEW.source_run_id
                 AND r.status = 'completed'
                 AND t.id = NEW.task_id
                 AND t.status = 'completed'
                 AND (SELECT COUNT(*) FROM tasks WHERE run_id = r.id) = 1
            ) THEN RAISE(ABORT, 'artifact source ownership invalid') END;
          END;
        `)
        this.connection
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(10, new Date().toISOString())
      })
      try {
        applyArtifactMigration()
      } catch (error: unknown) {
        throw new Error(`SQLite migration 010 失败: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }

    const mailboxVersion = this.connection
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version?: number | null }
    if ((mailboxVersion.version ?? 0) < 11) {
      const applyMailboxMigration = this.connection.transaction(() => {
        // 部分历史 fixture 缺少 messages；缺表时跳过，避免迁移中断。
        if (tableExists(this.connection, 'messages')) {
          this.connection.exec(`
            CREATE TABLE IF NOT EXISTS mailbox_read_markers (
              message_id TEXT PRIMARY KEY REFERENCES messages(id),
              session_id TEXT NOT NULL REFERENCES sessions(id),
              recipient_slot_id TEXT NOT NULL REFERENCES agent_slots(id),
              read_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS mailbox_read_markers_recipient_idx
              ON mailbox_read_markers(session_id, recipient_slot_id);
            CREATE INDEX IF NOT EXISTS messages_mailbox_idx
              ON messages(session_id, to_slot_id, created_at, id)
              WHERE kind = 'handoff';
          `)
        }
        // 历史 handoff 不写 marker，迁移后一律为 unread。
        this.connection
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(11, new Date().toISOString())
      })
      try {
        applyMailboxMigration()
      } catch (error: unknown) {
        throw new Error(`SQLite migration 011 失败: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }

    const taskLineageVersion = this.connection
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version?: number | null }
    if ((taskLineageVersion.version ?? 0) < 12) {
      const applyTaskLineageMigration = this.connection.transaction(() => {
        if (tableExists(this.connection, 'tasks')) {
          addColumnIfMissing(this.connection, 'tasks', 'node_key', 'TEXT')
          addColumnIfMissing(this.connection, 'tasks', 'attempt', 'INTEGER')
          addColumnIfMissing(
            this.connection,
            'tasks',
            'retry_of_task_id',
            `TEXT CHECK (
              (node_key IS NULL AND attempt IS NULL AND retry_of_task_id IS NULL)
              OR (node_key IS NOT NULL AND length(node_key) > 0
                  AND typeof(attempt) = 'integer' AND attempt > 0)
            )`,
          )
          this.connection.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS tasks_run_node_attempt_idx
              ON tasks(run_id, node_key, attempt)
              WHERE node_key IS NOT NULL;
          `)
          this.connection.exec(`
            UPDATE tasks
               SET node_key = 'legacy', attempt = 1
             WHERE node_key IS NULL AND attempt IS NULL AND retry_of_task_id IS NULL
               AND (SELECT COUNT(*) FROM tasks AS same_run WHERE same_run.run_id = tasks.run_id) = 1;
          `)
          if (columnExists(this.connection, 'runs', 'retry_of_run_id')) {
            this.connection.exec(`
              UPDATE tasks
                 SET retry_of_task_id = (
                   SELECT parent_task.id
                     FROM runs AS retry_run
                     JOIN runs AS parent_run ON parent_run.id = retry_run.retry_of_run_id
                     JOIN tasks AS parent_task ON parent_task.run_id = parent_run.id
                    WHERE retry_run.id = tasks.run_id
                      AND (SELECT COUNT(*) FROM tasks AS retry_tasks WHERE retry_tasks.run_id = retry_run.id) = 1
                      AND (SELECT COUNT(*) FROM tasks AS parent_tasks WHERE parent_tasks.run_id = parent_run.id) = 1
                 )
               WHERE node_key = 'legacy'
                 AND (SELECT COUNT(*) FROM tasks AS same_run WHERE same_run.run_id = tasks.run_id) = 1
                 AND EXISTS (
                   SELECT 1 FROM runs AS retry_run
                    WHERE retry_run.id = tasks.run_id AND retry_run.retry_of_run_id IS NOT NULL
                 );
            `)
          }
        }
        if (tableExists(this.connection, 'events')) {
          addColumnIfMissing(this.connection, 'events', 'task_id', 'TEXT')
          addColumnIfMissing(this.connection, 'events', 'node_key', 'TEXT')
          addColumnIfMissing(
            this.connection,
            'events',
            'attempt',
            `INTEGER CHECK (
              (task_id IS NULL AND node_key IS NULL AND attempt IS NULL)
              OR (task_id IS NOT NULL AND node_key IS NOT NULL AND length(node_key) > 0
                  AND typeof(attempt) = 'integer' AND attempt > 0)
            )`,
          )
          if (tableExists(this.connection, 'tasks')) {
            this.connection.exec(`
              UPDATE events
                 SET task_id = (
                       SELECT id FROM tasks AS source_task WHERE source_task.run_id = events.run_id
                    ),
                     node_key = 'legacy',
                     attempt = 1
               WHERE type = 'agent.message'
                 AND task_id IS NULL AND node_key IS NULL AND attempt IS NULL
                 AND (SELECT COUNT(*) FROM tasks AS same_run WHERE same_run.run_id = events.run_id) = 1
                 AND EXISTS (
                   SELECT 1 FROM tasks AS source_task
                    WHERE source_task.run_id = events.run_id
                      AND source_task.node_key = 'legacy' AND source_task.attempt = 1
                 );
            `)
          }
        }
        if (tableExists(this.connection, 'messages')) {
          addColumnIfMissing(this.connection, 'messages', 'source_task_id', 'TEXT')
          addColumnIfMissing(
            this.connection,
            'messages',
            'source_task_omitted',
            `INTEGER CHECK (
              (source_task_id IS NULL AND source_task_omitted IS NULL)
              OR (source_task_id IS NOT NULL AND source_task_omitted IS NOT NULL
                  AND source_task_omitted IN (0, 1))
            )`,
          )
          if (tableExists(this.connection, 'tasks')) {
            this.connection.exec(`
              UPDATE messages
                 SET source_task_id = (
                       SELECT id FROM tasks AS source_task WHERE source_task.run_id = messages.run_id
                    ),
                     source_task_omitted = 1
               WHERE kind = 'handoff'
                 AND source_task_id IS NULL AND source_task_omitted IS NULL
                 AND run_id IS NOT NULL
                 AND (SELECT COUNT(*) FROM tasks AS same_run WHERE same_run.run_id = messages.run_id) = 1
                 AND EXISTS (
                   SELECT 1 FROM tasks AS source_task
                    WHERE source_task.run_id = messages.run_id
                      AND source_task.node_key = 'legacy' AND source_task.attempt = 1
                 );
            `)
          }
        }
        this.connection
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(12, new Date().toISOString())
      })
      try {
        applyTaskLineageMigration()
      } catch (error: unknown) {
        throw new Error(`SQLite migration 012 失败: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }
  }
}

/** 判断表是否存在，供部分历史库的安全迁移使用。 */
function tableExists(connection: Database.Database, table: string): boolean {
  const row = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined
  return row?.name === table
}

/** 判断历史表是否含有指定列，避免迁移引用尚未创建的字段。 */
function columnExists(connection: Database.Database, table: string, column: string): boolean {
  const columns = connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return columns.some((entry) => entry.name === column)
}

/** 仅在列不存在时添加，保证 migration 可重入。 */
function addColumnIfMissing(
  connection: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((entry) => entry.name === column)) {
    connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

/**
 * 把旧 `adapter_request_id` 文本复制为新列里的 string 标签编码。
 *
 * 旧列存的是裸文本（旧版本已把它当 string 使用），因此不会产生歧义；
 * 没有旧值的行保持 NULL。重复执行是幂等的。
 */
function copyLegacyAdapterRequestIds(connection: Database.Database): void {
  const rows = connection
    .prepare(
      "SELECT id, adapter_request_id FROM permission_requests WHERE adapter_request_id IS NOT NULL AND adapter_request_id_encoded IS NULL",
    )
    .all() as Array<{ id: string; adapter_request_id: string }>
  const update = connection.prepare(
    'UPDATE permission_requests SET adapter_request_id_encoded = ? WHERE id = ?',
  )
  for (const row of rows) {
    update.run(encodeJsonRpcRequestId(String(row.adapter_request_id)), row.id)
  }
}
