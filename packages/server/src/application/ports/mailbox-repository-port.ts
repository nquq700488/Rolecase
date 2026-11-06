import type {
  EventEnvelope,
  MailboxMessageDetailDto,
  MailboxPageDto,
  MailboxPageQuery,
} from '@rolecast/contract'

/** 首次成功写入 read marker 后返回的事务结果。 */
export type MailboxReadResult =
  | { readonly kind: 'marked'; readonly read_at: string; readonly event: EventEnvelope }
  | { readonly kind: 'already_read'; readonly read_at: string }
  | { readonly kind: 'unavailable' }

/** Mailbox 所需的 Session/Slot 隔离持久化边界。 */
export interface MailboxRepositoryPort {
  /** 查询当前 Session/Slot 可见的 handoff 摘要页；归属或 cursor 无效时返回 null。 */
  listMailboxMessages(sessionId: string, query: MailboxPageQuery): Promise<MailboxPageDto | null>
  /** 查询单条可见 handoff 详情；不可见或不存在时返回 null。 */
  getMailboxMessage(sessionId: string, messageId: string, slotId: string): Promise<MailboxMessageDetailDto | null>
  /** 原子写入 read marker 与 metadata Event，重复标记不创建 Event。 */
  markMailboxMessageRead(input: {
    readonly session_id: string
    readonly message_id: string
    readonly slot_id: string
    readonly read_at: string
    readonly event_id: string
  }): Promise<MailboxReadResult>
}
