import { randomUUID } from 'node:crypto'

import type { EventEnvelope, PermissionRequestDto } from '@rolecast/contract'

import type { EventBusPort } from '../../application/ports/event-bus-port.js'
import { encodeJsonRpcRequestId } from './json-rpc-request-id-codec.js'
import { SqliteDatabase } from './sqlite-database.js'
import { appendRunScopedEventSync } from './sqlite-event-sequence.js'

/** SQLite 中权限状态与 overdue 审计事件的原子写入器。 */
export class SqlitePermissionEventStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly eventBus: EventBusPort | null,
  ) {}

  /** 在同一事务中更新 pending 权限并追加 overdue 事件。 */
  async updatePermissionIfCurrent(
    expectedStatus: PermissionRequestDto['status'],
    request: PermissionRequestDto,
  ): Promise<boolean> {
    let event: EventEnvelope | null = null
    const updated = this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE permission_requests SET
            overdue_at = @overdue_at, expired_at = @expired_at, answered_at = @answered_at,
            selected_option_id = @selected_option_id, status = @status,
            adapter_request_id_encoded = @adapter_request_id_encoded,
            expiration_reason = @expiration_reason
           WHERE id = @id AND status = @expected_status`,
        )
        .run({ ...permissionParameters(request), expected_status: expectedStatus })
      if (result.changes !== 1 || request.overdue_at === undefined) {
        return result.changes === 1
      }
      const run = this.database
        .prepare('SELECT workspace_id, session_id FROM runs WHERE id = ?')
        .get(request.run_id) as { workspace_id: string; session_id: string }
      event = appendRunScopedEventSync(this.database, {
        event_id: randomUUID(),
        schema_version: 1,
        workspace_id: run.workspace_id,
        session_id: run.session_id,
        run_id: request.run_id,
        type: 'agent.permission_overdue',
        source: 'permission-state-coordinator',
        occurred_at: request.overdue_at,
        payload: { permission_id: request.id, status: request.status },
      })
      return true
    })
    if (updated && event !== null && this.eventBus !== null) {
      await this.eventBus.publish(event)
    }
    return updated
  }
}

const permissionParameters = (request: PermissionRequestDto): Record<string, unknown> => ({
  id: request.id,
  run_id: request.run_id,
  task_id: request.task_id,
  slot_id: request.slot_id,
  capability: request.capability,
  description: request.description,
  status: request.status,
  requested_at: request.requested_at,
  soft_timeout_at: request.soft_timeout_at,
  overdue_at: request.overdue_at ?? null,
  expires_at: request.expires_at ?? null,
  expired_at: request.expired_at ?? null,
  answered_at: request.answered_at ?? null,
  selected_option_id: request.selected_option_id ?? null,
  adapter_request_id_encoded: request.adapter_request_id === undefined
    ? null
    : encodeJsonRpcRequestId(request.adapter_request_id),
  expiration_reason: request.expiration_reason ?? null,
})
