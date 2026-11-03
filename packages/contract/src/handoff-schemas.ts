import { z } from 'zod'

import { identifierSchema } from './schemas.js'

/** 从已完成 Run 发起 handoff 的请求；来源 Slot 与正文由服务端推导。 */
export const handoffRequestSchema = z
  .object({
    source_run_id: identifierSchema,
    target_slot_id: identifierSchema,
    request_id: identifierSchema,
  })
  .strict()
export type HandoffRequest = z.infer<typeof handoffRequestSchema>
