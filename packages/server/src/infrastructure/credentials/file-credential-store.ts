import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isSensitiveRuntimeOptionKey } from '@rolecast/contract'

import type {
  CredentialStorePort,
  SecretRedactionPort,
  SecretRedactionScope,
  SecretStreamTail,
} from '../../application/ports/credential-store-port.js'
import {
  CredentialIdempotencyConflictError,
  CredentialInvalidError,
  CredentialNotFoundError,
  CredentialStoreUnavailableError,
  isCredentialOperationKeyValid,
  isCredentialValueValid,
} from '../../application/ports/credential-store-port.js'
import { deriveCredentialReference } from './credential-reference.js'

/**
 * 可作为文件名的引用形状。
 *
 * 文件后端直接把引用当作文件名，因此只接受 Store 自己生成的形状：
 * 拒绝 `.`、`..`、路径分隔符与绝对路径，避免目录穿越。
 */
export const SAFE_REFERENCE_PATTERN = /^credential-[A-Za-z0-9-]{1,64}$/

/**
 * 读取条目文件。
 *
 * 不存在返回 null；内容不是合法条目时抛 `CredentialStoreUnavailableError`，
 * `get` 与 `validate` 共用同一判据，避免「validate 通过但 get 失败」。
 */
export async function readCredentialEntry(entryPath: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(entryPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CredentialStoreUnavailableError()
    }
    const secret = (parsed as Record<string, unknown>)['secret']
    if (typeof secret !== 'string' || !isCredentialValueValid(secret)) {
      throw new CredentialStoreUnavailableError()
    }
    return secret
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return null
    }
    if (error instanceof CredentialStoreUnavailableError) {
      throw error
    }
    throw new CredentialStoreUnavailableError()
  }
}

/**
 * 原子发布一个条目：先在同目录写完 0600 临时文件，再用硬链接的「仅创建」语义发布。
 *
 * `link` 只会在目标不存在时成功，因此其他进程永远看不到半写入的内容；
 * 已有条目返回 false，由调用方读取比较。
 */
export async function publishCredentialEntry(entryPath: string, secret: string): Promise<boolean> {
  const temporaryPath = `${entryPath}.${randomUUID()}.tmp`
  let published = false
  try {
    await writeFile(temporaryPath, encodeEntry(secret), { encoding: 'utf8', mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await link(temporaryPath, entryPath)
    published = true
    return true
  } catch (error: unknown) {
    if (isAlreadyExists(error)) {
      return false
    }
    throw new CredentialStoreUnavailableError()
  } finally {
    // 临时路径是条目内容的硬链接：发布成功后必须删除，否则 Secret 会以第二个
    // 名字残留。清理失败要可观察——调用方用同一幂等键重试是安全的。
    const removed = await unlink(temporaryPath).then(
      () => true,
      (error: unknown) => isFileNotFound(error),
    )
    if (!removed && published) {
      throw new CredentialStoreUnavailableError()
    }
  }
}

/**
 * 开发模式使用的 0600 逐条目文件凭据存储。生产模式不得实例化此实现。
 *
 * 每个凭据一个文件，用 `wx` 原子创建；不共享可被读改写的索引文件，
 * 因此多个进程同时创建同一条目时只有一个成功，不需要跨进程锁。
 */
export class FileCredentialStore implements CredentialStorePort {
  constructor(private readonly directoryPath: string) {}

  async save(operationKey: string, secret: string): Promise<string> {
    if (!isCredentialOperationKeyValid(operationKey) || !isCredentialValueValid(secret)) {
      throw new CredentialInvalidError()
    }
    const reference = deriveCredentialReference(operationKey)
    const entryPath = this.entryPath(reference)
    await mkdir(this.directoryPath, { recursive: true, mode: 0o700 }).catch(() => {
      throw new CredentialStoreUnavailableError()
    })
    // 跨进程原子发布：条目已存在时返回 false，绝不覆盖。
    if (await publishCredentialEntry(entryPath, secret)) {
      return reference
    }
    // 已存在：同值幂等，异值冲突。
    const existing = await readCredentialEntry(entryPath)
    if (existing === null) {
      // 发布失败后条目又消失，说明状态不确定；让调用方按同一幂等键重试。
      throw new CredentialStoreUnavailableError()
    }
    if (existing === secret) {
      return reference
    }
    throw new CredentialIdempotencyConflictError(reference)
  }

  async get(reference: string): Promise<string | null> {
    if (!isSafeReference(reference)) {
      return null
    }
    return readCredentialEntry(this.entryPath(reference))
  }

  async validate(reference: string): Promise<boolean> {
    if (!isSafeReference(reference)) {
      return false
    }
    // 与 get 共用同一校验：损坏条目 fail-closed，而不是被当成可用引用。
    return await readCredentialEntry(this.entryPath(reference)) !== null
  }

  async rotate(reference: string, secret: string): Promise<void> {
    if (!isCredentialValueValid(secret)) {
      throw new CredentialInvalidError()
    }
    if (!isSafeReference(reference)) {
      throw new CredentialNotFoundError()
    }
    const entryPath = this.entryPath(reference)
    if (await readCredentialEntry(entryPath) === null) {
      throw new CredentialNotFoundError()
    }
    // 单条目替换本身原子；跨进程同时 rotate 仍是后者覆盖前者，不是 CAS。
    await this.writeEntry(entryPath, secret)
  }

  async delete(reference: string): Promise<void> {
    if (!isSafeReference(reference)) {
      return
    }
    try {
      await unlink(this.entryPath(reference))
    } catch (error: unknown) {
      if (!isFileNotFound(error)) {
        throw new CredentialStoreUnavailableError()
      }
    }
    // 崩溃可能留下指向同一条目的临时硬链接；删除时必须一并回收。
    await removeLeftoverTemporaryLinks(this.directoryPath, reference)
  }

  private entryPath(reference: string): string {
    return join(this.directoryPath, `${reference}.json`)
  }

  private async writeEntry(entryPath: string, secret: string): Promise<void> {
    let temporaryPath: string | null = null
    try {
      temporaryPath = `${entryPath}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, encodeEntry(secret), { encoding: 'utf8', mode: 0o600 })
      await chmod(temporaryPath, 0o600)
      await rename(temporaryPath, entryPath)
      temporaryPath = null
      await chmod(entryPath, 0o600)
    } catch {
      if (temporaryPath !== null) {
        await unlink(temporaryPath).catch(() => undefined)
      }
      throw new CredentialStoreUnavailableError()
    }
  }
}

/** 删除某引用可能遗留的 `.tmp` 硬链接；不存在时视为成功。 */
async function removeLeftoverTemporaryLinks(directoryPath: string, reference: string): Promise<void> {
  const prefix = `${reference}.json.`
  let names: string[]
  try {
    names = await readdir(directoryPath)
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return
    }
    throw new CredentialStoreUnavailableError()
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) {
      continue
    }
    try {
      await unlink(join(directoryPath, name))
    } catch (error: unknown) {
      if (!isFileNotFound(error)) {
        throw new CredentialStoreUnavailableError()
      }
    }
  }
}

const encodeEntry = (secret: string): string => JSON.stringify({ secret })

const isSafeReference = (reference: string): boolean => SAFE_REFERENCE_PATTERN.test(reference)

/** 脱敏后使用的固定标记。 */
const REDACTED = '[REDACTED]'

/** 流窗口 key 的分隔符，避免 streamId 与字段路径拼接歧义。 */
const STREAM_WINDOW_SEPARATOR = '\u0000'

/**
 * 唯一参与跨 chunk 窗口的字段名。
 *
 * 窗口保护的是「文本流」；对结构化字段（如事件 kind、工具标题）做窗口会在
 * flush 时截断它们自身的内容（例如 `tool_call_update` 变成 `tool_call_upda`），
 * 因此这些字段只做直接脱敏。
 */
const TEXT_STREAM_KEY = 'text'

/** 一个文本流的窗口归属信息。 */
interface StreamWindowScope {
  readonly id: string
  readonly owner: string
}

/** 窗口中被扣住的尾部及其归属。 */
interface HeldWindow {
  readonly text: string
  /** 写入过该窗口的归属；多个不同归属时为 null。 */
  readonly owner: string | null
}

/** 不暴露原文的最小脱敏器。 */
export class SecretRedactor implements SecretRedactionPort {
  fingerprint(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex')
  }

  redact(value: string): string {
    return redactText(value)
  }

  redactRecord(
    value: Readonly<Record<string, unknown>>,
    secretFingerprints: readonly string[] = [],
  ): Readonly<Record<string, unknown>> {
    return redactRecordValue(value, this, new Set(secretFingerprints)) as Readonly<Record<string, unknown>>
  }

  createScope(secret: string): SecretRedactionScope {
    return new ConnectionSecretRedactionScope(secret)
  }
}

/**
 * 只在一次 Adapter 连接期间持有 Secret 原文的脱敏 scope。
 *
 * 按 `streamId + 字段路径` 维护「最长 Secret 前缀后缀窗口」：被窗口扣住的尾部
 * 是 Secret 的**真前缀**，因此单独出现时不构成完整 Secret；turn 正常结束时由
 * `flushStream` 交还，取消 / 异常 / 关闭时由 `dropStream` 丢弃。
 */
class ConnectionSecretRedactionScope implements SecretRedactionScope {
  private secret: string | null
  private readonly windows = new Map<string, HeldWindow>()

  constructor(secret: string) {
    if (secret.length === 0) {
      // 空 Secret 无法做精确匹配，fail-closed 而不是静默放过。
      throw new CredentialInvalidError()
    }
    this.secret = secret
  }

  redact(value: string): string {
    return this.secret === null ? REDACTED : this.redactExact(value, this.secret)
  }

  redactValue(value: unknown): unknown {
    return this.redactStructure(value, '', null, false)
  }

  redactStreamRecord(value: unknown, streamId: string, owner?: string): unknown {
    return this.redactStructure(value, '', { id: streamId, owner: owner ?? '' }, false)
  }

  flushStream(streamId: string): readonly SecretStreamTail[] {
    const prefix = `${streamId}${STREAM_WINDOW_SEPARATOR}`
    const tails: SecretStreamTail[] = []
    for (const [key, window] of this.windows) {
      if (key.startsWith(prefix)) {
        // 按字段路径分别返回：不同窗口的尾部一旦拼接，可能重组出完整 Secret。
        tails.push({ path: key.slice(prefix.length), owner: window.owner, text: window.text })
        this.windows.delete(key)
      }
    }
    return tails
  }

  dropStream(streamId: string): void {
    const prefix = `${streamId}${STREAM_WINDOW_SEPARATOR}`
    for (const key of [...this.windows.keys()]) {
      if (key.startsWith(prefix)) {
        this.windows.delete(key)
      }
    }
  }

  close(): void {
    this.secret = null
    this.windows.clear()
  }

  private redactExact(value: string, secret: string): string {
    return redactText(value.replaceAll(secret, REDACTED))
  }

  private redactStructure(
    value: unknown,
    path: string,
    stream: StreamWindowScope | null,
    inTextStream: boolean,
  ): unknown {
    if (typeof value === 'string') {
      return stream !== null && inTextStream
        ? this.redactStreamText(value, `${stream.id}${STREAM_WINDOW_SEPARATOR}${path}`, stream.owner)
        : this.redact(value)
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => this.redactStructure(item, `${path}.${index}`, stream, inTextStream))
    }
    if (typeof value !== 'object' || value === null) {
      return value
    }
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [
      key,
      isSensitiveRecordKey(key)
        ? REDACTED
        : this.redactStructure(item, path === '' ? key : `${path}.${key}`, stream, key === TEXT_STREAM_KEY),
    ]))
  }

  private redactStreamText(text: string, windowKey: string, owner: string): string {
    const secret = this.secret
    if (secret === null) {
      return REDACTED
    }
    const previous = this.windows.get(windowKey)
    this.windows.delete(windowKey)
    const redacted = this.redactExact(`${previous?.text ?? ''}${text}`, secret)
    const held = longestSecretPrefixSuffix(redacted, secret)
    if (held.length > 0) {
      this.windows.set(windowKey, {
        text: held,
        // 尾部跨越不同归属的 chunk 时无法证明唯一归属，调用方必须丢弃。
        owner: previous !== undefined && previous.owner !== owner ? null : owner,
      })
    }
    return redacted.slice(0, redacted.length - held.length)
  }
}

/**
 * 取 value 末尾最长的、同时是 Secret 真前缀的后缀。
 *
 * 用 KMP 前缀函数在 O(value + secret) 内完成：朴素的逐长度 endsWith 比较是
 * O(secret²)，而 Secret 上限是 64 KiB，会让每个 chunk 卡住数分钟。
 */
function longestSecretPrefixSuffix(value: string, secret: string): string {
  const maxLength = Math.min(secret.length - 1, value.length)
  if (maxLength <= 0) {
    return ''
  }
  const pattern = secret.slice(0, maxLength)
  const failure = buildPrefixFunction(pattern)
  let matched = 0
  for (let index = 0; index < value.length; index += 1) {
    while (matched > 0 && value[index] !== pattern[matched]) {
      matched = failure[matched - 1] ?? 0
    }
    if (value[index] === pattern[matched]) {
      matched += 1
    }
  }
  return pattern.slice(0, matched)
}

/** pattern 的标准 KMP 前缀函数。 */
function buildPrefixFunction(pattern: string): number[] {
  const failure = new Array<number>(pattern.length).fill(0)
  let matched = 0
  for (let index = 1; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) {
      matched = failure[matched - 1] ?? 0
    }
    if (pattern[index] === pattern[matched]) {
      matched += 1
    }
    failure[index] = matched
  }
  return failure
}

/** 判断字段名是否按敏感字段整体脱敏。 */
function isSensitiveRecordKey(key: string): boolean {
  return isSensitiveRuntimeOptionKey(key)
    || /authorization|oauth|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?key|credential/i.test(key)
}

const redactText = (value: string): string => value
  .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
  .replace(/(api[_-]?key|access[_-]?token|password)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')

const redactRecordValue = (
  value: unknown,
  redactor: SecretRedactor,
  secretFingerprints: ReadonlySet<string>,
): unknown => {
  if (typeof value === 'string') {
    return secretFingerprints.has(redactor.fingerprint(value)) ? REDACTED : redactor.redact(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactRecordValue(item, redactor, secretFingerprints))
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key,
    isSensitiveRecordKey(key) ? REDACTED : redactRecordValue(item, redactor, secretFingerprints),
  ]))
}

export const isFileNotFound = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  return 'code' in error && error.code === 'ENOENT'
}

const isAlreadyExists = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  return 'code' in error && error.code === 'EEXIST'
}
