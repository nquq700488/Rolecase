import { randomUUID } from 'node:crypto'

import type { EventEnvelope } from '@rolecast/contract'

import type { EventBusPort } from '../../application/ports/event-bus-port.js'
import { SqliteDatabase } from './sqlite-database.js'
import { appendRunScopedEventSync, isTerminallyClosedStatus } from './sqlite-event-sequence.js'

/** 服务重启时原子收敛失效权限请求及其审计事件。 */
export class SqlitePermissionRecoveryStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly eventBus: EventBusPort | null,
  ) {}

  /** 将没有可重挂接 Runtime 的 pending 请求收敛为 expired。 */
  async reconcile(now: Date): Promise<number> {
    const events: EventEnvelope[] = []
    const count = this.database.transaction(() => {
      const pending = this.database
        .prepare('SELECT id, run_id, task_id FROM permission_requests WHERE status = ?')
        .all('pending') as Array<{ id: string; run_id: string; task_id: string }>
      const updatePermission = this.database.prepare(
        `UPDATE permission_requests SET status = 'expired', expired_at = ?,
          expiration_reason = 'runtime_unavailable', decision_id = NULL, lease_until = NULL
         WHERE id = ? AND status = 'pending'`,
      )
      const updateRun = this.database.prepare("UPDATE runs SET status = 'interrupted', updated_at = ? WHERE id = ?")
      const updateTask = this.database.prepare("UPDATE tasks SET status = 'paused', updated_at = ? WHERE id = ?")
      const insertMessage = this.database.prepare(
        'INSERT INTO system_messages(id, kind, created_at) VALUES (?, ?, ?)',
      )
      let updatedCount = 0
      for (const request of pending) {
        // Recovery 不能把真正终态 Run 改回可恢复状态，也不得为其追加 Event。
        const runState = this.database
          .prepare('SELECT status FROM runs WHERE id = ?')
          .get(request.run_id) as { status?: string } | undefined
        if (runState?.status === undefined || isTerminallyClosedStatus(runState.status)) {
          continue
        }
        const changed = updatePermission.run(now.toISOString(), request.id)
        if (changed.changes !== 1) {
          continue
        }
        updateRun.run(now.toISOString(), request.run_id)
        updateTask.run(now.toISOString(), request.task_id)
        insertMessage.run(randomUUID(), 'permission_runtime_unavailable', now.toISOString())
        const run = this.database
          .prepare('SELECT workspace_id, session_id FROM runs WHERE id = ?')
          .get(request.run_id) as { workspace_id: string; session_id: string }
        events.push(appendRunScopedEventSync(this.database, {
          event_id: randomUUID(),
          schema_version: 1,
          workspace_id: run.workspace_id,
          session_id: run.session_id,
          run_id: request.run_id,
          type: 'agent.permission_expired',
          source: 'permission-recovery',
          occurred_at: now.toISOString(),
          payload: {
            permission_id: request.id,
            status: 'expired',
            expiration_reason: 'runtime_unavailable',
          },
        }))
        events.push(appendRunScopedEventSync(this.database, {
          event_id: randomUUID(),
          schema_version: 1,
          workspace_id: run.workspace_id,
          session_id: run.session_id,
          run_id: request.run_id,
          type: 'run.interrupted',
          source: 'permission-recovery',
          occurred_at: now.toISOString(),
          payload: { permission_id: request.id },
        }))
        updatedCount += 1
      }
      return updatedCount
    })
    if (this.eventBus !== null) {
      for (const event of events) {
        await this.eventBus.publish(event)
      }
    }
    return count
  }
}
