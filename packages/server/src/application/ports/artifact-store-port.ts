import type { ArtifactDto, ArtifactPageDto, ArtifactPageQuery, EventEnvelope } from '@rolecast/contract'

import type { ArtifactPrivateContent } from '../../domain/index.js'

/** Artifact 写入事务的跨层输入；metadata Event 不包含正文。 */
export interface CreateInlineArtifactInput {
  readonly metadata: ArtifactDto
  readonly content: ArtifactPrivateContent
  readonly event: Omit<EventEnvelope, 'sequence'>
  readonly requestId: string
}

/** 原子 Artifact 写入结果。 */
export type CreateInlineArtifactResult =
  | { readonly kind: 'created'; readonly metadata: ArtifactDto; readonly event: EventEnvelope }
  | { readonly kind: 'replayed'; readonly metadata: ArtifactDto }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'source_unavailable' }

/** 从持久层读取的 Artifact 私有正文；调用方必须在解码前校验完整性。 */
export interface ArtifactContentRecord {
  readonly metadata: ArtifactDto
  readonly content: ArtifactPrivateContent
}

/** SQLite inline Artifact 的原子持久化与 Session-scoped 读取边界。 */
export interface ArtifactStorePort {
  /** 按 Session 与 request ID 查找幂等结果。 */
  findByRequest(sessionId: string, requestId: string): Promise<ArtifactDto | null>
  /** 原子写入 Artifact、正文与 completed-Run metadata Event。 */
  create(input: CreateInlineArtifactInput): Promise<CreateInlineArtifactResult>
  /** 在 Workspace 与 Session 范围内读取 metadata-only keyset 分页；cursor 不可用时返回 null。 */
  listMetadata(workspaceId: string, sessionId: string, query: ArtifactPageQuery): Promise<ArtifactPageDto | null>
  /** 仅按 Session 读取公开元数据。 */
  getMetadata(sessionId: string, artifactId: string): Promise<ArtifactDto | null>
  /** 按 Session 读取 metadata 与私有正文。 */
  getContent(sessionId: string, artifactId: string): Promise<ArtifactContentRecord | null>
}
