import { createHash } from 'node:crypto'

import type {
  ArtifactContentDto,
  ArtifactCreateRequest,
  ArtifactDto,
  ArtifactPageDto,
  ArtifactPageQuery,
  EventEnvelope,
} from '@rolecast/contract'

import { createInlineArtifactContent, MAX_INLINE_ARTIFACT_SIZE_BYTES } from '../../domain/index.js'
import { ApplicationError } from '../errors.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { EventBusPort } from '../ports/event-bus-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import type { RepositoryPort, HandoffSourceRecord } from '../ports/repository-port.js'
import type { ArtifactStorePort, CreateInlineArtifactResult } from '../ports/artifact-store-port.js'
import type { WorkspaceRootPathPort } from '../ports/workspace-root-path-port.js'
import type { SecretRedactionPort } from '../ports/credential-store-port.js'
import { payloadText } from '../conversation/conversation-payload.js'

const ARTIFACT_PAGE_SIZE = 8
const UTF8 = new TextEncoder()

/** 创建并读取 SQLite inline Artifact 的应用服务。 */
export class ArtifactService {
  constructor(
    private readonly repository: Pick<
      RepositoryPort,
      'getSession' | 'getWorkspaceRootPath' | 'getHandoffSource' | 'readRunEventPage'
    >,
    private readonly store: ArtifactStorePort,
    private readonly rootPaths: WorkspaceRootPathPort | null,
    private readonly redaction: Pick<SecretRedactionPort, 'redact'> | null,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly eventBus: EventBusPort | null = null,
  ) {}

  /** 从同 Session 的 completed Run 唯一已完成 Task 创建脱敏 Artifact。 */
  async create(sessionId: string, input: ArtifactCreateRequest): Promise<ArtifactDto> {
    const existing = await this.store.findByRequest(sessionId, input.request_id)
    if (existing !== null) {
      return this.replay(existing, sessionId, input.source_run_id)
    }

    const session = await this.repository.getSession(sessionId)
    if (session === null) {
      throw new ApplicationError('Session 不可用', 'not_found', 404)
    }
    await this.requireWorkspaceRoot(session.workspace_id)

    const source = await this.requireSource(sessionId, session.workspace_id, input.source_run_id)
    const sourceText = await this.readSourceText(source)
    const content = this.redact(sourceText)
    const bytes = UTF8.encode(content)
    if (bytes.byteLength > MAX_INLINE_ARTIFACT_SIZE_BYTES) {
      throw this.tooLargeError()
    }
    if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== content) {
      throw this.sanitizationError()
    }

    const artifactId = this.ids.next('artifact')
    const createdAt = this.clock.now().toISOString()
    const privateContent = createInlineArtifactContent({ artifactId, bytes })
    const metadata: ArtifactDto = {
      id: artifactId,
      workspace_id: session.workspace_id,
      session_id: sessionId,
      task_id: source.task.id,
      source_run_id: source.run.id,
      media_type: 'text/plain; charset=utf-8',
      storage_kind: 'inline',
      status: 'ready',
      size_bytes: privateContent.bytes.byteLength,
      sha256: sha256(privateContent.bytes),
      created_at: createdAt,
    }
    const event = this.createEvent(metadata, createdAt)
    const result = await this.store.create({
      metadata,
      content: privateContent,
      event,
      requestId: input.request_id,
    })
    return this.resolveCreateResult(result, sessionId, input.source_run_id)
  }

  /** 先验证 Session，再按 Workspace + Session 范围读取 metadata 分页。 */
  async list(sessionId: string, query: ArtifactPageQuery): Promise<ArtifactPageDto> {
    const session = await this.repository.getSession(sessionId)
    if (session === null) {
      throw new ApplicationError('Session 不存在', 'not_found', 404)
    }
    const page = await this.store.listMetadata(session.workspace_id, sessionId, query)
    if (page === null) {
      throw this.unavailableError()
    }
    return page
  }

  /** 按 Session 读取 Artifact metadata；不存在与跨 Session 统一隐藏。 */
  async getMetadata(sessionId: string, artifactId: string): Promise<ArtifactDto> {
    const metadata = await this.store.getMetadata(sessionId, artifactId)
    if (metadata === null || metadata.session_id !== sessionId) {
      throw this.unavailableError()
    }
    return metadata
  }

  /** 校验持久化字节长度和摘要后返回 UTF-8 文本。 */
  async getContent(sessionId: string, artifactId: string): Promise<ArtifactContentDto> {
    const record = await this.store.getContent(sessionId, artifactId)
    if (
      record === null
      || record.metadata.session_id !== sessionId
      || record.content.artifactId !== record.metadata.id
      || record.content.bytes.byteLength !== record.metadata.size_bytes
      || record.content.bytes.byteLength > MAX_INLINE_ARTIFACT_SIZE_BYTES
      || sha256(record.content.bytes) !== record.metadata.sha256
    ) {
      throw this.unavailableError()
    }
    try {
      return {
        artifact_id: record.metadata.id,
        media_type: record.metadata.media_type,
        content: new TextDecoder('utf-8', { fatal: true }).decode(record.content.bytes),
      }
    } catch {
      throw this.unavailableError()
    }
  }

  private replay(metadata: ArtifactDto, sessionId: string, sourceRunId: string): ArtifactDto {
    if (metadata.session_id !== sessionId) {
      throw this.unavailableError()
    }
    if (metadata.source_run_id !== sourceRunId) {
      throw this.requestConflictError()
    }
    return metadata
  }

  private async requireWorkspaceRoot(workspaceId: string): Promise<void> {
    const rootPath = await this.repository.getWorkspaceRootPath(workspaceId)
    if (rootPath === null || rootPath.root_path === null) {
      throw new ApplicationError('Workspace 尚未配置根目录', 'workspace_root_unconfigured', 409)
    }
    if (this.rootPaths === null) {
      throw new ApplicationError('Workspace 根目录不可用', 'workspace_root_unavailable', 409)
    }
    let canonicalPath: string
    try {
      canonicalPath = await this.rootPaths.resolveExistingDirectory(rootPath.root_path)
    } catch {
      throw new ApplicationError('Workspace 根目录不可用', 'workspace_root_unavailable', 409)
    }
    if (typeof canonicalPath !== 'string' || canonicalPath !== rootPath.root_path) {
      throw new ApplicationError('Workspace 根目录不可用', 'workspace_root_unavailable', 409)
    }
  }

  private async requireSource(
    sessionId: string,
    workspaceId: string,
    runId: string,
  ): Promise<HandoffSourceRecord> {
    const source = await this.repository.getHandoffSource(sessionId, runId)
    if (
      source === null
      || source.run.id !== runId
      || source.run.session_id !== sessionId
      || source.run.workspace_id !== workspaceId
      || source.run.status !== 'completed'
      || !Number.isSafeInteger(source.completed_sequence)
      || source.completed_sequence <= 0
      || source.task.run_id !== source.run.id
      || source.task.session_id !== sessionId
      || source.task.workspace_id !== workspaceId
      || source.task.status !== 'completed'
    ) {
      throw this.sourceUnavailableError()
    }
    return source
  }

  private async readSourceText(source: HandoffSourceRecord): Promise<string> {
    const chunks: string[] = []
    let sizeBytes = 0
    let afterSequence = 0
    while (afterSequence < source.completed_sequence) {
      const remaining = Math.min(ARTIFACT_PAGE_SIZE, source.completed_sequence - afterSequence)
      const page = await this.repository.readRunEventPage(source.run.id, afterSequence, remaining)
      if (page.kind !== 'ok' || page.events.length === 0 || page.events.length > remaining) {
        throw this.sourceUnavailableError()
      }
      let expectedSequence = afterSequence + 1
      for (const event of page.events) {
        if (
          event.sequence !== expectedSequence
          || event.run_id !== source.run.id
          || event.session_id !== source.run.session_id
          || event.workspace_id !== source.run.workspace_id
        ) {
          throw this.sourceUnavailableError()
        }
        expectedSequence += 1
        if (event.type !== 'agent.message') {
          continue
        }
        const text = payloadText(event.payload)
        if (text === null) {
          continue
        }
        sizeBytes += UTF8.encode(text).byteLength
        if (sizeBytes > MAX_INLINE_ARTIFACT_SIZE_BYTES) {
          throw this.tooLargeError()
        }
        chunks.push(text)
      }
      const nextSequence = expectedSequence - 1
      if (page.nextSequence !== nextSequence || nextSequence <= afterSequence) {
        throw this.sourceUnavailableError()
      }
      afterSequence = nextSequence
    }
    const content = chunks.join('')
    if (afterSequence !== source.completed_sequence || content.length === 0) {
      throw this.sourceUnavailableError()
    }
    return content
  }

  private redact(content: string): string {
    if (this.redaction === null) {
      throw this.sanitizationError()
    }
    let sanitized: unknown
    try {
      sanitized = this.redaction.redact(content)
    } catch {
      throw this.sanitizationError()
    }
    if (typeof sanitized !== 'string') {
      throw this.sanitizationError()
    }
    return sanitized
  }

  private createEvent(metadata: ArtifactDto, occurredAt: string): Omit<EventEnvelope, 'sequence'> {
    return {
      event_id: this.ids.next('event'),
      schema_version: 1,
      workspace_id: metadata.workspace_id,
      session_id: metadata.session_id,
      run_id: metadata.source_run_id,
      type: 'artifact.created',
      source: 'artifact-service',
      occurred_at: occurredAt,
      payload: {
        artifact_id: metadata.id,
        task_id: metadata.task_id,
        source_run_id: metadata.source_run_id,
        media_type: metadata.media_type,
        storage_kind: metadata.storage_kind,
        status: metadata.status,
        size_bytes: metadata.size_bytes,
        sha256: metadata.sha256,
        created_at: metadata.created_at,
      },
    }
  }

  private async resolveCreateResult(
    result: CreateInlineArtifactResult,
    sessionId: string,
    sourceRunId: string,
  ): Promise<ArtifactDto> {
    switch (result.kind) {
      case 'created':
        if (this.eventBus !== null) {
          await this.eventBus.publish(result.event)
        }
        return result.metadata
      case 'replayed':
        return this.replay(result.metadata, sessionId, sourceRunId)
      case 'conflict':
        throw this.requestConflictError()
      case 'source_unavailable':
        throw this.sourceUnavailableError()
    }
  }

  private sourceUnavailableError(): ApplicationError {
    return new ApplicationError('来源 Run 的持久化输出不可用', 'source_history_unavailable', 409)
  }

  private tooLargeError(): ApplicationError {
    return new ApplicationError('Artifact 内容超过 65,536 UTF-8 字节', 'artifact_too_large', 413)
  }

  private requestConflictError(): ApplicationError {
    return new ApplicationError('同一 request_id 已用于不同来源', 'artifact_request_conflict', 409)
  }

  private unavailableError(): ApplicationError {
    return new ApplicationError('Artifact 不可用', 'artifact_unavailable', 404)
  }

  private sanitizationError(): ApplicationError {
    return new ApplicationError('Artifact 内容脱敏失败', 'artifact_sanitization_failed', 500)
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
