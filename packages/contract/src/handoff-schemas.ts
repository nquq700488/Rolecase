import { z } from 'zod'

import { identifierSchema } from './schemas.js'

/** 从已完成 Run 发起 handoff 的请求；单 Task 兼容省略来源 Task。 */
export const handoffRequestSchema = z
  .object({
    source_run_id: identifierSchema,
    source_task_id: identifierSchema.optional(),
    target_slot_id: identifierSchema,
    request_id: identifierSchema,
  })
  .strict()
export type HandoffRequest = z.infer<typeof handoffRequestSchema>
