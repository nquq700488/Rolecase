import type { WorkspaceDto, WorkspaceRootPathDto } from '@rolecast/contract'

import { toWorkspace, toWorkspaceRootPath } from './sqlite-mappers.js'
import { SqliteDatabase } from './sqlite-database.js'

type Row = Record<string, unknown>

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE'
}

/**
 * @name SqliteWorkspaceStore
 * @description 持久化 Workspace 基础记录与一次性根路径配置
 */
export class SqliteWorkspaceStore {
  constructor(private readonly database: SqliteDatabase) {}

  /** 保存未配置根路径的 Workspace，供迁移和测试场景使用。 */
  create(workspace: WorkspaceDto): WorkspaceDto {
    this.database
      .prepare(
        `INSERT INTO workspaces(id, name, created_at, updated_at)
         VALUES (@id, @name, @created_at, @updated_at)`,
      )
      .run(workspace)
    return workspace
  }

  /** 原子创建 Workspace 与 canonical 根路径；唯一冲突返回 duplicate。 */
  createWithRootPath(workspace: WorkspaceDto, rootPath: string): 'created' | 'duplicate' {
    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO workspaces(id, name, created_at, updated_at, root_path)
             VALUES (@id, @name, @created_at, @updated_at, @root_path)`,
          )
          .run({ ...workspace, root_path: rootPath })
      })
      return 'created'
    } catch (error: unknown) {
      if (isUniqueConstraint(error) && this.isRootPathInUse(rootPath)) {
        return 'duplicate'
      }
      throw error
    }
  }

  /** 列出 Workspace。 */
  list(): WorkspaceDto[] {
    const rows = this.database
      .prepare('SELECT id, name, created_at, updated_at FROM workspaces ORDER BY updated_at DESC, id')
      .all() as Row[]
    return rows.map(toWorkspace)
  }

  /** 获取 Workspace；不存在时返回 null。 */
  get(id: string): WorkspaceDto | null {
    const row = this.database
      .prepare('SELECT id, name, created_at, updated_at FROM workspaces WHERE id = ?')
      .get(id) as Row | undefined
    return row === undefined ? null : toWorkspace(row)
  }

  /** 获取 Workspace 根路径配置；未知 Workspace 返回 null。 */
  getRootPath(id: string): WorkspaceRootPathDto | null {
    const row = this.database
      .prepare('SELECT id, root_path FROM workspaces WHERE id = ?')
      .get(id) as Row | undefined
    return row === undefined ? null : toWorkspaceRootPath(row)
  }

  /** 仅将 NULL 根路径设置一次；重复、已配置和不存在分别返回稳定结果。 */
  setRootPathIfUnconfigured(
    id: string,
    rootPath: string,
  ): 'configured' | 'duplicate' | 'already_configured' | 'not_found' {
    try {
      const result = this.database
        .prepare('UPDATE workspaces SET root_path = ? WHERE id = ? AND root_path IS NULL')
        .run(rootPath, id)
      if (result.changes === 1) {
        return 'configured'
      }
    } catch (error: unknown) {
      if (isUniqueConstraint(error) && this.isRootPathInUse(rootPath)) {
        return 'duplicate'
      }
      throw error
    }

    return this.getRootPath(id) === null ? 'not_found' : 'already_configured'
  }

  private isRootPathInUse(rootPath: string): boolean {
    return this.database.prepare('SELECT 1 FROM workspaces WHERE root_path = ?').get(rootPath) !== undefined
  }
}
