import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CredentialStoreUnavailableError,
  isCredentialValueValid,
} from '../../application/ports/credential-store-port.js'
import {
  SAFE_REFERENCE_PATTERN,
  isFileNotFound,
  publishCredentialEntry,
  readCredentialEntry,
} from './file-credential-store.js'

/** 旧版凭据文件与新目录内容冲突，需要人工处理。 */
export class LegacyCredentialMigrationError extends Error {
  readonly code = 'credentials_migration_conflict'

  constructor() {
    super('旧版凭据文件与新凭据目录存在冲突，请手动处理后重启')
    this.name = 'LegacyCredentialMigrationError'
  }
}

/** 迁移结果；0 表示没有旧数据。 */
export interface LegacyCredentialMigrationResult {
  readonly migrated: number
}

/**
 * @name migrateLegacyFileCredentials
 * @description 把旧版单文件凭据存储迁移为逐条目目录，保留既有 credential_ref
 * @param {object} input 旧文件路径与新的凭据目录
 * @return {Promise<LegacyCredentialMigrationResult>} 迁移的条目数
 * @example
 * await migrateLegacyFileCredentials({
 *   legacyFilePath: '/data/credentials.json',
 *   directoryPath: '/data/credentials',
 * })
 */
export async function migrateLegacyFileCredentials(input: {
  legacyFilePath: string
  directoryPath: string
}): Promise<LegacyCredentialMigrationResult> {
  const content = await readLegacyFile(input.legacyFilePath)
  if (content === null) {
    return { migrated: 0 }
  }
  const entries = parseLegacyEntries(content)
  await mkdir(input.directoryPath, { recursive: true, mode: 0o700 }).catch(() => {
    throw new CredentialStoreUnavailableError()
  })
  for (const [reference, secret] of entries) {
    const entryPath = join(input.directoryPath, `${reference}.json`)
    if (await publishCredentialEntry(entryPath, secret)) {
      continue
    }
    // 已存在的条目必须一致；不同值说明新旧数据冲突，不能静默选择其中一份。
    if (await readCredentialEntry(entryPath) !== secret) {
      throw new LegacyCredentialMigrationError()
    }
  }
  // 迁移完成后改名保留备份，并防止下次启动重复迁移。
  // 目标已存在时不能覆盖：那可能是上一次迁移的备份，里面还有别处没有的条目。
  await rename(input.legacyFilePath, await chooseBackupPath(input.legacyFilePath)).catch(() => {
    throw new CredentialStoreUnavailableError()
  })
  return { migrated: entries.length }
}

async function chooseBackupPath(legacyFilePath: string): Promise<string> {
  const preferred = `${legacyFilePath}.migrated`
  if (!await pathExists(preferred)) {
    return preferred
  }
  return `${legacyFilePath}.migrated-${randomUUID()}`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return false
    }
    throw new CredentialStoreUnavailableError()
  }
}

async function readLegacyFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return null
    }
    throw new CredentialStoreUnavailableError()
  }
}

function parseLegacyEntries(content: string): ReadonlyArray<readonly [string, string]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new CredentialStoreUnavailableError()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CredentialStoreUnavailableError()
  }
  const entries: Array<readonly [string, string]> = []
  for (const [reference, secret] of Object.entries(parsed as Record<string, unknown>)) {
    // 旧引用的形状与新引用一致；不合法说明文件被篡改或损坏，整体 fail-closed。
    if (!SAFE_REFERENCE_PATTERN.test(reference)
      || typeof secret !== 'string'
      || !isCredentialValueValid(secret)) {
      throw new CredentialStoreUnavailableError()
    }
    entries.push([reference, secret])
  }
  return entries
}
