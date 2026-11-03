import type { EventEnvelope } from '@rolecast/contract'

import type { EventBusPort } from '../../application/ports/event-bus-port.js'

/** 进程内事件总线，事件必须先由 Repository 持久化。 */
export class InProcessEventBus implements EventBusPort {
  private readonly handlers = new Set<(event: EventEnvelope) => void>()

  async publish(event: EventEnvelope): Promise<void> {
    for (const handler of this.handlers) {
      handler(event)
    }
  }

  subscribe(handler: (event: EventEnvelope) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }
}
