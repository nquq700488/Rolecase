import type {
  MailboxMarkReadDto,
  MailboxMarkReadRequest,
  MailboxMessageDetailDto,
  MailboxPageDto,
  MailboxPageQuery,
} from '@rolecast/contract'

import { ApplicationError } from '../errors.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { EventBusPort } from '../ports/event-bus-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import type { MailboxRepositoryPort } from '../ports/mailbox-repository-port.js'

/** Session 内定向 handoff 收件查询与显式已读用例。 */
export class MailboxService {
  constructor(
    private readonly repository: MailboxRepositoryPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly eventBus: EventBusPort | null = null,
  ) {}

  /** 查询不含正文的分页摘要。 */
  async list(sessionId: string, query: MailboxPageQuery): Promise<MailboxPageDto> {
    const page = await this.repository.listMailboxMessages(sessionId, query)
    if (page === null) {
      throw this.unavailable()
    }
    return page
  }

  /** 读取单条正文详情；读取本身不会改变收件状态。 */
  async get(sessionId: string, messageId: string, slotId: string): Promise<MailboxMessageDetailDto> {
    const detail = await this.repository.getMailboxMessage(sessionId, messageId, slotId)
    if (detail === null) {
      throw this.unavailable()
    }
    return detail
  }

  /** 显式标记已读；提交后的 EventBus 通知失败不回滚持久化状态。 */
  async markRead(
    sessionId: string,
    messageId: string,
    request: MailboxMarkReadRequest,
  ): Promise<MailboxMarkReadDto> {
    const result = await this.repository.markMailboxMessageRead({
      session_id: sessionId,
      message_id: messageId,
      slot_id: request.slot_id,
      read_at: this.clock.now().toISOString(),
      event_id: this.ids.next('event'),
    })
    if (result.kind === 'unavailable') {
      throw this.unavailable()
    }

    let eventBusStatus: MailboxMarkReadDto['event_bus_status'] = 'not_attempted'
    if (result.kind === 'marked' && this.eventBus !== null) {
      try {
        await this.eventBus.publish(result.event)
        eventBusStatus = 'published'
      } catch {
        eventBusStatus = 'failed'
      }
    }
    return {
      message_id: messageId,
      status: 'read',
      read_at: result.read_at,
      event_bus_status: eventBusStatus,
    }
  }

  private unavailable(): ApplicationError {
    return new ApplicationError('Mailbox 消息不可用', 'mailbox_message_unavailable', 404)
  }
}
