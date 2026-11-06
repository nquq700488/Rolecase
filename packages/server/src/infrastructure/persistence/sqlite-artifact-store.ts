import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

import { artifactDtoSchema } from '@rolecast/contract'
import type { ArtifactDto, ArtifactPageDto, ArtifactPageQuery, EventEnvelope } from '@rolecast/contract'

import type { ArtifactContentRecord, ArtifactStorePort, CreateInlineArtifactInput, CreateInlineArtifactResult } from '../../application/ports/artifact-store-port.js'
import { appendArtifactMetadataEventSync } from './sqlite-event-sequence.js'
import type { SqliteDatabase } from './sqlite-database.js'

type Row = Record<string, unknown>

/** SQLite inline Artifact 的事务存储与 Session-scoped 查询。 */
export class SqliteArtifactStore implements ArtifactStorePort {
  constructor(private readonly database: SqliteDatabase) {}

  /** 按 Session 与幂等键读取已有元数据。 */
  async findByRequest(sessionId: string, requestId: string): Promise<ArtifactDto | null> {
    const row = this.findByRequestRow(sessionId, requestId)
    return row === null ? null : toArtifactDto(row)
  }

  /** 在同一事务写入 BLOB、metadata 和 completed-Run Event。 */
  async create(input: CreateInlineArtifactInput): Promise<CreateInlineArtifactResult> {
    try {
      return this.database.transaction(() => {
        const existing = this.findByRequestRow(input.metadata.session_id, input.requestId)
        if (existing !== null) {
          return classifyReplay(existing, input.metadata.source_run_id)
        }
        assertValidInput(input)
        if (!this.sourceIsAvailable(input)) {
          return { kind: 'source_unavailable' }
        }

        this.database.prepare(
          `INSERT INTO artifacts(
            id, workspace_id, session_id, task_id, source_run_id, request_id,
            media_type, storage_kind, status, size_bytes, sha256, content_blob, created_at
          ) VALUES (
            @id, @workspace_id, @session_id, @task_id, @source_run_id, @request_id,
            @media_type, @storage_kind, @status, @size_bytes, @sha256, @content_blob, @created_at
          )`,
        ).run({
          ...input.metadata,
          request_id: input.requestId,
          content_blob: Buffer.from(input.content.bytes),
        })
        const event = appendArtifactMetadataEventSync(this.database, metadataEvent(input))
        return { kind: 'created', metadata: input.metadata, event }
      })
    } catch (error: unknown) {
      const existing = this.findByRequestRow(input.metadata.session_id, input.requestId)
      if (existing !== null) {
        return classifyReplay(existing, input.metadata.source_run_id)
      }
      throw error
    }
  }

  /** 仅按 Session 读取 metadata；无效持久化行按不可用隐藏。 */
  async getMetadata(sessionId: string, artifactId: string): Promise<ArtifactDto | null> {
    const row = this.database.prepare(
      'SELECT * FROM artifacts WHERE session_id = ? AND id = ?',
    ).get(sessionId, artifactId) as Row | undefined
    return row === undefined ? null : toArtifactDto(row)
  }

  /** 按 Workspace + Session scope 稳定分页读取 metadata，不选择正文 BLOB。 */
  async listMetadata(
    workspaceId: string,
    sessionId: string,
    query: ArtifactPageQuery,
  ): Promise<ArtifactPageDto | null> {
    let cursor: ArtifactDto | null = null
    if (query.cursor !== undefined) {
      const cursorRow = this.database.prepare(
        `SELECT id, workspace_id, session_id, task_id, source_run_id, media_type,
                storage_kind, status, size_bytes, sha256, created_at
           FROM artifacts
          WHERE workspace_id = ? AND session_id = ? AND id = ?`,
      ).get(workspaceId, sessionId, query.cursor) as Row | undefined
      if (cursorRow === undefined) {
        return null
      }
      cursor = toArtifactDto(cursorRow)
      if (cursor === null) {
        return null
      }
    }

    const rows = cursor === null
      ? this.database.prepare(
        `SELECT id, workspace_id, session_id, task_id, source_run_id, media_type,
                storage_kind, status, size_bytes, sha256, created_at
           FROM artifacts
          WHERE workspace_id = ? AND session_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      ).all(workspaceId, sessionId, query.limit + 1) as Row[]
      : this.database.prepare(
        `SELECT id, workspace_id, session_id, task_id, source_run_id, media_type,
                storage_kind, status, size_bytes, sha256, created_at
           FROM artifacts
          WHERE workspace_id = ? AND session_id = ?
            AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      ).all(
        workspaceId,
        sessionId,
        cursor.created_at,
        cursor.created_at,
        cursor.id,
        query.limit + 1,
      ) as Row[]

    const hasMore = rows.length > query.limit
    const selectedRows = hasMore ? rows.slice(0, query.limit) : rows
    const items = selectedRows.map((row) => {
      const metadata = toArtifactDto(row)
      if (metadata === null) {
        throw new Error('invalid artifact metadata row')
      }
      return metadata
    })
    return {
      items,
      next_cursor: hasMore ? items.at(-1)?.id ?? null : null,
    }
  }

  /** 按 Session 读取 metadata 与私有 BLOB；正文由 Application 校验摘要后解码。 */
  async getContent(sessionId: string, artifactId: string): Promise<ArtifactContentRecord | null> {
    const row = this.database.prepare(
      `SELECT *, typeof(content_blob) AS content_type
         FROM artifacts WHERE session_id = ? AND id = ?`,
    ).get(sessionId, artifactId) as Row | undefined
    if (row === undefined || row.content_type !== 'blob') {
      return null
    }
    const metadata = toArtifactDto(row)
    if (metadata === null || !Buffer.isBuffer(row.content_blob)) {
      return null
    }
    return {
      metadata,
      content: { artifactId: metadata.id, bytes: new Uint8Array(row.content_blob) },
    }
  }

  private findByRequestRow(sessionId: string, requestId: string): Row | null {
    const row = this.database.prepare(
      'SELECT * FROM artifacts WHERE session_id = ? AND request_id = ?',
    ).get(sessionId, requestId) as Row | undefined
    return row ?? null
  }

  private sourceIsAvailable(input: CreateInlineArtifactInput): boolean {
    const row = this.database.prepare(
      `SELECT w.root_path, s.workspace_id AS session_workspace_id,
              r.workspace_id AS run_workspace_id, r.session_id AS run_session_id,
              r.status AS run_status, r.event_sequence, r.completed_sequence,
              t.workspace_id AS task_workspace_id, t.session_id AS task_session_id,
              t.run_id AS task_run_id, t.status AS task_status,
              (SELECT COUNT(*) FROM tasks WHERE run_id = r.id) AS task_count
         FROM workspaces AS w
         JOIN sessions AS s ON s.workspace_id = w.id
         JOIN runs AS r ON r.workspace_id = w.id AND r.session_id = s.id
         JOIN tasks AS t ON t.workspace_id = w.id AND t.session_id = s.id AND t.run_id = r.id
        WHERE w.id = ? AND s.id = ? AND r.id = ? AND t.id = ?`,
    ).get(
      input.metadata.workspace_id,
      input.metadata.session_id,
      input.metadata.source_run_id,
      input.metadata.task_id,
    ) as Row | undefined
    if (row === undefined) {
      return false
    }
    const eventSequence = row.event_sequence
    const completedSequence = row.completed_sequence
    return typeof row.root_path === 'string'
      && row.root_path.length > 0
      && row.session_workspace_id === input.metadata.workspace_id
      && row.run_workspace_id === input.metadata.workspace_id
      && row.run_session_id === input.metadata.session_id
      && row.run_status === 'completed'
      && Number(row.task_count) === 1
      && row.task_workspace_id === input.metadata.workspace_id
      && row.task_session_id === input.metadata.session_id
      && row.task_run_id === input.metadata.source_run_id
      && row.task_status === 'completed'
      && typeof eventSequence === 'number'
      && Number.isSafeInteger(eventSequence)
      && typeof completedSequence === 'number'
      && Number.isSafeInteger(completedSequence)
      && completedSequence > 0
      && completedSequence <= eventSequence
  }
}

function toArtifactDto(row: Row): ArtifactDto | null {
  const parsed = artifactDtoSchema.safeParse({
    id: row.id,
    workspace_id: row.workspace_id,
    session_id: row.session_id,
    task_id: row.task_id,
    source_run_id: row.source_run_id,
    media_type: row.media_type,
    storage_kind: row.storage_kind,
    status: row.status,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    created_at: row.created_at,
  })
  return parsed.success ? parsed.data : null
}

function classifyReplay(row: Row, sourceRunId: string): CreateInlineArtifactResult {
  const metadata = toArtifactDto(row)
  if (metadata === null) {
    return { kind: 'source_unavailable' }
  }
  return metadata.source_run_id === sourceRunId
    ? { kind: 'replayed', metadata }
    : { kind: 'conflict' }
}

function assertValidInput(input: CreateInlineArtifactInput): void {
  const parsed = artifactDtoSchema.safeParse(input.metadata)
  if (
    !parsed.success
    || input.content.artifactId !== input.metadata.id
    || input.content.bytes.byteLength !== input.metadata.size_bytes
    || input.content.bytes.byteLength > 65_536
    || sha256(input.content.bytes) !== input.metadata.sha256
    || input.event.type !== 'artifact.created'
    || input.event.workspace_id !== input.metadata.workspace_id
    || input.event.session_id !== input.metadata.session_id
    || input.event.run_id !== input.metadata.source_run_id
  ) {
    throw new Error('invalid inline artifact persistence input')
  }
}

function metadataEvent(input: CreateInlineArtifactInput): Omit<EventEnvelope, 'sequence'> {
  return {
    ...input.event,
    payload: {
      artifact_id: input.metadata.id,
      task_id: input.metadata.task_id,
      source_run_id: input.metadata.source_run_id,
      media_type: input.metadata.media_type,
      storage_kind: input.metadata.storage_kind,
      status: input.metadata.status,
      size_bytes: input.metadata.size_bytes,
      sha256: input.metadata.sha256,
      created_at: input.metadata.created_at,
    },
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
