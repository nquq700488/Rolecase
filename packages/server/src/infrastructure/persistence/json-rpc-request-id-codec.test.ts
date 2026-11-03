import { describe, expect, it } from 'vitest'

import {
  decodeJsonRpcRequestId,
  encodeJsonRpcRequestId,
} from './json-rpc-request-id-codec.js'

describe('JSON-RPC request ID codec', () => {
  it('number 与 string 往返后保持各自类型', () => {
    expect(encodeJsonRpcRequestId(1)).toBe('n:1')
    expect(encodeJsonRpcRequestId('1')).toBe('s:1')
    expect(decodeJsonRpcRequestId('n:1')).toBe(1)
    expect(decodeJsonRpcRequestId('s:1')).toBe('1')
    expect(typeof decodeJsonRpcRequestId('n:1')).toBe('number')
    expect(typeof decodeJsonRpcRequestId('s:1')).toBe('string')
  })

  it('覆盖零、负数、大整数和含冒号或数字样式的 string', () => {
    for (const value of [0, 42, -7, Number.MAX_SAFE_INTEGER]) {
      expect(decodeJsonRpcRequestId(encodeJsonRpcRequestId(value))).toBe(value)
    }
    for (const value of ['0', '07', 'n:1', 's:1', 'hello world', '请求-1']) {
      expect(decodeJsonRpcRequestId(encodeJsonRpcRequestId(value))).toBe(value)
    }
  })

  it('拒绝无标签、空标签和非法数字，不猜测类型', () => {
    expect(decodeJsonRpcRequestId('1')).toBeNull()
    expect(decodeJsonRpcRequestId('n:')).toBeNull()
    expect(decodeJsonRpcRequestId('s:')).toBeNull()
    expect(decodeJsonRpcRequestId('n:1.5')).toBeNull()
    expect(decodeJsonRpcRequestId('n:abc')).toBeNull()
    expect(decodeJsonRpcRequestId('n:1e3')).toBeNull()
    expect(decodeJsonRpcRequestId('')).toBeNull()
    expect(decodeJsonRpcRequestId(null)).toBeNull()
    expect(decodeJsonRpcRequestId(1)).toBeNull()
  })

  it('拒绝超出安全整数范围的数字', () => {
    expect(decodeJsonRpcRequestId(`n:${Number.MAX_SAFE_INTEGER + 1}`)).toBeNull()
  })

  it('encode 拒绝非法 number / string，避免写入后才丢类型', () => {
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => encodeJsonRpcRequestId(value)).toThrow(RangeError)
    }
    expect(() => encodeJsonRpcRequestId('')).toThrow(RangeError)
  })

  it('encode 接受负 safe integer、最大 safe integer 与非空 string', () => {
    for (const value of [0, -1, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
      expect(decodeJsonRpcRequestId(encodeJsonRpcRequestId(value))).toBe(value)
    }
    for (const value of ['a', '0', ' ', 'n:x']) {
      expect(decodeJsonRpcRequestId(encodeJsonRpcRequestId(value))).toBe(value)
    }
  })
})
