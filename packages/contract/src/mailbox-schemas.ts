import { z } from 'zod'

import { identifierSchema, isoDateTimeSchema, messageDtoSchema } from './schemas.js'

/** Mailbox API 的稳定错误码。 */
export const MAILBOX_ERROR_CODES = {
  mailbox_message_unavailable: 'mailbox_message_unavailable',
} as const

/** Mailbox 收件状态。 */
export const mailboxMessageStatusSchema = z.enum(['unread', 'read'])
export type MailboxMessageStatus = z.infer<typeof mailboxMessageStatusSchema>

const mailboxReadStateShape = {
  status: mailboxMessageStatusSchema,
  read_at: isoDateTimeSchema.nullable(),
}

function hasConsistentReadState(value: { status: MailboxMessageStatus; read_at: string | null }): boolean {
  return (value.status === 'unread' && value.read_at === null)
    || (value.status === 'read' && value.read_at !== null)
}

/** Mailbox 列表摘要；不包含 Message 正文。 */
export const mailboxMessageSummaryDtoSchema = z
  .object({
    id: identifierSchema,
    session_id: identifierSchema,
    sender_id: identifierSchema,
    to_slot_id: identifierSchema,
    created_at: isoDateTimeSchema,
    ...mailboxReadStateShape,
  })
  .strict()
  .refine(hasConsistentReadState, { message: 'Mailbox read_at must match status' })
export type MailboxMessageSummaryDto = z.infer<typeof mailboxMessageSummaryDtoSchema>

/** Mailbox 有界分页响应。 */
export const mailboxPageDtoSchema = z
  .object({
    items: z.array(mailboxMessageSummaryDtoSchema),
    next_cursor: identifierSchema.nullable(),
  })
  .strict()
export type MailboxPageDto = z.infer<typeof mailboxPageDtoSchema>

/** Mailbox 查询参数；服务端只允许有限的 keyset 页大小。 */
export const mailboxPageQuerySchema = z
  .object({
    slot_id: identifierSchema,
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: identifierSchema.optional(),
  })
  .strict()
export type MailboxPageQuery = z.infer<typeof mailboxPageQuerySchema>

/** Mailbox 列表路由参数。 */
export const mailboxParamsSchema = z.object({ sessionId: identifierSchema }).strict()

/** Mailbox 详情与标记已读路由参数。 */
export const mailboxMessageParamsSchema = z
  .object({ sessionId: identifierSchema, messageId: identifierSchema })
  .strict()

/** 单条 handoff 详情；正文只在此 DTO 中返回。 */
export const mailboxMessageDetailDtoSchema = z
  .object({
    message: messageDtoSchema,
    ...mailboxReadStateShape,
  })
  .strict()
  .superRefine((value, context) => {
    if (!hasConsistentReadState(value)) {
      context.addIssue({ code: 'custom', path: ['read_at'], message: 'Mailbox read_at must match status' })
    }
    if (value.message.kind !== 'handoff' || value.message.to_slot_id === undefined) {
      context.addIssue({ code: 'custom', path: ['message'], message: 'Mailbox detail must be a handoff' })
    }
  })
export type MailboxMessageDetailDto = z.infer<typeof mailboxMessageDetailDtoSchema>

/** 显式标记 Mailbox 消息已读的请求。 */
export const mailboxMarkReadRequestSchema = z.object({ slot_id: identifierSchema }).strict()
export type MailboxMarkReadRequest = z.infer<typeof mailboxMarkReadRequestSchema>

/** mark-read 的持久化状态与 best-effort EventBus 结果。 */
export const mailboxMarkReadDtoSchema = z
  .object({
    message_id: identifierSchema,
    status: z.literal('read'),
    read_at: isoDateTimeSchema,
    event_bus_status: z.enum(['published', 'failed', 'not_attempted']),
  })
  .strict()
export type MailboxMarkReadDto = z.infer<typeof mailboxMarkReadDtoSchema>

/** `message.read` 的 metadata-only payload。 */
export const mailboxMessageReadEventPayloadSchema = z
  .object({
    message_id: identifierSchema,
    recipient_slot_id: identifierSchema,
    read_at: isoDateTimeSchema,
  })
  .strict()
export type MailboxMessageReadEventPayload = z.infer<typeof mailboxMessageReadEventPayloadSchema>
