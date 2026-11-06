import { z } from 'zod'

import { identifierSchema, isoDateTimeSchema } from './schemas.js'

/** Artifact API 的稳定错误码。 */
export const ARTIFACT_ERROR_CODES = {
  artifact_too_large: 'artifact_too_large',
  workspace_root_unconfigured: 'workspace_root_unconfigured',
  workspace_root_unavailable: 'workspace_root_unavailable',
  artifact_request_conflict: 'artifact_request_conflict',
  artifact_unavailable: 'artifact_unavailable',
  artifact_sanitization_failed: 'artifact_sanitization_failed',
} as const
export type ArtifactErrorCode = (typeof ARTIFACT_ERROR_CODES)[keyof typeof ARTIFACT_ERROR_CODES]

/** inline Artifact 的 UTF-8 字节上限。 */
export const ARTIFACT_INLINE_MAX_SIZE_BYTES = 65_536

const artifactMediaTypeSchema = z.literal('text/plain; charset=utf-8')
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

/** Artifact 创建请求 Schema。 */
export const createArtifactRequestSchema = z
  .object({
    source_run_id: identifierSchema,
    request_id: identifierSchema,
  })
  .strict()
export type ArtifactCreateRequest = z.infer<typeof createArtifactRequestSchema>

/** Artifact 路由的 Session 参数。 */
export const artifactSessionParamsSchema = z.object({ sessionId: identifierSchema }).strict()

/** Artifact 读取路由的 Session 与 Artifact 参数。 */
export const artifactParamsSchema = z
  .object({ sessionId: identifierSchema, artifactId: identifierSchema })
  .strict()

/** Artifact metadata DTO Schema；不包含正文或存储路径。 */
export const artifactDtoSchema = z
  .object({
    id: identifierSchema,
    workspace_id: identifierSchema,
    session_id: identifierSchema,
    task_id: identifierSchema,
    source_run_id: identifierSchema,
    media_type: artifactMediaTypeSchema,
    storage_kind: z.literal('inline'),
    status: z.literal('ready'),
    size_bytes: z.number().int().min(0).max(ARTIFACT_INLINE_MAX_SIZE_BYTES),
    sha256: sha256Schema,
    created_at: isoDateTimeSchema,
  })
  .strict()
export type ArtifactDto = z.infer<typeof artifactDtoSchema>

/** Artifact 列表页；仅携带 metadata。 */
export const artifactPageDtoSchema = z
  .object({
    items: z.array(artifactDtoSchema).max(100),
    next_cursor: identifierSchema.nullable(),
  })
  .strict()
export type ArtifactPageDto = z.infer<typeof artifactPageDtoSchema>

/** Artifact 列表查询参数；限制为有界 keyset 分页。 */
export const artifactPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: identifierSchema.optional(),
  })
  .strict()
export type ArtifactPageQuery = z.infer<typeof artifactPageQuerySchema>

/** Artifact 正文响应 Schema；与 metadata 分离。 */
export const artifactContentDtoSchema = z
  .object({
    artifact_id: identifierSchema,
    media_type: artifactMediaTypeSchema,
    content: z.string(),
  })
  .strict()
export type ArtifactContentDto = z.infer<typeof artifactContentDtoSchema>
