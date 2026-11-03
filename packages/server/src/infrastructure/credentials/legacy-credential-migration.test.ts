import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CredentialStoreUnavailableError } from '../../application/ports/credential-store-port.js'
import { FileCredentialStore } from './file-credential-store.js'
import {
  LegacyCredentialMigrationError,
  migrateLegacyFileCredentials,
} from './legacy-credential-migration.js'

const legacyReference = 'credential-11111111-1111-1111-1111-111111111111'

describe('旧版凭据文件迁移', () => {
  let directory: string
  let legacyPath: string
  let credentialsDirectory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rolecast-migration-'))
    legacyPath = join(directory, 'credentials.json')
    credentialsDirectory = join(directory, 'credentials')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('把旧条目迁移为逐条目文件并保留引用', async () => {
    await writeFile(legacyPath, JSON.stringify({ [legacyReference]: 'test-secret' }), { mode: 0o600 })

    await expect(migrateLegacyFileCredentials({
      legacyFilePath: legacyPath,
      directoryPath: credentialsDirectory,
    })).resolves.toEqual({ migrated: 1 })

    const store = new FileCredentialStore(credentialsDirectory)
    await expect(store.get(legacyReference)).resolves.toBe('test-secret')
    // 旧文件改名保留，避免下次启动重复迁移。
    await expect(readFile(`${legacyPath}.migrated`, 'utf8')).resolves.toContain(legacyReference)
  })

  it('没有旧文件时不做任何事', async () => {
    await expect(migrateLegacyFileCredentials({
      legacyFilePath: legacyPath,
      directoryPath: credentialsDirectory,
    })).resolves.toEqual({ migrated: 0 })
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('旧文件损坏时 fail-closed 且不迁移', async () => {
    await writeFile(legacyPath, JSON.stringify({ [legacyReference]: '' }), { mode: 0o600 })

    await expect(migrateLegacyFileCredentials({
      legacyFilePath: legacyPath,
      directoryPath: credentialsDirectory,
    })).rejects.toBeInstanceOf(CredentialStoreUnavailableError)
    await expect(readdir(directory)).resolves.toEqual(['credentials.json'])
  })

  it('新旧数据冲突时报可执行错误且保留旧文件', async () => {
    await writeFile(legacyPath, JSON.stringify({ [legacyReference]: 'old-secret' }), { mode: 0o600 })
    await mkdir(credentialsDirectory, { recursive: true, mode: 0o700 })
    await writeFile(
      join(credentialsDirectory, `${legacyReference}.json`),
      JSON.stringify({ secret: 'new-secret' }),
      { mode: 0o600 },
    )

    await expect(migrateLegacyFileCredentials({
      legacyFilePath: legacyPath,
      directoryPath: credentialsDirectory,
    })).rejects.toBeInstanceOf(LegacyCredentialMigrationError)
    await expect(readFile(legacyPath, 'utf8')).resolves.toContain('old-secret')
  })

  it('已有备份时不覆盖旧备份，改用唯一备份名', async () => {
    await writeFile(legacyPath, JSON.stringify({ [legacyReference]: 'test-secret' }), { mode: 0o600 })
    await writeFile(`${legacyPath}.migrated`, 'previous-backup', { mode: 0o600 })

    await migrateLegacyFileCredentials({
      legacyFilePath: legacyPath,
      directoryPath: credentialsDirectory,
    })

    await expect(readFile(`${legacyPath}.migrated`, 'utf8')).resolves.toBe('previous-backup')
    const backups = (await readdir(directory))
      .filter((name) => name.startsWith('credentials.json.migrated'))
    expect(backups.length).toBe(2)
  })

  it('重复迁移相同值保持幂等', async () => {
    await writeFile(legacyPath, JSON.stringify({ [legacyReference]: 'test-secret' }), { mode: 0o600 })
    await mkdir(credentialsDirectory, { recursive: true, mode: 0o700 })
    await writeFile(
      join(credentialsDirectory, `${legacyReference}.json`),
      JSON.stringify({ secret: 'test-secret' }),
      { mode: 0o600 },
    )

    await expect(migrateLegacyFileCredentials({
      legacyFilePath: legacyPath,
      directoryPath: credentialsDirectory,
    })).resolves.toEqual({ migrated: 1 })
  })
})
