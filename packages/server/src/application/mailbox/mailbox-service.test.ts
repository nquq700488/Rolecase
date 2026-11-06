import { describe, expect, it } from 'vitest'

import type {
  EventEnvelope,
  MailboxMarkReadRequest,
  MailboxMessageDetailDto,
  MailboxPageDto,
  MailboxPageQuery,
} from '@rolecast/contract'

import { MailboxService } from './mailbox-service.js'
import type { MailboxRepositoryPort, MailboxReadResult } from '../ports/mailbox-repository-port.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { EventBusPort } from '../ports/event-bus-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'

const timestamp = '2026-11-04T12:00:00.000Z'
const summary = {
  id: 'message-1',
  session_id: 'session-1',
  sender_id: 'slot-sender',
  to_slot_id: 'slot-recipient',
  created_at: timestamp,
  status: 'unread',
  read_at: null,
} as const
const detail: MailboxMessageDetailDto = {
  message: {
    id: summary.id,
    session_id: summary.session_id,
    run_id: 'run-1',
    sender_kind: 'agent',
    sender_id: summary.sender_id,
    content: 'handoff body',
    created_at: timestamp,
    kind: 'handoff',
    to_slot_id: summary.to_slot_id,
  },
  status: 'unread',
  read_at: null,
}
const page: MailboxPageDto = { items: [summary], next_cursor: null }
const readEvent: EventEnvelope = {
  event_id: 'event-1',
  schema_version: 1,
  workspace_id: 'workspace-1',
  session_id: summary.session_id,
  run_id: 'run-1',
  sequence: 4,
  type: 'message.read',
  source: 'mailbox-service',
  occurred_at: timestamp,
  payload: { message_id: summary.id, recipient_slot_id: summary.to_slot_id, read_at: timestamp },
}

class FakeMailboxRepository implements MailboxRepositoryPort {
  readonly listCalls: Array<{ sessionId: string; query: MailboxPageQuery }> = []
  readonly detailCalls: Array<{ sessionId: string; messageId: string; slotId: string }> = []
  readonly markCalls: Parameters<MailboxRepositoryPort['markMailboxMessageRead']>[0][] = []
  pageResult: MailboxPageDto | null = page
  detailResult: MailboxMessageDetailDto | null = detail
  readResult: MailboxReadResult = { kind: 'marked', read_at: timestamp, event: readEvent }

  async listMailboxMessages(sessionId: string, query: MailboxPageQuery): Promise<MailboxPageDto | null> {
    this.listCalls.push({ sessionId, query })
    return this.pageResult
  }

  async getMailboxMessage(sessionId: string, messageId: string, slotId: string): Promise<MailboxMessageDetailDto | null> {
    this.detailCalls.push({ sessionId, messageId, slotId })
    return this.detailResult
  }

  async markMailboxMessageRead(input: Parameters<MailboxRepositoryPort['markMailboxMessageRead']>[0]): Promise<MailboxReadResult> {
    this.markCalls.push(input)
    return this.readResult
  }
}

class TestEventBus implements EventBusPort {
  readonly events: EventEnvelope[] = []
  fail = false

  async publish(event: EventEnvelope): Promise<void> {
    if (this.fail) {
      throw new Error('notification unavailable')
    }
    this.events.push(event)
  }

  subscribe(): () => void {
    return () => undefined
  }
}

const createService = (repository: FakeMailboxRepository, eventBus = new TestEventBus()) => {
  let idSequence = 0
  const ids: IdGeneratorPort = { next: (prefix) => `${prefix}-${++idSequence}` }
  const clock: ClockPort = { now: () => new Date(timestamp) }
  return { service: new MailboxService(repository, ids, clock, eventBus), eventBus }
}

describe('MailboxService', () => {
  it('按 Session 与 Slot 查询无正文摘要页', async () => {
    const repository = new FakeMailboxRepository()
    const { service } = createService(repository)

    const result = await service.list('session-1', { slot_id: 'slot-recipient', limit: 20, cursor: 'message-2' })

    expect(repository.listCalls).toEqual([{
      sessionId: 'session-1',
      query: { slot_id: 'slot-recipient', limit: 20, cursor: 'message-2' },
    }])
    expect(result).toEqual(page)
    expect(result.items[0]).not.toHaveProperty('content')
  })

  it('读取详情返回正文但不标记已读', async () => {
    const repository = new FakeMailboxRepository()
    const { service, eventBus } = createService(repository)

    const result = await service.get('session-1', 'message-1', 'slot-recipient')

    expect(result).toEqual(detail)
    expect(repository.detailCalls).toEqual([{ sessionId: 'session-1', messageId: 'message-1', slotId: 'slot-recipient' }])
    expect(repository.markCalls).toHaveLength(0)
    expect(eventBus.events).toHaveLength(0)
  })

  it('首次标记已读后发布 metadata-only Event', async () => {
    const repository = new FakeMailboxRepository()
    const { service, eventBus } = createService(repository)

    const result = await service.markRead('session-1', 'message-1', { slot_id: 'slot-recipient' } satisfies MailboxMarkReadRequest)

    expect(repository.markCalls).toEqual([{
      session_id: 'session-1',
      message_id: 'message-1',
      slot_id: 'slot-recipient',
      read_at: timestamp,
      event_id: 'event-1',
    }])
    expect(eventBus.events).toEqual([readEvent])
    expect(eventBus.events[0]?.payload).not.toHaveProperty('content')
    expect(result).toEqual({
      message_id: 'message-1',
      status: 'read',
      read_at: timestamp,
      event_bus_status: 'published',
    })
  })

  it('EventBus 失败仍返回已持久化的 read 状态', async () => {
    const repository = new FakeMailboxRepository()
    const eventBus = new TestEventBus()
    eventBus.fail = true
    const { service } = createService(repository, eventBus)

    const result = await service.markRead('session-1', 'message-1', { slot_id: 'slot-recipient' })

    expect(result).toMatchObject({ status: 'read', event_bus_status: 'failed' })
  })

  it('已读重放不重复发布 Event', async () => {
    const repository = new FakeMailboxRepository()
    repository.readResult = { kind: 'already_read', read_at: timestamp }
    const { service, eventBus } = createService(repository)

    const result = await service.markRead('session-1', 'message-1', { slot_id: 'slot-recipient' })

    expect(result).toEqual({
      message_id: 'message-1',
      status: 'read',
      read_at: timestamp,
      event_bus_status: 'not_attempted',
    })
    expect(eventBus.events).toHaveLength(0)
  })

  it('不可用列表目标返回统一 Mailbox 错误', async () => {
    const repository = new FakeMailboxRepository()
    repository.pageResult = null
    const { service } = createService(repository)

    await expect(service.list('session-1', { slot_id: 'missing-slot', limit: 50 })).rejects.toMatchObject({
      code: 'mailbox_message_unavailable', statusCode: 404,
    })
  })

  it('不可用详情不会泄露消息正文', async () => {
    const repository = new FakeMailboxRepository()
    repository.detailResult = null
    const { service } = createService(repository)

    await expect(service.get('session-1', 'missing-message', 'slot-recipient')).rejects.toMatchObject({
      code: 'mailbox_message_unavailable', statusCode: 404,
    })
  })

  it('不可用收件目标不能写入 read 状态', async () => {
    const repository = new FakeMailboxRepository()
    repository.readResult = { kind: 'unavailable' }
    const { service, eventBus } = createService(repository)

    await expect(service.markRead('session-1', 'other-session-message', { slot_id: 'slot-recipient' })).rejects.toMatchObject({
      code: 'mailbox_message_unavailable', statusCode: 404,
    })
    expect(eventBus.events).toHaveLength(0)
  })
})
