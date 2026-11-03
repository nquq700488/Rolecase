import { link, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CredentialIdempotencyConflictError,
  CredentialNotFoundError,
  CredentialStoreUnavailableError,
} from '../../application/ports/credential-store-port.js'
import { deriveCredentialReference } from './credential-reference.js'
import { FileCredentialStore, SecretRedactor } from './file-credential-store.js'

describe('FileCredentialStore 逐条目存储', () => {
  let directory: string
  let store: FileCredentialStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rolecast-file-store-'))
    store = new FileCredentialStore(directory)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('每个凭据一个条目文件，重复保存不产生第二份', async () => {
    const reference = await store.save('operation-file', 'test-secret')
    await store.save('operation-file', 'test-secret')

    await expect(readdir(directory)).resolves.toEqual([`${reference}.json`])
  })

  it('已存在异值时拒绝覆盖', async () => {
    const reference = await store.save('operation-file', 'test-secret')
    await expect(store.save('operation-file', 'another-secret'))
      .rejects.toBeInstanceOf(CredentialIdempotencyConflictError)
    await expect(store.get(reference)).resolves.toBe('test-secret')
  })

  it('删除条目时一并回收遗留的临时硬链接', async () => {
    const reference = await store.save('operation-leftover', 'test-secret')
    // 模拟发布后崩溃：临时路径仍是条目内容的硬链接。
    await link(join(directory, `${reference}.json`), join(directory, `${reference}.json.crashed.tmp`))

    await store.delete(reference)

    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('拒绝可能逃逸目录的引用', async () => {
    await expect(store.get('../../etc/passwd')).resolves.toBeNull()
    await expect(store.validate('../credentials')).resolves.toBe(false)
    await expect(store.rotate('../credentials', 'test-secret')).rejects.toBeInstanceOf(CredentialNotFoundError)
    await expect(store.delete('../credentials')).resolves.toBeUndefined()
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('条目内容损坏时 get 与 validate 一致 fail-closed', async () => {
    const reference = deriveCredentialReference('operation-broken')
    await writeFile(join(directory, `${reference}.json`), '{"secret": ""}', { mode: 0o600 })

    await expect(store.get(reference)).rejects.toBeInstanceOf(CredentialStoreUnavailableError)
    await expect(store.validate(reference)).rejects.toBeInstanceOf(CredentialStoreUnavailableError)
  })

  it('损坏条目的非 JSON 内容同样 fail-closed', async () => {
    const reference = deriveCredentialReference('operation-broken-json')
    await writeFile(join(directory, `${reference}.json`), 'not-json', { mode: 0o600 })

    await expect(store.validate(reference)).rejects.toBeInstanceOf(CredentialStoreUnavailableError)
  })
})

describe('SecretRedactor', () => {
  it('递归移除事件结构中的凭据字段和 Authorization 值', () => {
    const redactor = new SecretRedactor()
    const result = redactor.redactRecord({
      token: 'do-not-store',
      nested: { output: 'Authorization: Bearer do-not-store' },
      text: 'api_key=do-not-store',
    })

    expect(JSON.stringify(result)).not.toContain('do-not-store')
    expect(result).toEqual({
      token: '[REDACTED]',
      nested: { output: 'Authorization: Bearer [REDACTED]' },
      text: 'api_key=[REDACTED]',
    })
  })

  it('覆盖 private key、client key、credential 和驼峰变体', () => {
    const result = new SecretRedactor().redactRecord({
      private_key: 'private-value',
      clientKey: 'client-value',
      credential: 'credential-value',
      client_secret: 'secret-value',
      max_output_tokens: 4096,
    })

    expect(result).toEqual({
      private_key: '[REDACTED]',
      clientKey: '[REDACTED]',
      credential: '[REDACTED]',
      client_secret: '[REDACTED]',
      max_output_tokens: 4096,
    })
  })
})
