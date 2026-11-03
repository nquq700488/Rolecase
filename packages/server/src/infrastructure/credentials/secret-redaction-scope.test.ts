import { describe, expect, it } from 'vitest'

import { CredentialInvalidError } from '../../application/ports/credential-store-port.js'
import { SecretRedactor } from './file-credential-store.js'

const SECRET = 'split-secret-value'

/** 递归收集结构中所有字符串，用于断言拼接后也不出现 Secret。 */
const collectStrings = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(collectStrings).join('\u0001')
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).map(collectStrings).join('\u0001')
  }
  return ''
}

const createScope = (secret = SECRET) => new SecretRedactor().createScope(secret)

describe('SecretRedactionScope', () => {
  it('直接脱敏覆盖 Secret 精确子串和 Authorization 文本', () => {
    const scope = createScope()
    try {
      expect(scope.redact(`token=${SECRET}`)).not.toContain(SECRET)
      expect(scope.redact(`Authorization: Bearer ${SECRET}`)).not.toContain(SECRET)
      expect(collectStrings(scope.redactValue({ nested: [SECRET], safe: 'ok' }))).not.toContain(SECRET)
    } finally {
      scope.close()
    }
  })

  it('跨两个 chunk 的 Secret 不出现在任何已产出的值里', () => {
    const scope = createScope()
    try {
      const first = scope.redactStreamRecord({ text: `before-split-sec` }, 'session-1')
      const second = scope.redactStreamRecord({ text: `ret-value-after` }, 'session-1')

      const combined = `${collectStrings(first)}${collectStrings(second)}`
      expect(combined).not.toContain(SECRET)
      expect(combined).toContain('[REDACTED]')
    } finally {
      scope.close()
    }
  })

  it('跨三个 chunk 的 Secret 不出现在任何已产出的值里', () => {
    const scope = createScope()
    try {
      const chunks = [
        scope.redactStreamRecord({ text: 'head-split' }, 'session-1'),
        scope.redactStreamRecord({ text: '-secret-' }, 'session-1'),
        scope.redactStreamRecord({ text: 'value-tail' }, 'session-1'),
      ]

      const combined = chunks.map(collectStrings).join('')
      expect(combined).not.toContain(SECRET)
    } finally {
      scope.close()
    }
  })

  it('不同文本流互不干扰', () => {
    const scope = createScope()
    try {
      const other = scope.redactStreamRecord({ text: 'unrelated-text' }, 'session-2')
      const first = scope.redactStreamRecord({ text: 'before-split-sec' }, 'session-1')
      const second = scope.redactStreamRecord({ text: 'ret-value-after' }, 'session-1')

      expect(collectStrings(other)).toBe('unrelated-text')
      expect(`${collectStrings(first)}${collectStrings(second)}`).not.toContain(SECRET)
    } finally {
      scope.close()
    }
  })

  it('flushStream 按字段路径返回安全尾部并清空窗口', () => {
    const scope = createScope()
    try {
      const chunk = scope.redactStreamRecord({ text: 'head-split-sec' }, 'session-1', 'agent_message_chunk')
      expect(collectStrings(chunk)).toBe('head-')

      const tails = scope.flushStream('session-1')
      expect(tails).toEqual([{ path: 'text', owner: 'agent_message_chunk', text: 'split-sec' }])
      expect(tails[0]?.text).not.toContain(SECRET)

      // 下一轮没有旧窗口：尾部片段不会再与前缀拼接成 Secret。
      const nextTurn = scope.redactStreamRecord({ text: 'ret-value-after' }, 'session-1', 'agent_message_chunk')
      expect(collectStrings(nextTurn)).toBe('ret-value-after')
      expect(scope.flushStream('session-1')).toEqual([])
    } finally {
      scope.close()
    }
  })

  it('flushStream 不把不同字段窗口的尾部拼成完整 Secret', () => {
    const scope = createScope('abab')
    try {
      // 两个 text 字段路径各自只扣住真前缀 'ab'。
      const first = scope.redactStreamRecord(
        { text: 'ab' },
        'session-1',
        'agent_message_chunk',
      ) as Record<string, unknown>
      const second = scope.redactStreamRecord(
        { content: [{ text: 'ab' }] },
        'session-1',
        'agent_message_chunk',
      ) as Record<string, unknown>
      expect(String(first.text)).toBe('')
      expect(String((second.content as Array<Record<string, unknown>>)[0]?.text)).toBe('')

      const tails = scope.flushStream('session-1')
      // 按路径分别返回，绝不合并成 'abab'。
      expect(tails).toEqual([
        { path: 'text', owner: 'agent_message_chunk', text: 'ab' },
        { path: 'content.0.text', owner: 'agent_message_chunk', text: 'ab' },
      ])
      expect(tails.some((tail) => tail.text.includes('abab'))).toBe(false)
    } finally {
      scope.close()
    }
  })

  it('结构化字段不参与窗口，不会被截断', () => {
    const scope = createScope('test-secret')
    try {
      // 'tool_call_update' 以 'te' 结尾，恰好是 Secret 前缀；若参与窗口会被截断。
      const redacted = scope.redactStreamRecord(
        { sessionUpdate: 'tool_call_update', title: 'x-test-sec' },
        'session-1',
        'tool_call_update',
      ) as Record<string, unknown>

      expect(redacted.sessionUpdate).toBe('tool_call_update')
      expect(redacted.title).toBe('x-test-sec')
      expect(scope.flushStream('session-1')).toEqual([])
    } finally {
      scope.close()
    }
  })

  it('dropStream 丢弃窗口且下一轮没有旧窗口', () => {
    const scope = createScope()
    try {
      scope.redactStreamRecord({ text: 'head-split-sec' }, 'session-1')
      scope.dropStream('session-1')

      expect(scope.flushStream('session-1')).toEqual([])
      const nextTurn = scope.redactStreamRecord({ text: 'ret-value-after' }, 'session-1')
      expect(collectStrings(nextTurn)).toBe('ret-value-after')
    } finally {
      scope.close()
    }
  })

  it('close 幂等且释放后 fail-closed', () => {
    const scope = createScope()
    scope.close()
    scope.close()

    expect(scope.redact(SECRET)).not.toContain(SECRET)
    expect(scope.redactValue(SECRET)).not.toContain(SECRET)
    expect(collectStrings(scope.redactStreamRecord({ text: SECRET }, 'session-1'))).not.toContain(SECRET)
    expect(collectStrings(scope.flushStream('session-1'))).not.toContain(SECRET)
  })

  it('空 Secret fail-closed', () => {
    expect(() => createScope('')).toThrow(CredentialInvalidError)
  })

  it('重复前缀的 Secret 也能正确保留窗口', () => {
    const scope = createScope('aab-aab-x')
    try {
      const first = scope.redactStreamRecord({ text: 'tail-aab-' }, 'session-1') as Record<string, unknown>
      expect(String(first.text)).toBe('tail-')

      const second = scope.redactStreamRecord({ text: 'aab-x' }, 'session-1') as Record<string, unknown>
      expect(String(second.text)).not.toContain('aab-aab-x')
      expect(String(second.text)).toContain('[REDACTED]')
    } finally {
      scope.close()
    }
  })

  it('接近字节上限的 Secret 不会让窗口计算退化', () => {
    const scope = createScope(`${'a'.repeat(32 * 1024)}b`)
    try {
      // 尾部与 Secret 前缀长距离部分匹配但不完整：朴素逐长度比较在这里是 O(n²)。
      const value = `${'a'.repeat(16 * 1024)}z${'a'.repeat(16 * 1024)}`
      const started = Date.now()
      const redacted = scope.redactStreamRecord({ text: value }, 'session-1') as Record<string, unknown>
      const elapsed = Date.now() - started

      // 窗口扣住 'a' 前缀尾部；emit + flush 必须无损还原原文（原文不含完整 Secret）。
      const tail = scope.flushStream('session-1')
      expect(`${String(redacted.text)}${tail.map((entry) => entry.text).join('')}`).toBe(value)
      expect(elapsed).toBeLessThan(1_000)
    } finally {
      scope.close()
    }
  })

  it('敏感字段按字段名脱敏，完整 Secret 在单个 chunk 内即被替换', () => {
    const scope = createScope()
    try {
      const redacted = scope.redactStreamRecord(
        { sessionUpdate: 'agent_message_chunk', api_key: SECRET, text: `prefix ${SECRET} suffix` },
        'session-1',
      ) as Record<string, unknown>

      expect(redacted.api_key).toBe('[REDACTED]')
      expect(String(redacted.text)).not.toContain(SECRET)
      expect(String(redacted.text)).toContain('prefix')
      expect(String(redacted.text)).toContain('suffix')
    } finally {
      scope.close()
    }
  })
})
