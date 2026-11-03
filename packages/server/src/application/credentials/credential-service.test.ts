import { describe, expect, it } from 'vitest'

import { ApplicationError } from '../errors.js'
import type { CredentialStorePort } from '../ports/credential-store-port.js'
import {
  CredentialDeniedError,
  CredentialIdempotencyConflictError,
  CredentialInvalidError,
  CredentialStoreUnavailableError,
} from '../ports/credential-store-port.js'
import { CredentialService } from './credential-service.js'

const IDEMPOTENCY_KEY = '7d444840-9dc0-11d1-b245-5ffdce74fad2'

/** 记录调用的内存 Store；可注入每次 save 的结果。 */
class RecordingStore implements CredentialStorePort {
  readonly saves: Array<{ operationKey: string; secret: string }> = []
  readonly reads: string[] = []
  readonly references = new Map<string, string>()
  private failure: Error | null

  constructor(failure: Error | null = null) {
    this.failure = failure
  }

  async save(operationKey: string, secret: string): Promise<string> {
    this.saves.push({ operationKey, secret })
    if (this.failure !== null) {
      // 模拟「写入可能已完成，但调用方收到失败」：先记录引用，再抛错。
      const error = this.failure
      this.failure = null
      this.references.set(operationKey, `credential-${operationKey}`)
      throw error
    }
    const existing = this.references.get(operationKey)
    if (existing !== undefined) {
      return existing
    }
    const reference = `credential-${operationKey}`
    this.references.set(operationKey, reference)
    return reference
  }

  async get(reference: string): Promise<string | null> {
    this.reads.push(reference)
    return null
  }

  async validate(): Promise<boolean> {
    return true
  }

  async rotate(): Promise<void> {
    return undefined
  }

  async delete(): Promise<void> {
    return undefined
  }
}

function expectApplicationError(error: unknown, code: string, statusCode: number): void {
  expect(error).toBeInstanceOf(ApplicationError)
  expect(error).toMatchObject({ code, statusCode })
}

const conflictReference = `credential-${IDEMPOTENCY_KEY}`

const errorMappings: ReadonlyArray<readonly [Error, string, number]> = [
  [new CredentialInvalidError(), 'credential_invalid', 422],
  [new CredentialDeniedError(), 'credential_denied', 403],
  [new CredentialStoreUnavailableError(), 'credentials_unavailable', 503],
  [new CredentialIdempotencyConflictError(conflictReference), 'credential_idempotency_conflict', 409],
]

describe('CredentialService', () => {
  it('只调用 save 并返回引用，不读取 Secret', async () => {
    const store = new RecordingStore()
    const service = new CredentialService(store)

    const result = await service.create({ idempotencyKey: IDEMPOTENCY_KEY, secret: 'sk-synthetic' })

    expect(result).toEqual({ credential_ref: `credential-${IDEMPOTENCY_KEY}` })
    expect(store.saves).toEqual([{ operationKey: IDEMPOTENCY_KEY, secret: 'sk-synthetic' }])
    expect(store.reads).toHaveLength(0)
    expect(JSON.stringify(result)).not.toContain('sk-synthetic')
  })

  it('保存后报错时用同一幂等键重试返回同一引用', async () => {
    const store = new RecordingStore(new CredentialStoreUnavailableError())
    const service = new CredentialService(store)

    await expect(service.create({ idempotencyKey: IDEMPOTENCY_KEY, secret: 'sk-synthetic' }))
      .rejects.toMatchObject({ code: 'credentials_unavailable' })
    const result = await service.create({ idempotencyKey: IDEMPOTENCY_KEY, secret: 'sk-synthetic' })

    expect(result.credential_ref).toBe(`credential-${IDEMPOTENCY_KEY}`)
    expect(store.saves).toHaveLength(2)
    expect(store.references.size).toBe(1)
  })

  it.each(errorMappings)('把 %s 映射为稳定的 API 错误', async (error, code, statusCode) => {
    const store = new RecordingStore(error)
    const service = new CredentialService(store)

    try {
      await service.create({ idempotencyKey: IDEMPOTENCY_KEY, secret: 'sk-synthetic' })
      throw new Error('预期抛出 ApplicationError')
    } catch (thrown: unknown) {
      expectApplicationError(thrown, code, statusCode)
      expect(JSON.stringify(thrown instanceof Error ? thrown.message : thrown)).not.toContain('sk-synthetic')
      if (code === 'credential_idempotency_conflict') {
        // 冲突必须回传既有引用，调用方才能继续使用而不是重新创建。
        expect(thrown).toMatchObject({ details: { credential_ref: conflictReference } })
      }
    }
  })

  it('未知错误原样上抛，不伪装成成功', async () => {
    const unexpected = new Error('unexpected store failure')
    const store = new RecordingStore(unexpected)
    const service = new CredentialService(store)

    await expect(service.create({ idempotencyKey: IDEMPOTENCY_KEY, secret: 'sk-synthetic' }))
      .rejects.toBe(unexpected)
  })
})
