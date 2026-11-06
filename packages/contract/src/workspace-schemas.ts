import { z } from 'zod'

import { ARTIFACT_ERROR_CODES } from './artifact-schemas.js'
import { MAILBOX_ERROR_CODES } from './mailbox-schemas.js'
import { ERROR_CODES as BASE_ERROR_CODES, identifierSchema } from './schemas.js'

/** Workspace DTO；保留兼容现有 WorkspaceDto 的 root_path 独立资源。 */
export const workspaceRootPathDtoSchema = z
  .object({
    workspace_id: identifierSchema,
    root_path: z.string().min(1).nullable(),
  })
  .strict()
export type WorkspaceRootPathDto = z.infer<typeof workspaceRootPathDtoSchema>

/** 创建 Workspace 请求；root_path 是用户显式提供的服务端绝对路径。 */
export const createWorkspaceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    root_path: z.string().min(1).max(4_096),
  })
  .strict()
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>

/** 旧 Workspace 一次性补设请求。 */
export const setWorkspaceRootPathRequestSchema = z
  .object({ root_path: z.string().min(1).max(4_096) })
  .strict()
export type SetWorkspaceRootPathRequest = z.infer<typeof setWorkspaceRootPathRequestSchema>

/** Workspace 根目录配置流程的稳定错误码。 */
export const ERROR_CODES = {
  ...BASE_ERROR_CODES,
  ...ARTIFACT_ERROR_CODES,
  ...MAILBOX_ERROR_CODES,
  workspace_root_required: 'workspace_root_required',
  workspace_root_invalid: 'workspace_root_invalid',
  workspace_root_duplicate: 'workspace_root_duplicate',
  workspace_root_already_configured: 'workspace_root_already_configured',
} as const
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
