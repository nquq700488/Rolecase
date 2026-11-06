import type { RunDto, TaskDto } from '@rolecast/contract'

import type {
  CommandDispatchState,
  CommandReceiptRecord,
  CommandReceiptStatus,
} from '../../application/ports/repository-port.js'
import { insertRun, insertTask } from './sqlite-run-closure.js'
import { insertTaskContextSources } from './sqlite-context-source-writer.js'
import { SqliteDatabase } from './sqlite-database.js'

type Row = Record<string, unknown>

/**
 * @name SqliteRetryStore
 * @description 原子持久化 retry attempt、claim 与命令回执引用
 */
export class SqliteRetryStore {
  constructor(private readonly database: SqliteDatabase) {}

  /** 原子创建 retry 子 Run/Task/ContextSource 并把引用写入 receipt。 */
  async createRetryTurn(
    parentRunId: string,
    run: RunDto,
    task: TaskDto,
    receipt: CommandReceiptRecord,
    expected: {
      status: CommandReceiptStatus
      dispatch_state: CommandDispatchState
      run_id: string | null
      task_id: string | null
      message_id: string | null
    },
    now: string,
  ): Promise<CommandReceiptRecord | null> {
    return this.database.transaction(() => {
      const activeSlot = this.database
        .prepare('SELECT 1 AS found FROM agent_slots WHERE id = ? AND session_id = ? AND deleted_at IS NULL')
        .get(task.slot_id, task.session_id)
      if (activeSlot === undefined) {
        return null
      }
      const parent = this.database
        .prepare('SELECT id, retry_chain_id, attempt FROM runs WHERE id = ?')
        .get(parentRunId) as { id: string; retry_chain_id?: string | null; attempt: number } | undefined
      if (parent === undefined) {
        return null
      }
      const chainId = parent.retry_chain_id ?? parent.id
      const descendant = this.database
        .prepare('SELECT 1 AS found FROM runs WHERE retry_chain_id = ? AND attempt > ? LIMIT 1')
        .get(chainId, parent.attempt)
      if (descendant !== undefined) {
        return null
      }
      const current = this.database
        .prepare(`SELECT status, dispatch_state, target_id, run_id, task_id, message_id
                  FROM command_receipts WHERE workspace_id = ? AND request_id = ? AND command = ?`)
        .get(receipt.workspace_id, receipt.request_id, receipt.command) as
        | {
            status: string
            dispatch_state: string
            target_id: string
            run_id?: string | null
            task_id?: string | null
            message_id?: string | null
          }
        | undefined
      if (
        current === undefined
        || current.target_id !== parentRunId
        || current.status !== expected.status
        || current.dispatch_state !== expected.dispatch_state
        || (current.run_id ?? null) !== expected.run_id
        || (current.task_id ?? null) !== expected.task_id
        || (current.message_id ?? null) !== expected.message_id
      ) {
        return null
      }
      const claim = this.database
        .prepare('SELECT run_id FROM slot_activity_claims WHERE slot_id = ?')
        .get(task.slot_id) as { run_id?: string | null } | undefined
      if (claim !== undefined && claim.run_id !== parentRunId) {
        return null
      }
      const parentTasks = this.database
        .prepare('SELECT id, input_message_id, node_key, attempt FROM tasks WHERE run_id = ?')
        .all(parentRunId) as Array<{
          id: string
          input_message_id: string | null
          node_key: string | null
          attempt: number | null
        }>
      const parentTask = parentTasks[0]
      if (
        parentTasks.length !== 1
        || parentTask === undefined
        || typeof parentTask.node_key !== 'string'
        || parentTask.node_key.length === 0
        || typeof parentTask.attempt !== 'number'
        || !Number.isSafeInteger(parentTask.attempt)
        || parentTask.attempt <= 0
      ) {
        return null
      }
      const inputMessageId = parentTask.input_message_id
      if (inputMessageId === null) {
        throw new Error('retry Context source message is missing')
      }
      this.database
        .prepare(`INSERT INTO slot_activity_claims(slot_id, run_id, state, updated_at)
                  VALUES (?, ?, 'active', ?)
                  ON CONFLICT(slot_id) DO UPDATE SET run_id = excluded.run_id, state = 'active',
                    updated_at = excluded.updated_at`)
        .run(task.slot_id, run.id, now)
      insertRun(this.database, { ...run, retry_of_run_id: parentRunId }, chainId)
      insertTask(this.database, task, inputMessageId, {
        nodeKey: parentTask.node_key,
        attempt: 1,
        retryOfTaskId: parentTask.id,
      })
      insertTaskContextSources(this.database, task.id, task.slot_id, inputMessageId, task.created_at)
      const changed = this.database
        .prepare(`UPDATE command_receipts SET run_id = ?, task_id = ?, message_id = ?, updated_at = ?
                  WHERE workspace_id = ? AND request_id = ? AND command = ? AND target_id = ?
                    AND status = ? AND dispatch_state = ?
                    AND run_id IS ? AND task_id IS ? AND message_id IS ?`)
        .run(
          run.id,
          task.id,
          inputMessageId,
          now,
          receipt.workspace_id,
          receipt.request_id,
          receipt.command,
          parentRunId,
          expected.status,
          expected.dispatch_state,
          expected.run_id,
          expected.task_id,
          expected.message_id,
        )
      if (changed.changes !== 1) {
        throw new Error('retry receipt changed concurrently')
      }
      return {
        ...receipt,
        run_id: run.id,
        task_id: task.id,
        message_id: inputMessageId,
        updated_at: now,
      }
    })
  }

  /** 只有 receipt 仍指向未派发 child 时才删除 attempt 并把 claim 还给父 Run。 */
  async rollbackRetryTurn(
    receipt: CommandReceiptRecord,
    childRunId: string,
    parentRunId: string,
    slotId: string,
  ): Promise<boolean> {
    return this.database.transaction(() => {
      if (
        receipt.dispatch_state !== 'not_started'
        || receipt.run_id !== childRunId
        || receipt.task_id === undefined
        || receipt.message_id === undefined
      ) {
        return false
      }
      const current = this.database
        .prepare(`SELECT status, dispatch_state, target_id, run_id, task_id, message_id
                  FROM command_receipts WHERE workspace_id = ? AND request_id = ? AND command = ?`)
        .get(receipt.workspace_id, receipt.request_id, receipt.command) as Row | undefined
      if (
        current === undefined
        || current.target_id !== receipt.target_id
        || current.status !== receipt.status
        || current.dispatch_state !== receipt.dispatch_state
        || current.run_id !== childRunId
        || current.task_id !== receipt.task_id
        || current.message_id !== receipt.message_id
      ) {
        return false
      }
      const claim = this.database
        .prepare('SELECT run_id, state FROM slot_activity_claims WHERE slot_id = ?')
        .get(slotId) as { run_id?: string | null; state?: string } | undefined
      if (claim?.run_id !== childRunId || claim.state !== 'active') {
        return false
      }
      const updated = this.database
        .prepare(`UPDATE command_receipts SET status = 'failed', dispatch_state = 'not_started',
                    run_id = NULL, task_id = NULL, message_id = NULL, error_code = 'db_unavailable',
                    updated_at = ?
                  WHERE workspace_id = ? AND request_id = ? AND command = ? AND target_id = ?
                    AND status = ? AND dispatch_state = ?
                    AND run_id = ? AND task_id = ? AND message_id = ?`)
        .run(
          receipt.updated_at,
          receipt.workspace_id,
          receipt.request_id,
          receipt.command,
          receipt.target_id,
          receipt.status,
          receipt.dispatch_state,
          childRunId,
          receipt.task_id,
          receipt.message_id,
        )
      if (updated.changes !== 1) {
        return false
      }
      const claimUpdated = this.database
        .prepare(`UPDATE slot_activity_claims SET run_id = ?, state = 'active', updated_at = ?
                  WHERE slot_id = ? AND run_id = ? AND state = 'active'`)
        .run(parentRunId, receipt.updated_at, slotId, childRunId)
      if (claimUpdated.changes !== 1) {
        throw new Error('retry claim changed during rollback')
      }
      this.database.prepare('DELETE FROM tasks WHERE run_id = ?').run(childRunId)
      this.database.prepare('DELETE FROM runs WHERE id = ?').run(childRunId)
      return true
    })
  }
}
