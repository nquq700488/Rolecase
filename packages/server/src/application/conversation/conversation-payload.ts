import { isJsonRpcRequestId } from '@rolecast/contract'
import type {
  EventEnvelope,
  RunCommandReceipt,
  RuntimeEvent,
} from '@rolecast/contract'

import type { CommandReceiptRecord } from '../ports/repository-port.js'

export const eventType = (event: RuntimeEvent): EventEnvelope['type'] => {
  switch (event.kind) {
    case 'agent_message_chunk':
      return 'agent.message'
    case 'agent_thought_chunk':
      return 'agent.thought'
    case 'permission_requested':
      return 'agent.permission_requested'
    case 'turn_completed':
      return 'run.completed'
    case 'turn_cancelled':
      return 'run.cancelled'
    case 'adapter_crashed':
      return 'run.failed'
    default:
      return 'agent.update'
  }
}

export const payloadText = (payload: Readonly<Record<string, unknown>>): string | null => {
  const text = readText(payload.text) ?? readText(payload.content)
  return text === null || text.length === 0 ? null : text
}

const readText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    const parts = value.map(readText).filter((part): part is string => part !== null)
    return parts.length === 0 ? null : parts.join('')
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  return readText(record.text) ?? readText(record.content)
}

export const payloadString = (
  payload: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null => {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  return null
}

/** 把内部回执压成公共 DTO：不包含 dispatch_state 或输入引用。 */
export const toReceiptDto = (receipt: CommandReceiptRecord): RunCommandReceipt => ({
  request_id: receipt.request_id,
  status: receipt.status,
  ...(receipt.run_id === undefined ? {} : { run_id: receipt.run_id }),
  ...(receipt.task_id === undefined ? {} : { task_id: receipt.task_id }),
  ...(receipt.error_code === undefined ? {} : { error_code: receipt.error_code }),
})

/** 只保留稳定错误码，不携带原始异常。 */
export const errorCodeOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return /^[a-z][a-z0-9_]*$/.test(error.code) ? error.code : 'adapter_start_failed'
  }
  return 'adapter_start_failed'
}

/**
 * 读取 Adapter 的 JSON-RPC request ID，保留 number / string 类型身份。
 *
 * 不做 `String()` 归一：number `1` 与 string `"1"` 是两个不同请求，
 * 折叠后会把应答发给错误的权限请求。合法域复用 Contract 的
 * `isJsonRpcRequestId`，与 ACP ingress、Runtime 和 SQLite codec 保持一致。
 */
export const payloadRequestId = (payload: Readonly<Record<string, unknown>>): string | number | null => {
  const value = payload.request_id ?? payload.requestId
  return isJsonRpcRequestId(value) ? value : null
}
