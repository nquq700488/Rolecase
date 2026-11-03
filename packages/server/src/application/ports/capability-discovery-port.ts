import type { CapabilitySnapshot } from '@rolecast/contract'

import type { AgentRuntimeConnectionInput } from './agent-runtime-port.js'

/** ACP 能力发现 Port。 */
export interface CapabilityDiscoveryPort {
  /** 启动 Adapter、完成握手并返回规范化能力快照。 */
  discover(input: AgentRuntimeConnectionInput): Promise<CapabilitySnapshot>
}
