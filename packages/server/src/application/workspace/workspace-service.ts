import type { CreateWorkspaceRequest, WorkspaceDto } from '@rolecast/contract'

import { createWorkspace } from '../../domain/index.js'
import { ApplicationError } from '../errors.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import type { RepositoryPort } from '../ports/repository-port.js'

/** Workspace 用例服务。 */
export class WorkspaceService {
  constructor(
    private readonly repository: RepositoryPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  /** 创建 Workspace。 */
  async create(input: CreateWorkspaceRequest): Promise<WorkspaceDto> {
    const now = this.clock.now()
    const workspace = createWorkspace({ id: this.ids.next('workspace'), name: input.name, now })
    const dto: WorkspaceDto = {
      id: workspace.id,
      name: workspace.name,
      created_at: workspace.createdAt.toISOString(),
      updated_at: workspace.updatedAt.toISOString(),
    }
    try {
      return await this.repository.createWorkspace(dto)
    } catch (error: unknown) {
      throw new ApplicationError('Workspace 创建失败', 'state_conflict', 409, {
        cause: error instanceof Error ? error.message : 'unknown',
      })
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
      throw new ApplicationError('Workspace 不存在', 'not_found', 404, { resource: 'workspace' })
    }
    return workspace
  }
}
