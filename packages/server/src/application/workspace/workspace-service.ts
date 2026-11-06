import type {
  CreateWorkspaceRequest,
  SetWorkspaceRootPathRequest,
  WorkspaceDto,
  WorkspaceRootPathDto,
} from '@rolecast/contract'

import { createWorkspace } from '../../domain/index.js'
import { ApplicationError } from '../errors.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import type { RepositoryPort } from '../ports/repository-port.js'
import type { WorkspaceRootPathPort } from '../ports/workspace-root-path-port.js'

/** Workspace 用例服务。 */
export class WorkspaceService {
  constructor(
    private readonly repository: RepositoryPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly rootPaths: WorkspaceRootPathPort,
  ) {}

  /** 创建 Workspace，并只持久化 filesystem Port 返回的 canonical 根路径。 */
  async create(input: CreateWorkspaceRequest): Promise<WorkspaceDto> {
    const rootPath = await this.resolveRootPath(input.root_path)
    const workspace = createWorkspace({
      id: this.ids.next('workspace'),
      name: input.name,
      rootPath,
      now: this.clock.now(),
    })
    const dto: WorkspaceDto = {
      id: workspace.id,
      name: workspace.name,
      created_at: workspace.createdAt.toISOString(),
      updated_at: workspace.updatedAt.toISOString(),
    }
    try {
      const result = await this.repository.createWorkspaceWithRootPath(dto, rootPath)
      if (result === 'duplicate') {
        throw this.duplicateRootPathError()
      }
      return dto
    } catch (error: unknown) {
      if (error instanceof ApplicationError) {
        throw error
      }
      throw new ApplicationError('Workspace 创建失败', 'state_conflict', 409)
    }
  }

  /** 列出全部 Workspace。 */
  list(): Promise<WorkspaceDto[]> {
    return this.repository.listWorkspaces()
  }

  /** 获取 Workspace，不存在时返回稳定错误。 */
  async require(id: string): Promise<WorkspaceDto> {
    const workspace = await this.repository.getWorkspace(id)
    if (workspace === null) {
      throw this.workspaceNotFoundError()
    }
    return workspace
  }

  /** 读取 Workspace 根路径状态；未配置时保留 root_path=null。 */
  async getRootPath(id: string): Promise<WorkspaceRootPathDto> {
    const rootPath = await this.repository.getWorkspaceRootPath(id)
    if (rootPath === null) {
      throw this.workspaceNotFoundError()
    }
    return rootPath
  }

  /** 为迁移后的旧 Workspace 一次性设置根路径，不允许覆盖已有值。 */
  async setRootPath(id: string, input: SetWorkspaceRootPathRequest): Promise<WorkspaceRootPathDto> {
    const current = await this.repository.getWorkspaceRootPath(id)
    if (current === null) {
      throw this.workspaceNotFoundError()
    }
    if (current.root_path !== null) {
      throw this.rootPathAlreadyConfiguredError()
    }

    const rootPath = await this.resolveRootPath(input.root_path)
    const result = await this.repository.setWorkspaceRootPathIfUnconfigured(id, rootPath)
    if (result === 'not_found') {
      throw this.workspaceNotFoundError()
    }
    if (result === 'already_configured') {
      throw this.rootPathAlreadyConfiguredError()
    }
    if (result === 'duplicate') {
      throw this.duplicateRootPathError()
    }
    return { workspace_id: id, root_path: rootPath }
  }

  private async resolveRootPath(path: string): Promise<string> {
    try {
      return await this.rootPaths.resolveExistingDirectory(path)
    } catch {
      throw new ApplicationError('根目录路径无效，请输入本机服务端可访问的现存目录', 'workspace_root_invalid', 422)
    }
  }

  private workspaceNotFoundError(): ApplicationError {
    return new ApplicationError('Workspace 不存在', 'not_found', 404, { resource: 'workspace' })
  }

  private rootPathAlreadyConfiguredError(): ApplicationError {
    return new ApplicationError('Workspace 根目录已设置，不能再次修改', 'workspace_root_already_configured', 409)
  }

  private duplicateRootPathError(): ApplicationError {
    return new ApplicationError('该目录已由另一个 Workspace 使用', 'workspace_root_duplicate', 409)
  }
}
