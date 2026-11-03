import type { EventEnvelope } from '@rolecast/contract'

/** 领域事件实时发布边界。 */
export interface EventBusPort {
  /** 发布已持久化的事件。 */
  publish(event: EventEnvelope): Promise<void>
  /** 订阅事件并返回取消订阅函数。 */
  subscribe(handler: (event: EventEnvelope) => void): () => void
}
