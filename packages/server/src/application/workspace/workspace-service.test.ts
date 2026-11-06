import { afterEach, describe, expect, it } from 'vitest'

import { SqliteDatabase } from '../../infrastructure/persistence/sqlite-database.js'
import { SqliteRepository } from '../../infrastructure/persistence/sqlite-repository.js'
import { WorkspaceService } from './workspace-service.js'

const FIXED_TIME = '2026-11-04T10:00:00.000Z'

function createFixture(): { database: SqliteDatabase; repository: SqliteRepository } {
  const database = new SqliteDatabase(':memory:')
  return { database, repository: new SqliteRepository(database) }
}

describe('WorkspaceService', () => {
  let database: SqliteDatabase | null = null

  afterEach(() => {
    database?.close()
    database = null
  })

  it('无效根路径不会创建 Workspace', async () => {
    const fixture = createFixture()
    database = fixture.database
    const service = new WorkspaceService(
      fixture.repository,
      { next: () => 'workspace-root-invalid' },
      { now: () => new Date(FIXED_TIME) },
      { resolveExistingDirectory: async () => { throw new Error('invalid directory') } },
    )

    await expect(service.create({ name: '无效路径', root_path: 'relative/path' }))
      .rejects.toMatchObject({ code: 'workspace_root_invalid', statusCode: 422 })
    expect(await fixture.repository.listWorkspaces()).toEqual([])
  })

  it('校验并规范化根路径后才创建 Workspace', async () => {
    const fixture = createFixture()
    database = fixture.database
    const rootPathPort = {
      resolveExistingDirectory: async (path: string): Promise<string> => {
        expect(path).toBe('/input/workspace')
        return '/canonical/workspace'
      },
    }
    const service = new WorkspaceService(
      fixture.repository,
      { next: () => 'workspace-root-001' },
      { now: () => new Date(FIXED_TIME) },
      rootPathPort,
    )

    const workspace = await service.create({ name: '测试工作区', root_path: '/input/workspace' })
    const storedRoot = fixture.database
      .prepare('SELECT root_path FROM workspaces WHERE id = ?')
      .get(workspace.id) as { root_path: string | null }

    expect(storedRoot.root_path).toBe('/canonical/workspace')
  })
})
