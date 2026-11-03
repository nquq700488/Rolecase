import { describe, expect, it, vi } from 'vitest'

import type { EventEnvelope, MessageDto, RunDto, TaskDto } from '@rolecast/contract'

import type { EventBusPort } from '../ports/event-bus-port.js'
import { systemClock } from '../ports/clock-port.js'
import { SqliteDatabase } from '../../infrastructure/persistence/sqlite-database.js'
import { SqliteRepository } from '../../infrastructure/persistence/sqlite-repository.js'
import { HandoffService } from './handoff-service.js'

const timestamp = '2026-10-14T10:00:00.000Z'

class TestIds {
  private sequence = 0
  next(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }
}

class CollectingEventBus implements EventBusPort {
  readonly published: EventEnvelope[] = []
  async publish(event: EventEnvelope): Promise<void> {
    this.published.push(event)
  }
  subscribe(): () => void {
    return () => undefined
  }
}

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
    // 带 RoleBinding 的 Slot 才是可软删除的非默认 Slot。
    id: 'slot-2', session_id: 's', role_binding_id: 'binding-1', model_id: 'm', status: 'idle', created_at: timestamp,
  })
  const run: RunDto = {
    id: 'run-1', workspace_id: 'w', session_id: 's', status: 'running', attempt: 1,
    created_at: timestamp, updated_at: timestamp,
  }
  const task: TaskDto = {
    id: 'task-1', workspace_id: 'w', session_id: 's', run_id: run.id, slot_id: 'slot-1',
    title: 't', status: 'running', created_at: timestamp, updated_at: timestamp,
  }
  const message: MessageDto = {
    id: 'msg-user', session_id: 's', run_id: run.id, sender_kind: 'user', sender_id: null,
    content: 'prompt', created_at: timestamp,
  }
  await repository.createTurn(run, task, message)
  return { database, repository, run, task }
}

const appendAgent = async (
  repository: SqliteRepository,
  runId: string,
  id: string,
  text: string,
): Promise<EventEnvelope> => repository.appendEvent({
  event_id: id,
  schema_version: 1,
  workspace_id: 'w',
  session_id: 's',
  run_id: runId,
  type: 'agent.message',
  source: 'acp-runtime',
  occurred_at: timestamp,
  payload: { text },
})

const completeRun = async (repository: SqliteRepository, runId: string): Promise<void> => {
  const current = await repository.getRun(runId)
  const revision = await repository.getRunStateRevision(runId)
  const completed = await repository.finalizeRun({
    run: { ...current!, status: 'completed' },
    expectedStateRevision: revision ?? 1,
    taskId: 'task-1',
    taskStatus: 'completed',
    slotId: 'slot-1',
    releaseClaim: false,
  })
  expect(completed?.run.status).toBe('completed')
}

describe('handoff service', () => {
  it('按 sequence 拼接 Agent 输出并原子写入 metadata Event', async () => {
    const { database, repository, run } = await setup()
    await appendAgent(repository, run.id, 'e1', 'Hello ')
    await appendAgent(repository, run.id, 'e2', 'world')
    await repository.appendEvent({
      event_id: 'e-tool', schema_version: 1, workspace_id: 'w', session_id: 's', run_id: run.id,
      type: 'agent.thought', source: 'acp-runtime', occurred_at: timestamp, payload: { text: 'ignore me' },
    })
    await completeRun(repository, run.id)
    const eventBus = new CollectingEventBus()
    const service = new HandoffService(repository, new TestIds(), systemClock, eventBus)

    const handoff = await service.create('s', {
      source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'key-1',
    })

    expect(handoff).toMatchObject({
      kind: 'handoff', to_slot_id: 'slot-2', sender_id: 'slot-1', content: 'Hello world',
    })
    expect(eventBus.published).toHaveLength(1)
    expect(eventBus.published[0]?.type).toBe('message.created')
    // post-completion Event 推进 event_sequence，但不改变完成水位。
    const sequenceRow = database
      .prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?')
      .get(run.id) as { event_sequence: number; completed_sequence: number }
    expect(sequenceRow).toEqual({ event_sequence: 4, completed_sequence: 3 })

    const snapshot = await repository.getSessionSnapshot('s')
    expect(snapshot?.messages.find((entry) => entry.id === handoff.id)).toMatchObject({
      kind: 'handoff', to_slot_id: 'slot-2',
    })
  })

  it('同一 Run 不同 key 连续推进 event_sequence，completed_sequence 不变', async () => {
    const { database, repository, run } = await setup()
    await appendAgent(repository, run.id, 'e1', 'payload')
    await completeRun(repository, run.id)
    const service = new HandoffService(repository, new TestIds(), systemClock, new CollectingEventBus())

    const first = await service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'k1' })
    const second = await service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'k2' })

    expect(second.id).not.toBe(first.id)
    // 完成后 metadata Event 不进入正文。
    expect(second.content).toBe('payload')
    expect(database.prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?')
      .get(run.id)).toEqual({ event_sequence: 3, completed_sequence: 1 })
    const events = await repository.replayEvents(run.id, 0)
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(events.filter((event) => event.type === 'message.created')).toHaveLength(2)
  })

  it('并发同 key 只创建一条 Message/Event 并只发布一次', async () => {
    const { database, repository, run } = await setup()
    await appendAgent(repository, run.id, 'e1', 'payload')
    await completeRun(repository, run.id)
    const eventBus = new CollectingEventBus()
    const service = new HandoffService(repository, new TestIds(), systemClock, eventBus)

    const [first, second] = await Promise.all([
      service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'same-key' }),
      service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'same-key' }),
    ])

    expect(first.id).toBe(second.id)
    expect(eventBus.published).toHaveLength(1)
    expect(database.prepare('SELECT COUNT(*) AS count FROM messages WHERE handoff_request_id = ?')
      .get('same-key')).toEqual({ count: 1 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = ? AND type = 'message.created'")
      .get(run.id)).toEqual({ count: 1 })
  })

  it('目标 Slot 软删除后同 key 重放仍返回原 Message，不新增 Event', async () => {
    const { database, repository, run } = await setup()
    await appendAgent(repository, run.id, 'e1', 'ok')
    await completeRun(repository, run.id)
    const eventBus = new CollectingEventBus()
    const service = new HandoffService(repository, new TestIds(), systemClock, eventBus)
    const first = await service.create('s', {
      source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'key-1',
    })

    await expect(repository.softDeleteAgentSlot('s', 'slot-2', timestamp)).resolves.toBe('deleted')
    const cursorBefore = database
      .prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?')
      .get(run.id)
    const eventsBefore = database.prepare('SELECT COUNT(*) AS count FROM events WHERE run_id = ?')
      .get(run.id) as { count: number }

    const replay = await service.create('s', {
      source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'key-1',
    })
    expect(replay.id).toBe(first.id)
    expect(eventBus.published).toHaveLength(1)
    expect(database.prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?')
      .get(run.id)).toEqual(cursorBefore)
    expect(database.prepare('SELECT COUNT(*) AS count FROM events WHERE run_id = ?')
      .get(run.id)).toEqual(eventsBefore)

    // 同 key 换目标仍是参数冲突，且不得因目标非法而改变错误语义。
    await expect(service.create('s', {
      source_run_id: run.id, target_slot_id: 'slot-1', request_id: 'key-1',
    })).rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
    // 新 key 指向已软删除的目标仍拒绝。
    await expect(service.create('s', {
      source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'key-2',
    })).rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
  })

  it('相同 key 重放返回原 Message，不递增游标或重复 Event', async () => {
    const { database, repository, run } = await setup()
    await appendAgent(repository, run.id, 'e1', 'ok')
    await completeRun(repository, run.id)
    const eventBus = new CollectingEventBus()
    const service = new HandoffService(repository, new TestIds(), systemClock, eventBus)

    const first = await service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'key-1' })
    const second = await service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'key-1' })

    expect(second.id).toBe(first.id)
    expect(eventBus.published).toHaveLength(1)
    const count = database
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE handoff_request_id = ?')
      .get('key-1') as { count: number }
    expect(count.count).toBe(1)
  })

  it('同 key 不同目标 Slot 返回 409', async () => {
    const { database, repository, run } = await setup()
    await appendAgent(repository, run.id, 'e1', 'ok')
    await completeRun(repository, run.id)
    const service = new HandoffService(repository, new TestIds(), systemClock, new CollectingEventBus())
    await service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'key-1' })
    await expect(service.create('s', { source_run_id: run.id, target_slot_id: 'slot-1', request_id: 'key-1' }))
      .rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
  })

  it('旧 Run 无可信水位、缺尾事件或非 completed 时返回 source_history_unavailable', async () => {
    const { database, repository, run } = await setup()
    await appendAgent(repository, run.id, 'e1', 'ok')
    const service = new HandoffService(repository, new TestIds(), systemClock, new CollectingEventBus())

    await expect(service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'k1' }))
      .rejects.toMatchObject({ code: 'source_history_unavailable', statusCode: 409 })

    await completeRun(repository, run.id)
    database.prepare("DELETE FROM events WHERE run_id = ? AND sequence = 1").run(run.id)
    await expect(service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'k2' }))
      .rejects.toMatchObject({ code: 'source_history_unavailable', statusCode: 409 })

    // 旧 completed Run（水位为 NULL）不能 handoff。
    database.prepare('UPDATE runs SET completed_sequence = NULL WHERE id = ?').run(run.id)
    await expect(service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'k3' }))
      .rejects.toMatchObject({ code: 'source_history_unavailable', statusCode: 409 })
  })

  it('正文 UTF-8 超过 64 KiB 时返回 413 且不写 Message', async () => {
    const { database, repository, run } = await setup()
    await appendAgent(repository, run.id, 'e1', 'a'.repeat(64 * 1024))
    await appendAgent(repository, run.id, 'e2', 'b')
    await completeRun(repository, run.id)
    const service = new HandoffService(repository, new TestIds(), systemClock, new CollectingEventBus())

    await expect(service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'k1' }))
      .rejects.toMatchObject({ code: 'handoff_content_too_large', statusCode: 413 })
    const count = database
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE kind = 'handoff'")
      .get() as { count: number }
    expect(count.count).toBe(0)
  })

  it('单条 payload 超过 512 KiB 时返回 413 且不解析 payload', async () => {
    const { database, repository, run } = await setup()
    await appendAgent(repository, run.id, 'e1', 'x'.repeat(512 * 1024 + 1))
    await completeRun(repository, run.id)
    const service = new HandoffService(repository, new TestIds(), systemClock, new CollectingEventBus())
    const parseSpy = vi.spyOn(JSON, 'parse')

    await expect(service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'k1' }))
      .rejects.toMatchObject({ code: 'source_event_payload_too_large', statusCode: 413 })
    // 元数据阶段之外不得 parse 超限 payload（允许无关的 JSON.parse 调用为 0 次更严格）。
    expect(parseSpy).not.toHaveBeenCalled()
    parseSpy.mockRestore()
  })

  it('已完成 Run 拒绝普通 Event append', async () => {
    const { database, repository, run } = await setup()
    await appendAgent(repository, run.id, 'e1', 'ok')
    await completeRun(repository, run.id)
    await expect(repository.appendEvent({
      event_id: 'late', schema_version: 1, workspace_id: 'w', session_id: 's', run_id: run.id,
      type: 'agent.message', source: 'acp-runtime', occurred_at: timestamp, payload: { text: 'late' },
    })).rejects.toThrow('terminally closed')
  })

  it('目标 Slot 与来源相同、跨 Session 或已软删除时拒绝', async () => {
    const { database, repository, run } = await setup()
    await appendAgent(repository, run.id, 'e1', 'ok')
    await completeRun(repository, run.id)
    const service = new HandoffService(repository, new TestIds(), systemClock, new CollectingEventBus())
    await expect(service.create('s', { source_run_id: run.id, target_slot_id: 'slot-1', request_id: 'k1' }))
      .rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
    await expect(service.create('s', { source_run_id: run.id, target_slot_id: 'slot-2', request_id: 'k1' }))
      .resolves.toMatchObject({ kind: 'handoff' })
  })
})
