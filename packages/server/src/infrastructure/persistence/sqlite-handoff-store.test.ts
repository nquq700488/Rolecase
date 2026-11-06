import { describe, expect, it, vi } from 'vitest'

import type { RunDto, TaskDto } from '@rolecast/contract'

import { SqliteDatabase } from './sqlite-database.js'
import { SqliteHandoffStore } from './sqlite-handoff-store.js'
import { SqliteRepository } from './sqlite-repository.js'

const timestamp = '2026-10-14T10:00:00.000Z'

const setup = async () => {
  const database = new SqliteDatabase(':memory:')
  const repository = new SqliteRepository(database)
  await repository.createWorkspace({ id: 'w', name: 'w', created_at: timestamp, updated_at: timestamp })
  await repository.createSession({
    id: 's', workspace_id: 'w', name: 's', status: 'active', created_at: timestamp, updated_at: timestamp,
  })
  await repository.createAgentSlot({
    id: 'slot-1', session_id: 's', model_id: 'm', status: 'idle', created_at: timestamp,
  })
  await repository.createAgentSlot({
    id: 'slot-2', session_id: 's', role_binding_id: 'binding-1', model_id: 'm',
    status: 'idle', created_at: timestamp,
  })
  const run: RunDto = {
    id: 'run-1', workspace_id: 'w', session_id: 's', status: 'running', attempt: 1,
    created_at: timestamp, updated_at: timestamp,
  }
  const task: TaskDto = {
    id: 'task-1', workspace_id: 'w', session_id: 's', run_id: run.id, slot_id: 'slot-1',
    title: 't', status: 'running', created_at: timestamp, updated_at: timestamp,
  }
  await repository.createTurn(run, task, {
    id: 'msg-user', session_id: 's', run_id: run.id, sender_kind: 'user', sender_id: null,
    content: 'prompt', created_at: timestamp,
  })
  return { database, repository, run, task, store: new SqliteHandoffStore(database) }
}

const appendText = async (repository: SqliteRepository, id: string, text: string): Promise<void> => {
  await repository.appendEvent({
    event_id: id, schema_version: 1, workspace_id: 'w', session_id: 's', run_id: 'run-1',
    type: 'agent.message', source: 'acp-runtime', occurred_at: timestamp, payload: { text },
  })
}

const completeRun = async (
  repository: SqliteRepository,
  run: RunDto,
  task: TaskDto,
): Promise<void> => {
  const revision = await repository.getRunStateRevision(run.id)
  const result = await repository.finalizeRun({
    run: { ...run, status: 'completed', ended_at: timestamp, updated_at: timestamp },
    expectedStateRevision: revision ?? 1,
    taskId: task.id,
    taskStatus: 'completed',
    slotId: task.slot_id,
    releaseClaim: false,
  })
  if (result === null) {
    throw new Error('Run 完成状态未能持久化')
  }
}

describe('handoff event 页的两阶段读取', () => {
  it('超过 512 KiB 时只查长度元数据，不执行 payload SELECT 或 JSON parse', async () => {
    const { database, repository, store } = await setup()
    await appendText(repository, 'e-big', 'x'.repeat(512 * 1024))
    const statements: string[] = []
    const originalPrepare = database.prepare.bind(database)
    database.prepare = ((sql: string) => {
      statements.push(sql)
      return originalPrepare(sql)
    }) as typeof database.prepare
    const parseSpy = vi.spyOn(JSON, 'parse')

    const page = await store.readRunEventPage('run-1', 0, 8)

    expect(page).toEqual({ kind: 'too_large' })
    expect(statements.some((sql) => sql.includes('length(CAST(payload_json AS BLOB))'))).toBe(true)
    expect(statements.some((sql) => sql.includes('SELECT * FROM events WHERE run_id = ? AND sequence BETWEEN'))).toBe(false)
    expect(parseSpy).not.toHaveBeenCalled()
    parseSpy.mockRestore()
    database.prepare = originalPrepare
    await repository.close()
  })

  it('等于 512 KiB 时在同一读事务内先元数据后 payload', async () => {
    const { database, repository, store } = await setup()
    // JSON.stringify({ text }) 的固定开销为 11 字节。
    await appendText(repository, 'e-limit', 'a'.repeat(512 * 1024 - 11))
    const statements: string[] = []
    const originalPrepare = database.prepare.bind(database)
    database.prepare = ((sql: string) => {
      statements.push(sql)
      return originalPrepare(sql)
    }) as typeof database.prepare

    const page = await store.readRunEventPage('run-1', 0, 8)

    expect(page.kind).toBe('ok')
    const metadataIndex = statements.findIndex((sql) => sql.includes('length(CAST(payload_json AS BLOB))'))
    const payloadIndex = statements.findIndex((sql) => sql.includes('SELECT * FROM events WHERE run_id = ? AND sequence BETWEEN'))
    expect(metadataIndex).toBeGreaterThanOrEqual(0)
    expect(payloadIndex).toBeGreaterThan(metadataIndex)
    database.prepare = originalPrepare
    await repository.close()
  })
})

describe('handoff Event provenance fail-closed', () => {
  it('接受与 Task 行一致的 agent.message provenance', async () => {
    const { database, repository, run, task, store } = await setup()
    try {
      await appendText(repository, 'e-agent', 'answer')
      database.prepare(`
        UPDATE events SET task_id = ?, node_key = 'agent', attempt = 1 WHERE event_id = ?
      `).run(task.id, 'e-agent')
      await completeRun(repository, run, task)

      const page = await store.readRunEventPage(run.id, 0, 8)
      expect(page).toMatchObject({
        kind: 'ok', events: [{ type: 'agent.message', payload: { text: 'answer' } }], nextSequence: 1,
      })
    } finally {
      await repository.close()
    }
  })

  it('完成水位内缺少 provenance 的 agent.message 返回 inconsistent', async () => {
    const { database, repository, run, task, store } = await setup()
    try {
      await appendText(repository, 'e-agent', 'unknown owner')
      await completeRun(repository, run, task)
      expect(database.prepare('SELECT completed_sequence FROM runs WHERE id = ?').get(run.id))
        .toEqual({ completed_sequence: 1 })

      await expect(store.readRunEventPage(run.id, 0, 8)).resolves.toMatchObject({ kind: 'inconsistent' })
    } finally {
      await repository.close()
    }
  })

  it('provenance 与 Task lineage 不一致时返回 inconsistent', async () => {
    const { database, repository, run, task, store } = await setup()
    try {
      await appendText(repository, 'e-agent', 'contradictory owner')
      database.prepare(`
        UPDATE events SET task_id = ?, node_key = 'agent', attempt = 1 WHERE event_id = ?
      `).run(task.id, 'e-agent')
      database.prepare("UPDATE tasks SET node_key = 'other-node' WHERE id = ?").run(task.id)
      await completeRun(repository, run, task)

      await expect(store.readRunEventPage(run.id, 0, 8)).resolves.toMatchObject({ kind: 'inconsistent' })
    } finally {
      await repository.close()
    }
  })

  it('provenance 指向其他 Run 的 Task 时返回 inconsistent', async () => {
    const { database, repository, run, task, store } = await setup()
    try {
      const foreignRun: RunDto = { ...run, id: 'run-foreign' }
      const foreignTask: TaskDto = {
        ...task, id: 'task-foreign', run_id: foreignRun.id, slot_id: 'slot-2',
      }
      await repository.createTurn(foreignRun, foreignTask, {
        id: 'message-foreign', session_id: 's', run_id: foreignRun.id,
        sender_kind: 'user', sender_id: null, content: 'foreign prompt', created_at: timestamp,
      })
      await appendText(repository, 'e-agent', 'foreign owner')
      database.prepare(`
        UPDATE events SET task_id = ?, node_key = 'agent', attempt = 1 WHERE event_id = ?
      `).run(foreignTask.id, 'e-agent')
      await completeRun(repository, run, task)

      await expect(store.readRunEventPage(run.id, 0, 8)).resolves.toMatchObject({ kind: 'inconsistent' })
    } finally {
      await repository.close()
    }
  })

  it('无 provenance 的非 agent.message 元数据事件仍可读取', async () => {
    const { repository, run, task, store } = await setup()
    try {
      await repository.appendEvent({
        event_id: 'e-metadata', schema_version: 1, workspace_id: 'w', session_id: 's', run_id: run.id,
        type: 'message.created', source: 'handoff', occurred_at: timestamp, payload: { message_id: 'm-1' },
      })
      await completeRun(repository, run, task)

      await expect(store.readRunEventPage(run.id, 0, 8)).resolves.toMatchObject({
        kind: 'ok', events: [{ type: 'message.created' }], nextSequence: 1,
      })
    } finally {
      await repository.close()
    }
  })
})

describe('handoff 原子写入', () => {
  it('Message、Event 或 SQLite 游标 UPDATE 失败时 Message/key/Event/cursor 全部回滚', async () => {
    const { database, repository, run, task, store } = await setup()
    await appendText(repository, 'e-agent', 'agent')
    const revision = await repository.getRunStateRevision(run.id)
    await repository.finalizeRun({
      run: { ...run, status: 'completed' }, expectedStateRevision: revision ?? 1,
      taskId: task.id, taskStatus: 'completed', slotId: 'slot-1', releaseClaim: false,
    })
    const input = {
      message: {
        id: 'm-h', session_id: 's', run_id: 'run-1', sender_kind: 'agent' as const,
        sender_id: 'slot-1', content: 'agent', created_at: timestamp,
        kind: 'handoff' as const, to_slot_id: 'slot-2',
      },
      event: {
        event_id: 'ev-h', schema_version: 1, workspace_id: 'w', session_id: 's', run_id: 'run-1',
        type: 'message.created', source: 'test', occurred_at: timestamp,
        payload: { message_id: 'm-h', kind: 'handoff', from_slot_id: 'slot-1', to_slot_id: 'slot-2' },
      },
      runId: 'run-1', fromSlotId: 'slot-1', toSlotId: 'slot-2', requestId: 'k-fault',
    }
    const cursorBefore = database
      .prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?').get('run-1')
    const eventsBefore = database
      .prepare('SELECT COUNT(*) AS count FROM events WHERE run_id = ?').get('run-1')

    const originalPrepare = database.prepare.bind(database)
    let failOn: string | null = 'INSERT INTO messages'
    database.prepare = ((sql: string) => {
      if (failOn !== null && sql.includes(failOn)) {
        return {
          run: () => {
            throw new Error('injected handoff failure')
          },
        } as unknown as ReturnType<SqliteDatabase['prepare']>
      }
      return originalPrepare(sql)
    }) as typeof database.prepare

    await expect(store.createHandoffMessage(input)).rejects.toThrow('injected handoff failure')
    expect(database.prepare('SELECT COUNT(*) AS count FROM messages WHERE handoff_request_id = ?')
      .get('k-fault')).toEqual({ count: 0 })

    failOn = 'INSERT INTO events'
    await expect(store.createHandoffMessage(input)).rejects.toThrow('injected handoff failure')
    database.prepare = originalPrepare

    database.prepare(`
      CREATE TEMP TRIGGER fail_handoff_cursor_update
      BEFORE UPDATE OF event_sequence ON runs
      WHEN OLD.id = 'run-1'
        AND EXISTS (
          SELECT 1 FROM messages WHERE session_id = 's' AND handoff_request_id = 'k-fault'
        )
      BEGIN
        SELECT RAISE(ABORT, 'injected handoff cursor failure');
      END
    `).run()
    await expect(store.createHandoffMessage(input)).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT_TRIGGER',
      message: 'injected handoff cursor failure',
    })
    database.prepare('DROP TRIGGER fail_handoff_cursor_update').run()

    expect(database.prepare('SELECT COUNT(*) AS count FROM messages WHERE id = ?').get('m-h'))
      .toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM messages WHERE handoff_request_id = ?')
      .get('k-fault')).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM events WHERE event_id = ?').get('ev-h'))
      .toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM events WHERE run_id = ?').get('run-1'))
      .toEqual(eventsBefore)
    expect(database.prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?')
      .get('run-1')).toEqual(cursorBefore)
    await repository.close()
  })
})
