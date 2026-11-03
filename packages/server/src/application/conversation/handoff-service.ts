import type { AgentSlotDto, EventEnvelope, HandoffRequest, MessageDto } from '@rolecast/contract'

import { ApplicationError } from '../errors.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { EventBusPort } from '../ports/event-bus-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import type { HandoffSourceRecord, RepositoryPort } from '../ports/repository-port.js'
import { payloadText } from './conversation-payload.js'

/** 单次 handoff 正文上限（UTF-8 字节）。 */
export const HANDOFF_CONTENT_MAX_BYTES = 64 * 1024
/** 每页最多读取的事件数。 */
export const HANDOFF_PAGE_SIZE = 8

interface HandoffRecords {
  readonly message: MessageDto
  readonly event: Omit<EventEnvelope, 'sequence'>
}

/**
 * 从已完成 Run 的持久化 Agent 输出创建定向 handoff Message。
 *
 * 不创建 Run/Task/claim，不调用 Runtime；接收方文本不会自动进入 ACP Context。
 */
export class HandoffService {
  constructor(
    private readonly repository: RepositoryPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly eventBus: EventBusPort | null = null,
  ) {}

  /** 创建或幂等重放一个 handoff Message。 */
  async create(sessionId: string, input: HandoffRequest): Promise<MessageDto> {
    // 幂等重放必须先于可变来源/目标状态与正文重建：目标 Slot 软删除后仍可重放。
    const existing = await this.repository.getHandoffMessageByRequest(sessionId, input.request_id)
    if (existing !== null) {
      return replayExistingHandoff(existing, input)
    }
    const source = await this.requireSource(sessionId, input.source_run_id)
    const target = await this.requireTarget(sessionId, source.from_slot_id, input.target_slot_id)
    const content = await this.buildContent(source)
    const records = this.buildRecords(source, target, content)
    return this.persist(records, source, target, input.request_id)
  }

  private async requireSource(sessionId: string, runId: string): Promise<HandoffSourceRecord> {
    const source = await this.repository.getHandoffSource(sessionId, runId)
    if (source === null) {
      throw new ApplicationError('来源 Run 的持久化输出不可用', 'source_history_unavailable', 409)
    }
    return source
  }

  private async requireTarget(
    sessionId: string,
    fromSlotId: string,
    targetSlotId: string,
  ): Promise<AgentSlotDto> {
    const target = await this.repository.getAgentSlot(targetSlotId)
    if (target === null || target.session_id !== sessionId || target.id === fromSlotId) {
      throw new ApplicationError('目标 Slot 不可用', 'state_conflict', 409)
    }
    return target
  }

  private buildRecords(
    source: HandoffSourceRecord,
    target: AgentSlotDto,
    content: string,
  ): HandoffRecords {
    const now = this.clock.now().toISOString()
    const message: MessageDto = {
      id: this.ids.next('message'),
      session_id: source.run.session_id,
      run_id: source.run.id,
      sender_kind: 'agent',
      sender_id: source.from_slot_id,
      content,
      created_at: now,
      kind: 'handoff',
      to_slot_id: target.id,
    }
    const event: Omit<EventEnvelope, 'sequence'> = {
      event_id: this.ids.next('event'),
      schema_version: 1,
      workspace_id: source.run.workspace_id,
      session_id: source.run.session_id,
      run_id: source.run.id,
      type: 'message.created',
      source: 'conversation-service',
      occurred_at: now,
      payload: {
        message_id: message.id,
        kind: 'handoff',
        from_slot_id: source.from_slot_id,
        to_slot_id: target.id,
      },
    }
    return { message, event }
  }

  private async persist(
    records: HandoffRecords,
    source: HandoffSourceRecord,
    target: AgentSlotDto,
    requestId: string,
  ): Promise<MessageDto> {
    const result = await this.repository.createHandoffMessage({
      message: records.message,
      event: records.event,
      runId: source.run.id,
      fromSlotId: source.from_slot_id,
      toSlotId: target.id,
      requestId,
    })
    switch (result.kind) {
      case 'created':
        if (this.eventBus !== null) {
          await this.eventBus.publish(result.event)
        }
        return result.message
      case 'replayed':
        return result.message
      case 'conflict':
        throw new ApplicationError('同 request_id 的 handoff 参数不一致', 'state_conflict', 409)
      case 'invalid_target':
        throw new ApplicationError('目标 Slot 不可用', 'state_conflict', 409)
      case 'source_unavailable':
        throw new ApplicationError('来源 Run 的持久化输出不可用', 'source_history_unavailable', 409)
    }
  }

  /** 严格读取 `1..completed_sequence` 并拼接 Agent 文本。 */
  private async buildContent(source: HandoffSourceRecord): Promise<string> {
    const chunks: string[] = []
    let bytes = 0
    let after = 0
    while (after < source.completed_sequence) {
      // 严格止于 completed_sequence：不读取完成后的 handoff metadata Event。
      const remaining = Math.max(1, Math.min(HANDOFF_PAGE_SIZE, source.completed_sequence - after))
      const page = await this.repository.readRunEventPage(source.run.id, after, remaining)
      if (page.kind === 'too_large') {
        throw new ApplicationError('来源事件过大', 'source_event_payload_too_large', 413)
      }
      if (page.kind === 'inconsistent' || page.events.length === 0) {
        throw new ApplicationError('来源 Run 的持久化输出不可用', 'source_history_unavailable', 409)
      }
      if (page.nextSequence > source.completed_sequence) {
        throw new ApplicationError('来源 Run 的持久化输出不可用', 'source_history_unavailable', 409)
      }
      for (const event of page.events) {
        if (event.type !== 'agent.message') {
          continue
        }
        const text = payloadText(event.payload)
        if (text === null) {
          continue
        }
        bytes += Buffer.byteLength(text, 'utf8')
        if (bytes > HANDOFF_CONTENT_MAX_BYTES) {
          throw new ApplicationError('交接正文超出上限', 'handoff_content_too_large', 413)
        }
        chunks.push(text)
      }
      after = page.nextSequence
    }
    if (after !== source.completed_sequence) {
      throw new ApplicationError('来源 Run 的持久化输出不可用', 'source_history_unavailable', 409)
    }
    const content = chunks.join('')
    if (content.length === 0) {
      throw new ApplicationError('来源 Run 没有可交接的 Agent 输出', 'source_history_unavailable', 409)
    }
    return content
  }
}

/** 既有 handoff 的参数必须与当前请求一致，否则 409。 */
function replayExistingHandoff(message: MessageDto, input: HandoffRequest): MessageDto {
  if (
    message.kind !== 'handoff'
    || message.run_id !== input.source_run_id
    || message.to_slot_id !== input.target_slot_id
  ) {
    throw new ApplicationError('同 request_id 的 handoff 参数不一致', 'state_conflict', 409)
  }
  return message
}
