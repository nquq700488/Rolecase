import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { parse as parseToml } from 'smol-toml'

import type {
  CodexConfigImportDraft,
  CodexConfigImportModel,
  CodexConfigImportPort,
} from '../../application/ports/codex-config-import-port.js'
import {
  ConfigImportInvalidError,
  ConfigImportNotFoundError,
  ConfigImportStaleError,
  ConfigImportTargetConflictError,
} from '../../application/ports/codex-config-import-port.js'
import type { CodexConnectionConfig } from '@rolecast/contract'

const MAX_CONFIG_BYTES = 1_048_576
const PREVIEW_TTL_MS = 10 * 60 * 1000
const SENSITIVE_KEY_PATTERN = /api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|token|oauth|credential|private[_-]?key|client[_-]?secret/i

interface JsonRecord {
  readonly [key: string]: unknown
}

interface PendingPreview {
  readonly draft: CodexConfigImportDraft
  readonly sourcePath: string
  readonly expiresAt: number
}

interface ReadSource {
  readonly digest: string
  readonly sourceName: string
  readonly content: string
}

/** 从用户选择的 Codex config.toml 生成脱敏 preview，并绑定源文件摘要。 */
export class CodexConfigImport implements CodexConfigImportPort {
  private readonly pending = new Map<string, PendingPreview>()
  private readonly claiming = new Set<string>()

  constructor(private readonly trustedRoot = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {}

  async preview(
    workspaceId: string,
    providerId: string,
    targetConfigRevision: number,
    sourcePath: string,
  ): Promise<CodexConfigImportDraft> {
    this.removeExpired()
    const source = await readSource(sourcePath, this.trustedRoot)
    const extracted = extractConfig(source.content)
    const previewId = `codex-preview-${randomUUID()}`
    const draft: CodexConfigImportDraft = {
      previewId,
      workspaceId,
      providerId,
      sourceName: source.sourceName,
      sourceDigest: source.digest,
      targetConfigRevision,
      ...(extracted.baseUrl === undefined ? {} : { baseUrl: extracted.baseUrl }),
      config: extracted.config,
      models: extracted.models,
      warnings: extracted.warnings,
    }
    this.pending.set(previewId, {
      draft,
      sourcePath: resolve(sourcePath),
      expiresAt: Date.now() + PREVIEW_TTL_MS,
    })
    return draft
  }

  async claim(
    previewId: string,
    workspaceId: string,
    providerId: string,
    targetConfigRevision: number,
  ): Promise<CodexConfigImportDraft> {
    this.removeExpired()
    const pending = this.pending.get(previewId)
    if (pending === undefined
      || pending.draft.workspaceId !== workspaceId
      || pending.draft.providerId !== providerId
      || pending.draft.targetConfigRevision !== targetConfigRevision
      || this.claiming.has(previewId)) {
      throw new ConfigImportTargetConflictError()
    }

    this.claiming.add(previewId)
    try {
      let source: ReadSource
      try {
        source = await readSource(pending.sourcePath, this.trustedRoot)
      } catch (error: unknown) {
        this.pending.delete(previewId)
        if (isImportNotFound(error)) {
          throw new ConfigImportStaleError()
        }
        throw error
      }
      if (source.digest !== pending.draft.sourceDigest) {
        this.pending.delete(previewId)
        throw new ConfigImportStaleError()
      }

      this.pending.delete(previewId)
      return pending.draft
    } finally {
      this.claiming.delete(previewId)
    }
  }

  private removeExpired(): void {
    const now = Date.now()
    for (const [previewId, pending] of this.pending) {
      if (pending.expiresAt <= now) {
        this.pending.delete(previewId)
      }
    }
  }
}

async function readSource(sourcePath: string, trustedRoot: string): Promise<ReadSource> {
  let canonicalPath: string
  let canonicalRoot: string
  let trustedRootIdentity!: { dev: number; ino: number }
  try {
    const absolutePath = resolve(sourcePath)
    const rootPath = resolve(trustedRoot)
    if (!isAbsolute(sourcePath) || basename(absolutePath) !== 'config.toml') {
      throw new ConfigImportInvalidError()
    }
    await assertTrustedDirectoryChain(rootPath)
    const rootInfo = await lstat(rootPath)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o022) !== 0) {
      throw new ConfigImportInvalidError()
    }
    if (typeof process.getuid === 'function' && rootInfo.uid !== process.getuid()) {
      throw new ConfigImportInvalidError()
    }
    canonicalRoot = await realpath(rootPath)
    trustedRootIdentity = await statIdentity(canonicalRoot)
    if (!sameFile(trustedRootIdentity, rootInfo) || relative(canonicalRoot, absolutePath) !== 'config.toml') {
      throw new ConfigImportInvalidError()
    }
    canonicalPath = join(canonicalRoot, 'config.toml')
    const fileInfo = await lstat(absolutePath)
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
      throw new ConfigImportInvalidError()
    }
    if (await realpath(absolutePath) !== canonicalPath) {
      throw new ConfigImportInvalidError()
    }
  } catch (error: unknown) {
    if (error instanceof ConfigImportInvalidError) {
      throw error
    }
    if (isNotFound(error)) {
      throw new ConfigImportNotFoundError()
    }
    throw new ConfigImportInvalidError()
  }

  let expected: Awaited<ReturnType<typeof stat>>
  let rootAtCheck: { dev: number; ino: number }
  try {
    expected = await stat(canonicalPath)
    rootAtCheck = await statIdentity(canonicalRoot)
  } catch (error: unknown) {
    if (isNotFound(error)) {
      throw new ConfigImportNotFoundError()
    }
    throw new ConfigImportInvalidError()
  }
  if (!expected.isFile() || expected.size > MAX_CONFIG_BYTES
    || !sameFile(rootAtCheck, trustedRootIdentity)) {
    throw new ConfigImportInvalidError()
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (!sameFile(await statIdentity(canonicalRoot), trustedRootIdentity)
      || !opened.isFile() || opened.size > MAX_CONFIG_BYTES || !sameFile(opened, expected)) {
      throw new ConfigImportInvalidError()
    }
    const pathStat = await stat(canonicalPath)
    if (!sameFile(opened, pathStat)) {
      throw new ConfigImportInvalidError()
    }
    const content = await readLimited(handle)
    const afterRead = await handle.stat()
    if (!afterRead.isFile() || afterRead.size > MAX_CONFIG_BYTES) {
      throw new ConfigImportInvalidError()
    }
    return {
      digest: createHash('sha256').update(content, 'utf8').digest('hex'),
      sourceName: basename(canonicalPath),
      content,
    }
  } catch (error: unknown) {
    if (error instanceof ConfigImportInvalidError) {
      throw error
    }
    if (isNotFound(error)) {
      throw new ConfigImportNotFoundError()
    }
    throw new ConfigImportInvalidError()
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function assertTrustedDirectoryChain(directoryPath: string): Promise<void> {
  let current = resolve(directoryPath)
  while (true) {
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ConfigImportInvalidError()
    }
    const parent = dirname(current)
    if (parent === current) {
      return
    }
    current = parent
  }
}

async function statIdentity(path: string): Promise<{ dev: number; ino: number }> {
  const info = await stat(path)
  return { dev: info.dev, ino: info.ino }
}

async function readLimited(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  while (totalBytes < MAX_CONFIG_BYTES) {
    const remaining = MAX_CONFIG_BYTES - totalBytes
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
    const result = await handle.read(buffer, 0, buffer.length, null)
    if (result.bytesRead === 0) {
      break
    }
    totalBytes += result.bytesRead
    chunks.push(buffer.subarray(0, result.bytesRead))
  }
  if (totalBytes === MAX_CONFIG_BYTES) {
    const probe = Buffer.allocUnsafe(1)
    const result = await handle.read(probe, 0, 1, null)
    if (result.bytesRead > 0) {
      throw new ConfigImportInvalidError()
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

function extractConfig(content: string): {
  readonly baseUrl?: string
  readonly config: CodexConnectionConfig
  readonly models: readonly CodexConfigImportModel[]
  readonly warnings: readonly string[]
} {
  let parsed: unknown
  try {
    parsed = parseToml(content)
  } catch {
    throw new ConfigImportInvalidError()
  }
  const root = asRecord(parsed)
  const selectedProviderId = stringValue(root.model_provider)
  const providers = asRecord(root.model_providers)
  const selectedProvider = selectedProviderId === undefined ? {} : asRecord(providers[selectedProviderId])
  const baseUrlValue = stringValue(selectedProvider.base_url) ?? stringValue(root.base_url)
  const baseUrl = baseUrlValue === undefined ? undefined : validateBaseUrl(baseUrlValue)
  const config: CodexConnectionConfig = {
    ...(selectedProviderId === undefined ? {} : { model_provider: selectedProviderId }),
    ...(stringValue(root.model) === undefined ? {} : { model: stringValue(root.model) }),
    ...(stringValue(selectedProvider.wire_api) === undefined
      ? {}
      : { wire_api: stringValue(selectedProvider.wire_api) }),
    ...(stringValue(root.model_reasoning_effort) === undefined
      ? {}
      : { reasoning_effort: stringValue(root.model_reasoning_effort) }),
  }
  const models = extractModels(root.models ?? selectedProvider.models, stringValue(root.model))
  if (Object.keys(config).length === 0 && baseUrl === undefined && models.length === 0) {
    throw new ConfigImportInvalidError()
  }
  const warnings = containsSensitiveKey(root) ? ['已忽略配置中的凭据字段'] : []
  return { ...(baseUrl === undefined ? {} : { baseUrl }), config, models, warnings }
}

function extractModels(value: unknown, defaultModel: string | undefined): CodexConfigImportModel[] {
  const values = Array.isArray(value) ? value : defaultModel === undefined ? [] : [defaultModel]
  const models: CodexConfigImportModel[] = []
  for (const item of values) {
    if (typeof item === 'string' && item.trim().length > 0) {
      models.push({ modelId: item.trim(), displayName: item.trim() })
      continue
    }
    const record = asRecord(item)
    const modelId = stringValue(record.id) ?? stringValue(record.model) ?? stringValue(record.value)
    if (modelId !== undefined && modelId.trim().length > 0) {
      const displayName = stringValue(record.name) ?? stringValue(record.display_name) ?? modelId
      models.push({ modelId: modelId.trim(), displayName: displayName.trim() })
    }
    if (models.length >= 64) {
      break
    }
  }
  return models
}

function validateBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)
      || url.hostname.length === 0
      || url.username.length > 0
      || url.password.length > 0
      || url.search.length > 0
      || url.hash.length > 0) {
      throw new ConfigImportInvalidError()
    }
    return url.toString()
  } catch (error: unknown) {
    if (error instanceof ConfigImportInvalidError) {
      throw error
    }
    throw new ConfigImportInvalidError()
  }
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveKey)
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return Object.entries(value as JsonRecord).some(([key, item]) => SENSITIVE_KEY_PATTERN.test(key) || containsSensitiveKey(item))
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  return value as JsonRecord
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isImportNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'config_import_not_found'
}
