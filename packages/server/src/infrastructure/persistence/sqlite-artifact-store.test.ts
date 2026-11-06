import { createHash } from 'node:crypto'

import type { ArtifactDto, EventEnvelope } from '@rolecast/contract'
import { describe, expect, it, vi } from 'vitest'

import { createInlineArtifactContent } from '../../domain/index.js'
import type { CreateInlineArtifactInput } from '../../application/ports/artifact-store-port.js'
import { SqliteDatabase } from './sqlite-database.js'
import { SqliteArtifactStore } from './sqlite-artifact-store.js'

const timestamp = '2026-11-04T10:00:00.000Z'

function seedSource(database: SqliteDatabase): void {
  database.prepare("INSERT INTO workspaces(id, name, created_at, updated_at, root_path) VALUES ('workspace-1', 'w', ?, ?, '/workspace/root')").run(timestamp, timestamp)
  database.prepare("INSERT INTO sessions(id, workspace_id, name, status, created_at, updated_at) VALUES ('session-1', 'workspace-1', 's', 'active', ?, ?)").run(timestamp, timestamp)
  database.prepare("INSERT INTO agent_slots(id, session_id, model_id, status, created_at) VALUES ('slot-1', 'session-1', 'model-1', 'idle', ?)").run(timestamp)
  database.prepare("INSERT INTO runs(id, workspace_id, session_id, status, attempt, created_at, updated_at, event_sequence, completed_sequence) VALUES ('run-1', 'workspace-1', 'session-1', 'completed', 1, ?, ?, 1, 1)").run(timestamp, timestamp)
  database.prepare("INSERT INTO tasks(id, workspace_id, session_id, run_id, slot_id, title, status, created_at, updated_at) VALUES ('task-1', 'workspace-1', 'session-1', 'run-1', 'slot-1', 'task', 'completed', ?, ?)").run(timestamp, timestamp)
  database.prepare("INSERT INTO events(event_id, schema_version, workspace_id, session_id, run_id, sequence, type, source, occurred_at, payload_json) VALUES ('source-event-1', 1, 'workspace-1', 'session-1', 'run-1', 1, 'agent.message', 'test', ?, '{}')").run(timestamp)
}

function createInput(overrides: Partial<CreateInlineArtifactInput> = {}): CreateInlineArtifactInput {
  const bytes = new TextEncoder().encode('redacted output')
  const metadata: ArtifactDto = {
    id: 'artifact-1', workspace_id: 'workspace-1', session_id: 'session-1', task_id: 'task-1',
    source_run_id: 'run-1', media_type: 'text/plain; charset=utf-8', storage_kind: 'inline', status: 'ready',
    size_bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), created_at: timestamp,
  }
  const event: Omit<EventEnvelope, 'sequence'> = {
    event_id: 'artifact-event-1', schema_version: 1, workspace_id: 'workspace-1', session_id: 'session-1',
    run_id: 'run-1', type: 'artifact.created', source: 'artifact-service', occurred_at: timestamp,
    payload: { artifact_id: metadata.id, task_id: metadata.task_id, source_run_id: metadata.source_run_id,
      media_type: metadata.media_type, storage_kind: metadata.storage_kind, status: metadata.status,
      size_bytes: metadata.size_bytes, sha256: metadata.sha256, created_at: metadata.created_at },
  }
  return {
    metadata,
    content: createInlineArtifactContent({ artifactId: metadata.id, bytes }),
    event,
    requestId: 'request-1',
    ...overrides,
  }
}

function insertListArtifact(database: SqliteDatabase, id: string, createdAt = timestamp): void {
  const bytes = new TextEncoder().encode(`body-${id}`)
  database.prepare(`
    INSERT INTO artifacts(
      id, workspace_id, session_id, task_id, source_run_id, request_id,
      media_type, storage_kind, status, size_bytes, sha256, content_blob, created_at
    ) VALUES (?, 'workspace-1', 'session-1', 'task-1', 'run-1', ?,
      'text/plain; charset=utf-8', 'inline', 'ready', ?, ?, ?, ?)
  `).run(
    id,
    `request-${id}`,
    bytes.byteLength,
    createHash('sha256').update(bytes).digest('hex'),
    Buffer.from(bytes),
    createdAt,
  )
}

describe('SqliteArtifactStore', () => {
  it('created_at 相同时按 id 倒序稳定分页，且查询不选择 BLOB', async () => {
    const database = new SqliteDatabase(':memory:')
    seedSource(database)
    insertListArtifact(database, 'artifact-a')
    insertListArtifact(database, 'artifact-c')
    insertListArtifact(database, 'artifact-b')
    const store = new SqliteArtifactStore(database)
    const prepare = vi.spyOn(database, 'prepare')

    const first = await store.listMetadata('workspace-1', 'session-1', { limit: 2 })
    const second = await store.listMetadata('workspace-1', 'session-1', { limit: 2, cursor: 'artifact-b' })

    expect(first).toMatchObject({
      items: [{ id: 'artifact-c' }, { id: 'artifact-b' }],
      next_cursor: 'artifact-b',
    })
    expect(second).toMatchObject({ items: [{ id: 'artifact-a' }], next_cursor: null })
    expect(prepare.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes('ORDER BY'))
      .every((sql) => !/content_blob|SELECT\s+\*/i.test(sql))).toBe(true)
    await database.close()
  })

  it('仅接受当前 Workspace/Session 内 cursor，任一坏 metadata 行使整页失败', async () => {
    const database = new SqliteDatabase(':memory:')
    seedSource(database)
    database.prepare(
      "INSERT INTO sessions(id, workspace_id, name, status, created_at, updated_at) VALUES ('session-2', 'workspace-1', 's2', 'active', ?, ?)",
    ).run(timestamp, timestamp)
    insertListArtifact(database, 'artifact-a')
    const store = new SqliteArtifactStore(database)

    await expect(store.listMetadata('workspace-1', 'session-2', { limit: 10, cursor: 'artifact-a' }))
      .resolves.toBeNull()

    database.prepare("UPDATE artifacts SET created_at = 'not-a-date' WHERE id = 'artifact-a'").run()
    await expect(store.listMetadata('workspace-1', 'session-1', { limit: 10 })).rejects.toThrow()
    await database.close()
  })

  it('原子写入 inline BLOB 与 completed Run metadata Event，且不移动完成水位', async () => {
    const database = new SqliteDatabase(':memory:')
    seedSource(database)
    const store = new SqliteArtifactStore(database)

    const result = await store.create(createInput())

    expect(result).toMatchObject({ kind: 'created', metadata: { id: 'artifact-1' }, event: { sequence: 2 } })
    expect(database.prepare('SELECT content_blob FROM artifacts WHERE id = ?').get('artifact-1'))
      .toEqual({ content_blob: Buffer.from('redacted output') })
    expect(database.prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?').get('run-1'))
      .toEqual({ event_sequence: 2, completed_sequence: 1 })
    const eventRow = database.prepare(
      "SELECT type, payload_json FROM events WHERE event_id = 'artifact-event-1'",
    ).get() as { type: string; payload_json: string }
    expect(eventRow.type).toBe('artifact.created')
    expect(JSON.parse(eventRow.payload_json)).toEqual({
      artifact_id: 'artifact-1', task_id: 'task-1', source_run_id: 'run-1',
      media_type: 'text/plain; charset=utf-8', storage_kind: 'inline', status: 'ready',
      size_bytes: Buffer.byteLength('redacted output'),
      sha256: createHash('sha256').update('redacted output').digest('hex'), created_at: timestamp,
    })
    expect(eventRow.payload_json).not.toContain('redacted output')
    const storedContent = await store.getContent('session-1', 'artifact-1')
    expect(storedContent).toMatchObject({ metadata: { id: 'artifact-1' }, content: { artifactId: 'artifact-1' } })
    expect(storedContent === null ? null : new TextDecoder().decode(storedContent.content.bytes)).toBe('redacted output')
    expect(await store.getMetadata('another-session', 'artifact-1')).toBeNull()
    expect(await store.getContent('another-session', 'artifact-1')).toBeNull()
    await database.close()
  })

  it('同幂等键重放既有行，不重复写入；不同来源返回冲突', async () => {
    const database = new SqliteDatabase(':memory:')
    seedSource(database)
    const store = new SqliteArtifactStore(database)
    const input = createInput()

    expect((await store.create(input)).kind).toBe('created')
    expect(await store.create(input)).toMatchObject({ kind: 'replayed', metadata: { id: 'artifact-1' } })
    expect(await store.create({
      ...input,
      metadata: { ...input.metadata, source_run_id: 'run-other' },
    })).toEqual({ kind: 'conflict' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifacts').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 2 })
    await database.close()
  })

  it('metadata Event 插入失败时回滚 Artifact BLOB 与 Run sequence', async () => {
    const database = new SqliteDatabase(':memory:')
    seedSource(database)
    const store = new SqliteArtifactStore(database)
    const input = createInput({ event: { ...createInput().event, event_id: 'source-event-1' } })

    await expect(store.create(input)).rejects.toThrow()

    expect(database.prepare('SELECT COUNT(*) AS count FROM artifacts').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT event_sequence FROM runs WHERE id = ?').get('run-1'))
      .toEqual({ event_sequence: 1 })
    await database.close()
  })

  it('来源没有已配置 Workspace root 时拒绝且不产生持久化写入', async () => {
    const database = new SqliteDatabase(':memory:')
    seedSource(database)
    database.prepare("UPDATE workspaces SET root_path = NULL WHERE id = 'workspace-1'").run()
    const store = new SqliteArtifactStore(database)

    await expect(store.create(createInput())).resolves.toEqual({ kind: 'source_unavailable' })

    expect(database.prepare('SELECT COUNT(*) AS count FROM artifacts').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 1 })
    await database.close()
  })
})
