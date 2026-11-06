import { describe, expect, it, vi } from 'vitest'

import type { ArtifactDto, EventEnvelope, RunDto, SessionDto, TaskDto } from '@rolecast/contract'

import type { EventBusPort } from '../ports/event-bus-port.js'
import type { HandoffSourceRecord, RunEventPage } from '../ports/repository-port.js'
import { systemClock } from '../ports/clock-port.js'
import { ArtifactService } from './artifact-service.js'

const timestamp = '2026-11-04T10:00:00.000Z'
const session: SessionDto = {
  id: 'session-001', workspace_id: 'workspace-001', name: 'session', status: 'active',
  created_at: timestamp, updated_at: timestamp,
}
const run: RunDto = {
  id: 'run-001', workspace_id: 'workspace-001', session_id: session.id, status: 'completed', attempt: 1,
  created_at: timestamp, updated_at: timestamp,
}
const task: TaskDto = {
  id: 'task-001', workspace_id: 'workspace-001', session_id: session.id, run_id: run.id,
  slot_id: 'slot-001', title: 'task', status: 'completed', created_at: timestamp, updated_at: timestamp,
}
const source: HandoffSourceRecord = {
  run, task, from_slot_id: task.slot_id, completed_sequence: 1,
}

interface HarnessOptions {
  readonly session?: SessionDto | null
  readonly source?: HandoffSourceRecord | null
  readonly rootPath?: string | null
  readonly canonicalPath?: string
  readonly text?: string
  readonly redact?: (value: string) => string
  readonly redactionAvailable?: boolean
  readonly existing?: ArtifactDto | null
  readonly contentRecord?: {
    readonly metadata: ArtifactDto
    readonly content: { readonly artifactId: string; readonly bytes: Uint8Array }
  } | null
}

function createHarness(options: HarnessOptions = {}) {
  const text = options.text ?? 'persisted output'
  const persistedEvent: EventEnvelope = {
    event_id: 'source-event-001', schema_version: 1, workspace_id: run.workspace_id, session_id: session.id,
    run_id: run.id, sequence: 1, type: 'agent.message', source: 'acp-runtime', occurred_at: timestamp,
    payload: { text },
  }
  const page: RunEventPage = { kind: 'ok', events: [persistedEvent], nextSequence: 1 }
  const repository = {
    getSession: vi.fn(async () => options.session === undefined ? session : options.session),
    getWorkspaceRootPath: vi.fn(async () => options.rootPath === undefined
      ? { workspace_id: session.workspace_id, root_path: '/workspace/root' }
      : options.rootPath === null
        ? { workspace_id: session.workspace_id, root_path: null }
        : { workspace_id: session.workspace_id, root_path: options.rootPath }),
    getHandoffSource: vi.fn(async () => options.source === undefined ? source : options.source),
    readRunEventPage: vi.fn(async (_runId: string, _after: number, _limit: number) => page),
  }
  const metadata = options.existing ?? null
  const contentRecord = options.contentRecord ?? null
  const store = {
    findByRequest: vi.fn(async () => metadata),
    create: vi.fn(async (input: {
      readonly metadata: ArtifactDto
      readonly content: { readonly artifactId: string; readonly bytes: Uint8Array }
      readonly event: Omit<EventEnvelope, 'sequence'>
      readonly requestId: string
    }) => ({
      kind: 'created' as const,
      metadata: input.metadata,
      event: { ...input.event, sequence: 2 },
    })),
    getMetadata: vi.fn(async () => metadata),
    getContent: vi.fn(async () => contentRecord),
    listMetadata: vi.fn(async () => ({ items: [artifactFixture()], next_cursor: null })),
  }
  const rootPaths = {
    resolveExistingDirectory: vi.fn(async () => options.canonicalPath ?? '/workspace/root'),
  }
  const redaction = options.redactionAvailable === false
    ? null
    : { redact: vi.fn((value: string) => options.redact?.(value) ?? value) }
  const published: EventEnvelope[] = []
  const eventBus: EventBusPort = {
    publish: vi.fn(async (event: EventEnvelope) => { published.push(event) }),
    subscribe: () => () => undefined,
  }
  let id = 0
  const ids = { next: (prefix: string): string => `${prefix}-${++id}` }
  const service = new ArtifactService(repository, store, rootPaths, redaction, ids, systemClock, eventBus)
  return { service, repository, store, rootPaths, redaction, published }
}

const request = { source_run_id: run.id, request_id: 'request-001' }

function artifactFixture(overrides: Partial<ArtifactDto> = {}): ArtifactDto {
  return {
    id: 'artifact-001', workspace_id: session.workspace_id, session_id: session.id, task_id: task.id,
    source_run_id: run.id, media_type: 'text/plain; charset=utf-8', storage_kind: 'inline', status: 'ready',
    size_bytes: 4, sha256: 'a'.repeat(64), created_at: timestamp, ...overrides,
  }
}

describe('ArtifactService', () => {
  it('从合格 completed Run 的持久化 Agent 输出脱敏并创建 metadata-only Event', async () => {
    const { service, store, published } = createHarness({ redact: (value) => value.replace('secret', '[redacted]'), text: 'secret text' })

    const artifact = await service.create(session.id, request)

    expect(artifact).toMatchObject({ storage_kind: 'inline', status: 'ready', size_bytes: 15 })
    expect(store.create).toHaveBeenCalledOnce()
    expect(store.create.mock.calls[0]?.[0].content.bytes).toEqual(new TextEncoder().encode('[redacted] text'))
    expect(JSON.stringify(store.create.mock.calls[0]?.[0].event)).not.toContain('secret text')
    expect(published).toHaveLength(1)
    expect(published[0]?.type).toBe('artifact.created')
    expect(JSON.stringify(published[0]?.payload)).not.toContain('secret text')
  })

  it('零 Task 来源被拒绝且不写 Artifact/Event', async () => {
    const { service, store, published } = createHarness({ source: null })

    await expect(service.create(session.id, request))
      .rejects.toMatchObject({ code: 'source_history_unavailable', statusCode: 409 })

    expect(store.create).not.toHaveBeenCalled()
    expect(published).toHaveLength(0)
  })

  it('唯一 Task 未完成时拒绝来源且不写 Artifact/Event', async () => {
    const { service, store, published } = createHarness({ source: { ...source, task: { ...task, status: 'running' } } })

    await expect(service.create(session.id, request))
      .rejects.toMatchObject({ code: 'source_history_unavailable', statusCode: 409 })

    expect(store.create).not.toHaveBeenCalled()
    expect(published).toHaveLength(0)
  })

  it('Workspace root 缺失或 canonical 值变化时 fail-closed', async () => {
    const unconfigured = createHarness({ rootPath: null })
    await expect(unconfigured.service.create(session.id, request))
      .rejects.toMatchObject({ code: 'workspace_root_unconfigured', statusCode: 409 })
    expect(unconfigured.store.create).not.toHaveBeenCalled()

    const changed = createHarness({ canonicalPath: '/workspace/other' })
    await expect(changed.service.create(session.id, request))
      .rejects.toMatchObject({ code: 'workspace_root_unavailable', statusCode: 409 })
    expect(changed.store.create).not.toHaveBeenCalled()
  })

  it('来源正文按 UTF-8 字节数限制，超限无写入', async () => {
    const { service, store } = createHarness({ text: '😀'.repeat(16_385) })

    await expect(service.create(session.id, request))
      .rejects.toMatchObject({ code: 'artifact_too_large', statusCode: 413 })

    expect(store.create).not.toHaveBeenCalled()
  })

  it('脱敏后正文超限、Port 缺失或抛错时不写入', async () => {
    const oversized = createHarness({ text: 'x', redact: () => '😀'.repeat(16_385) })
    await expect(oversized.service.create(session.id, request))
      .rejects.toMatchObject({ code: 'artifact_too_large', statusCode: 413 })
    expect(oversized.store.create).not.toHaveBeenCalled()

    const missing = createHarness({ redactionAvailable: false })
    await expect(missing.service.create(session.id, request))
      .rejects.toMatchObject({ code: 'artifact_sanitization_failed', statusCode: 500 })
    expect(missing.store.create).not.toHaveBeenCalled()

    const throwing = createHarness({ redact: () => { throw new Error('secret text') } })
    await expect(throwing.service.create(session.id, request))
      .rejects.toMatchObject({ code: 'artifact_sanitization_failed', statusCode: 500 })
    expect(throwing.store.create).not.toHaveBeenCalled()
  })

  it('相同幂等键同来源返回既有 Artifact，不重复发布', async () => {
    const existing = artifactFixture()
    const { service, store, published } = createHarness({ existing })

    await expect(service.create(session.id, request)).resolves.toEqual(existing)

    expect(store.create).not.toHaveBeenCalled()
    expect(published).toHaveLength(0)
  })

  it('分页列表先验证 Session，再以 Workspace + Session scope 读取 metadata', async () => {
    const { service, repository, store, rootPaths } = createHarness()
    const query = { limit: 3, cursor: 'artifact-cursor' }

    await expect(service.list(session.id, query)).resolves.toEqual({
      items: [artifactFixture()],
      next_cursor: null,
    })

    expect(repository.getSession).toHaveBeenCalledWith(session.id)
    expect(store.listMetadata).toHaveBeenCalledWith(session.workspace_id, session.id, query)
    expect(rootPaths.resolveExistingDirectory).not.toHaveBeenCalled()
  })

  it('未知 Session 使用 not_found，且不查询 Artifact Store', async () => {
    const { service, store } = createHarness({ session: null })

    await expect(service.list('missing-session', { limit: 50 }))
      .rejects.toMatchObject({ code: 'not_found', statusCode: 404 })

    expect(store.listMetadata).not.toHaveBeenCalled()
  })

  it('读取内容前校验长度与 SHA-256，损坏正文统一隐藏', async () => {
    const { service } = createHarness({
      contentRecord: {
        metadata: artifactFixture(),
        content: { artifactId: 'artifact-001', bytes: new TextEncoder().encode('evil') },
      },
    })

    await expect(service.getContent(session.id, 'artifact-001'))
      .rejects.toMatchObject({ code: 'artifact_unavailable', statusCode: 404 })
  })
})
