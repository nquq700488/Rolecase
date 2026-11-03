import type { AgentSlotRoleSnapshotRecord } from '../../application/ports/repository-port.js'
import { SqliteDatabase } from './sqlite-database.js'


/** 在当前 SQLite 事务中为 Task 写入 Role 与原始 Message source 引用。 */
export function insertTaskContextSources(
  database: SqliteDatabase,
  taskId: string,
  slotId: string,
  messageId: string,
  createdAt: string,
): void {
  const snapshot = database
    .prepare(`SELECT role_binding_id, role_binding_version, role_id, role_version
              FROM agent_slot_role_snapshots WHERE slot_id = ?`)
    .get(slotId) as Pick<AgentSlotRoleSnapshotRecord,
      'role_binding_id' | 'role_binding_version' | 'role_id' | 'role_version'> | undefined
  const insert = database.prepare(
    `INSERT INTO context_sources(task_id, source_type, source_id, source_version, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  if (snapshot !== undefined) {
    insert.run(taskId, 'role', snapshot.role_id, snapshot.role_version, createdAt)
    insert.run(taskId, 'role_binding', snapshot.role_binding_id, snapshot.role_binding_version, createdAt)
  }
  insert.run(taskId, 'message', messageId, 1, createdAt)
}
