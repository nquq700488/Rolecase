import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import type { CredentialStorePort } from './credential-store-port.js'
import {
  CredentialIdempotencyConflictError,
  CredentialInvalidError,
  CredentialNotFoundError,
  isCredentialOperationKeyValid,
  isCredentialValueValid,
} from './credential-store-port.js'
import { FileCredentialStore } from '../../infrastructure/credentials/file-credential-store.js'

type CreatedStore = {
  store: CredentialStorePort
  cleanup: () => Promise<void>
}
type StoreFactory = () => Promise<CreatedStore>

type FakeValues = Readonly<Record<string, string>>

class FakeCredentialStore implements CredentialStorePort {
  private values: FakeValues = {}

  async save(operationKey: string, secret: string): Promise<string> {
    if (!isCredentialOperationKeyValid(operationKey) || !isCredentialValueValid(secret)) {
      throw new CredentialInvalidError()
    }
    const reference = `fake-${operationKey}`
    const existing = this.values[reference]
    if (existing !== undefined) {
      if (existing === secret) {
        return reference
      }
      throw new CredentialIdempotencyConflictError(reference)
    }
    this.values = { ...this.values, [reference]: secret }
    return reference
  }

  async get(reference: string): Promise<string | null> {
    return this.values[reference] ?? null
  }

  async validate(reference: string): Promise<boolean> {
    return Object.hasOwn(this.values, reference)
  }

  async rotate(reference: string, secret: string): Promise<void> {
    if (!isCredentialValueValid(secret)) {
      throw new CredentialInvalidError()
    }
    if (!Object.hasOwn(this.values, reference)) {
      throw new CredentialNotFoundError()
    }
    this.values = { ...this.values, [reference]: secret }
  }

  async delete(reference: string): Promise<void> {
    if (!Object.hasOwn(this.values, reference)) {
      return
    }
    const nextValues = { ...this.values }
    delete nextValues[reference]
    this.values = nextValues
  }
}

async function createFakeStore(): Promise<CreatedStore> {
  return { store: new FakeCredentialStore(), cleanup: async () => undefined }
}

async function createFileStore(): Promise<CreatedStore> {
  const directory = await mkdtemp(join(tmpdir(), 'rolecast-credentials-'))
  return {
    store: new FileCredentialStore(join(directory, 'credentials')),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

function runCredentialStoreContract(name: string, factory: StoreFactory): void {
  describe(name, () => {
    it('保存、读取、校验、轮换和删除保持引用语义', async () => {
      const created = await factory()
      try {
        const reference = await created.store.save('operation-a', 'test-secret-a')
        expect(reference).toMatch(/^(credential-|fake-)/)
        await expect(created.store.get(reference)).resolves.toBe('test-secret-a')
        await expect(created.store.validate(reference)).resolves.toBe(true)

        await created.store.rotate(reference, 'test-secret-b')
        await expect(created.store.get(reference)).resolves.toBe('test-secret-b')
        await expect(created.store.validate(reference)).resolves.toBe(true)

        await created.store.delete(reference)
        await expect(created.store.get(reference)).resolves.toBeNull()
        await expect(created.store.validate(reference)).resolves.toBe(false)
        await expect(created.store.delete(reference)).resolves.toBeUndefined()
      } finally {
        await created.cleanup()
      }
    })

    it('同一幂等键与同一 Secret 重复保存返回同一引用', async () => {
      const created = await factory()
      try {
        const first = await created.store.save('operation-idempotent', 'test-secret-a')
        const second = await created.store.save('operation-idempotent', 'test-secret-a')
        expect(second).toBe(first)
        await expect(created.store.get(first)).resolves.toBe('test-secret-a')
      } finally {
        await created.cleanup()
      }
    })

    it('同一幂等键与不同 Secret 被拒绝且不覆盖既有凭据', async () => {
      const created = await factory()
      try {
        const reference = await created.store.save('operation-conflict', 'test-secret-a')
        await expect(created.store.save('operation-conflict', 'test-secret-b'))
          .rejects.toBeInstanceOf(CredentialIdempotencyConflictError)
        await expect(created.store.get(reference)).resolves.toBe('test-secret-a')
      } finally {
        await created.cleanup()
      }
    })

    it('拒绝空凭据并对未知引用返回稳定结果', async () => {
      const created = await factory()
      try {
        await expect(created.store.save('operation-empty', '')).rejects.toBeInstanceOf(CredentialInvalidError)
        await expect(created.store.get('missing')).resolves.toBeNull()
        await expect(created.store.validate('missing')).resolves.toBe(false)
        await expect(created.store.rotate('missing', 'test-secret')).rejects.toBeInstanceOf(CredentialNotFoundError)
        await expect(created.store.delete('missing')).resolves.toBeUndefined()
      } finally {
        await created.cleanup()
      }
    })

    it('拒绝超过公共字节上限的 Secret', async () => {
      const created = await factory()
      try {
        await expect(created.store.save('operation-large', 'x'.repeat(64 * 1024 + 1)))
          .rejects.toBeInstanceOf(CredentialInvalidError)
      } finally {
        await created.cleanup()
      }
    })

    it('拒绝包含行分隔符的 Secret', async () => {
      const created = await factory()
      try {
        const reference = await created.store.save('operation-lines', 'test-secret-ok')
        await expect(created.store.save('operation-lines-2', 'test-secret\nsecond-line'))
          .rejects.toBeInstanceOf(CredentialInvalidError)
        await expect(created.store.save('operation-lines-3', 'test-secret\rsecond-line'))
          .rejects.toBeInstanceOf(CredentialInvalidError)
        await expect(created.store.rotate(reference, 'test-secret\nsecond-line'))
          .rejects.toBeInstanceOf(CredentialInvalidError)
        await expect(created.store.get(reference)).resolves.toBe('test-secret-ok')
      } finally {
        await created.cleanup()
      }
    })

    it('拒绝非法幂等键', async () => {
      const created = await factory()
      try {
        await expect(created.store.save('', 'test-secret')).rejects.toBeInstanceOf(CredentialInvalidError)
        await expect(created.store.save('operation\nkey', 'test-secret'))
          .rejects.toBeInstanceOf(CredentialInvalidError)
        await expect(created.store.save('k'.repeat(129), 'test-secret'))
          .rejects.toBeInstanceOf(CredentialInvalidError)
      } finally {
        await created.cleanup()
      }
    })

    it('并发保存不同幂等键不会覆盖已保存的引用', async () => {
      const created = await factory()
      try {
        const references = await Promise.all(
          Array.from({ length: 8 }, (_, index) => created.store.save(`operation-${index}`, `test-secret-${index}`)),
        )
        expect(new Set(references).size).toBe(8)
        await expect(Promise.all(references.map((reference) => created.store.validate(reference)))).resolves.toEqual(
          Array.from({ length: 8 }, () => true),
        )
      } finally {
        await created.cleanup()
      }
    })

    it('并发使用同一幂等键与同一 Secret 只产生一个引用', async () => {
      const created = await factory()
      try {
        const references = await Promise.all(
          Array.from({ length: 8 }, () => created.store.save('operation-concurrent', 'test-secret-shared')),
        )
        expect(new Set(references).size).toBe(1)
        await expect(created.store.get(references[0] ?? '')).resolves.toBe('test-secret-shared')
      } finally {
        await created.cleanup()
      }
    })
  })
}

runCredentialStoreContract('FakeCredentialStore Contract', createFakeStore)
runCredentialStoreContract('FileCredentialStore Contract', createFileStore)
