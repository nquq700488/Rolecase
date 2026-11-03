import { isJsonRpcRequestId } from '@rolecast/contract'

/** JSON-RPC request ID 的合法取值；域由 Contract 的 `isJsonRpcRequestId` 唯一定义。 */
export type JsonRpcRequestId = string | number

/**
 * SQLite 中保存 JSON-RPC request ID 的带标签编码前缀。
 *
 * 必须带标签：如果写成裸 `"1"`，读取时无法区分原始 number `1` 与 string `"1"`，
 * 会把 ID 身份静默折叠成同一种类型。旧列 `adapter_request_id` 正是这样丢失类型的，
 * 因此新列 `adapter_request_id_encoded` 一律使用带标签格式。
 */
const NUMBER_PREFIX = 'n:'
const STRING_PREFIX = 's:'

/**
 * @name encodeJsonRpcRequestId
 * @description 把 JSON-RPC request ID 编码为可往返恢复类型的 SQLite 文本
 * @param {JsonRpcRequestId} value request ID
 * @return {string} 带类型标签的文本
 * @throws {RangeError} ID 不在 Contract 合法域内（空 string、小数、超安全整数等）
 * @example
 * encodeJsonRpcRequestId(1) // 'n:1'
 * encodeJsonRpcRequestId('1') // 's:1'
 */
export function encodeJsonRpcRequestId(value: JsonRpcRequestId): string {
  // 入口就拒绝非法域：先编码再让 SQLite 丢类型会留下不可应答的 pending。
  if (!isJsonRpcRequestId(value)) {
    throw new RangeError('request id must be a non-empty string or a safe integer')
  }
  return typeof value === 'number' ? `${NUMBER_PREFIX}${value}` : `${STRING_PREFIX}${value}`
}

/**
 * @name decodeJsonRpcRequestId
 * @description 从 SQLite 文本恢复 JSON-RPC request ID 的类型身份
 * @param {unknown} value SQLite 列值
 * @return {JsonRpcRequestId | null} 恢复后的 ID；空值或非法编码返回 null
 * @example
 * decodeJsonRpcRequestId('n:1') // 1
 * decodeJsonRpcRequestId('s:1') // '1'
 */
export function decodeJsonRpcRequestId(value: unknown): JsonRpcRequestId | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null
  }
  if (value.startsWith(NUMBER_PREFIX)) {
    return decodeNumber(value.slice(NUMBER_PREFIX.length))
  }
  if (value.startsWith(STRING_PREFIX)) {
    const text = value.slice(STRING_PREFIX.length)
    return text.length === 0 ? null : text
  }
  // 没有标签的值不猜测类型：宁可让调用方 fail-closed，也不把损坏数据当合法 ID。
  return null
}

/** 解析标签内的数字；非法整数返回 null，避免把损坏数据当成合法 ID。 */
function decodeNumber(text: string): number | null {
  const normalized = text.startsWith('-') ? text.slice(1) : text
  if (!/^\d+$/.test(normalized)) {
    return null
  }
  const parsed = Number(text)
  return Number.isSafeInteger(parsed) ? parsed : null
}
