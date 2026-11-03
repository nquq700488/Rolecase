import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import {
  roleBindingDtoSchema,
  roleDtoSchema,
  type RoleBindingDto,
  type RoleDto,
} from '@rolecast/contract'

import {
  WORKSPACE_CONFIG_SCHEMA_VERSION,
  WorkspaceConfigConflictError,
  WorkspaceConfigPathError,
  WorkspaceConfigUnavailableError,
  type WorkspaceConfigDraft,
  type WorkspaceConfigMutation,
  type WorkspaceConfigPort,
  type WorkspaceConfigSnapshot,
} from '../../application/ports/workspace-config-port.js'

interface WorkspaceConfigFile {
  readonly workspace_id: string
  readonly schema_version: typeof WORKSPACE_CONFIG_SCHEMA_VERSION
  readonly version: number
  readonly roles: readonly RoleDto[]
  readonly bindings: readonly RoleBindingDto[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseWorkspaceConfigFile = (value: unknown): WorkspaceConfigFile => {
  if (!isRecord(value)) {
    throw new WorkspaceConfigUnavailableError('Workspace 配置必须是对象')
  }
  const expectedKeys = new Set(['workspace_id', 'schema_version', 'version', 'roles', 'bindings'])
  const keys = Object.keys(value)
  if (keys.some((key) => !expectedKeys.has(key)) || keys.length !== expectedKeys.size) {
    throw new WorkspaceConfigUnavailableError('Workspace 配置包含未知字段')
  }
  if (typeof value.workspace_id !== 'string' || value.workspace_id.length === 0) {
    throw new WorkspaceConfigUnavailableError('Workspace 配置缺少 workspace_id')
  }
  if (value.schema_version !== WORKSPACE_CONFIG_SCHEMA_VERSION) {
    throw new WorkspaceConfigUnavailableError('不支持的 Workspace 配置版本')
  }
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 0) {
    throw new WorkspaceConfigUnavailableError('Workspace 配置 version 无效')
  }
  if (!Array.isArray(value.roles) || !Array.isArray(value.bindings)) {
    throw new WorkspaceConfigUnavailableError('Workspace 配置集合无效')
  }
  const roles: RoleDto[] = []
  for (const role of value.roles) {
    const parsed = roleDtoSchema.safeParse(role)
    if (!parsed.success) {
      throw new WorkspaceConfigUnavailableError('Workspace Role 配置无效', { cause: parsed.error })
    }
    roles.push(parsed.data)
  }
  const bindings: RoleBindingDto[] = []
  for (const binding of value.bindings) {
    const parsed = roleBindingDtoSchema.safeParse(binding)
    if (!parsed.success) {
      throw new WorkspaceConfigUnavailableError('Workspace RoleBinding 配置无效', { cause: parsed.error })
    }
    bindings.push(parsed.data)
  }
  return {
    workspace_id: value.workspace_id,
    schema_version: WORKSPACE_CONFIG_SCHEMA_VERSION,
    version: value.version,
    roles,
    bindings,
  }
}

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

const toSnapshot = (file: WorkspaceConfigFile): WorkspaceConfigSnapshot => ({
  workspaceId: file.workspace_id,
  schemaVersion: file.schema_version,
  version: file.version,
  roles: file.roles.map((role) => ({ ...role })),
  bindings: file.bindings.map((binding) => ({ ...binding, runtime_options: { ...binding.runtime_options } })),
})

const toFile = (draft: WorkspaceConfigDraft, version: number): WorkspaceConfigFile => ({
  workspace_id: draft.workspaceId,
  schema_version: WORKSPACE_CONFIG_SCHEMA_VERSION,
  version,
  roles: draft.roles.map((role) => ({ ...role })),
  bindings: draft.bindings.map((binding) => ({ ...binding, runtime_options: { ...binding.runtime_options } })),
})

/**
 * @name JsonWorkspaceConfig
 * @description 实现 Workspace JSON 配置的安全路径、异步串行 mutation 和原子写入
 */
export class JsonWorkspaceConfig implements WorkspaceConfigPort {
  private readonly rootDirectory: string
  private readonly locks = new Map<string, Promise<void>>()

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory)
  }

  async read(workspaceId: string): Promise<WorkspaceConfigSnapshot> {
    return this.readUnlocked(workspaceId)
  }

  async list(): Promise<WorkspaceConfigSnapshot[]> {
    const workspacesDirectory = await this.prepareWorkspacesDirectory()
    let entries
    try {
      entries = await readdir(workspacesDirectory, { withFileTypes: true })
    } catch (error: unknown) {
      throw this.unavailable('读取 Workspace 配置目录失败', error)
    }

    const snapshots: WorkspaceConfigSnapshot[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      if (!/^[a-f0-9]{64}$/.test(entry.name)) {
        throw new WorkspaceConfigPathError('Workspace 配置目录名无效')
      }
      const directory = join(workspacesDirectory, entry.name)
      await this.rejectSymlink(directory, 'Workspace 配置目录')
      const filePath = join(directory, 'config.json')
      if (!(await this.exists(filePath))) {
        continue
      }
      snapshots.push(await this.readFileSnapshot(filePath))
    }
    return snapshots
  }

  async mutate<T>(
    workspaceId: string,
    expectedVersion: number,
    operation: (current: WorkspaceConfigSnapshot) => Promise<WorkspaceConfigMutation<T>>,
  ): Promise<T> {
    const lockKey = this.workspaceKey(workspaceId)
    const previous = this.locks.get(lockKey) ?? Promise.resolve()
    let release: () => void = () => undefined
    const currentLock = new Promise<void>((resolveLock) => {
      release = resolveLock
    })
    const queued = previous.then(() => currentLock)
    this.locks.set(lockKey, queued)
    await previous

    try {
      const current = await this.readUnlocked(workspaceId)
      if (current.version !== expectedVersion) {
        throw new WorkspaceConfigConflictError()
      }
      const mutation = await operation(current)
      this.validateDraft(workspaceId, mutation.draft)
      await this.writeUnlocked(toFile(mutation.draft, current.version + 1))
      return mutation.value
    } finally {
      release()
      if (this.locks.get(lockKey) === queued) {
        this.locks.delete(lockKey)
      }
    }
  }

  private async readUnlocked(workspaceId: string): Promise<WorkspaceConfigSnapshot> {
    const paths = await this.prepareWorkspacePaths(workspaceId)
    try {
      return await this.readFileSnapshot(paths.filePath, workspaceId)
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return {
          workspaceId,
          schemaVersion: WORKSPACE_CONFIG_SCHEMA_VERSION,
          version: 0,
          roles: [],
          bindings: [],
        }
      }
      if (error instanceof WorkspaceConfigPathError || error instanceof WorkspaceConfigUnavailableError) {
        throw error
      }
      throw this.unavailable('读取 Workspace 配置失败', error)
    }
  }

  private async readFileSnapshot(filePath: string, expectedWorkspaceId?: string): Promise<WorkspaceConfigSnapshot> {
    await this.rejectSymlink(filePath, 'Workspace 配置文件')
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error: unknown) {
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error: unknown) {
      throw this.unavailable('Workspace 配置 JSON 格式无效', error)
    }
    const file = parseWorkspaceConfigFile(parsed)
    if (expectedWorkspaceId !== undefined && file.workspace_id !== expectedWorkspaceId) {
      throw new WorkspaceConfigPathError('Workspace 配置归属不一致')
    }
    return toSnapshot(file)
  }

  private async writeUnlocked(file: WorkspaceConfigFile): Promise<void> {
    const paths = await this.prepareWorkspacePaths(file.workspace_id)
    const validated = parseWorkspaceConfigFile(file)
    const temporaryPath = join(paths.directory, `config.json.${randomUUID()}.tmp`)
    const serialized = `${JSON.stringify(validated, null, 2)}\n`
    try {
      if (await this.exists(paths.filePath)) {
        await copyFile(paths.filePath, `${paths.filePath}.bak-${Date.now()}-${randomUUID().slice(0, 8)}`)
      }
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await chmod(temporaryPath, 0o600)
      await rename(temporaryPath, paths.filePath)
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw this.unavailable('Workspace 配置原子写入失败', error)
    }
    try {
      await this.pruneBackups(paths.directory)
    } catch {
      // 配置已原子提交；备份清理失败不回报为写入失败，避免调用方误重试覆盖新版本。
    }
  }

  private async prepareWorkspacePaths(workspaceId: string): Promise<{
    readonly directory: string
    readonly filePath: string
  }> {
    const workspacesDirectory = await this.prepareWorkspacesDirectory()
    const directory = join(workspacesDirectory, this.workspaceKey(workspaceId))
    try {
      await this.rejectSymlink(directory, 'Workspace 配置目录')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await this.rejectSymlink(directory, 'Workspace 配置目录')
      await chmod(directory, 0o700)
    } catch (error: unknown) {
      if (error instanceof WorkspaceConfigPathError) {
        throw error
      }
      throw this.unavailable('创建 Workspace 配置目录失败', error)
    }
    const realDirectory = await this.realPathInside(workspacesDirectory, directory)
    const filePath = join(realDirectory, 'config.json')
    if (await this.exists(filePath)) {
      await this.rejectSymlink(filePath, 'Workspace 配置文件')
    }
    return { directory: realDirectory, filePath }
  }

  private async prepareWorkspacesDirectory(): Promise<string> {
    try {
      await this.rejectSymlink(this.rootDirectory, '配置根目录')
      await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 })
      await this.rejectSymlink(this.rootDirectory, '配置根目录')
      await chmod(this.rootDirectory, 0o700)
      const root = await this.realPathInside(this.rootDirectory, this.rootDirectory)
      const workspacesDirectory = join(root, 'workspaces')
      await this.rejectSymlink(workspacesDirectory, 'Workspace 配置根目录')
      await mkdir(workspacesDirectory, { recursive: true, mode: 0o700 })
      await this.rejectSymlink(workspacesDirectory, 'Workspace 配置根目录')
      await chmod(workspacesDirectory, 0o700)
      return await this.realPathInside(root, workspacesDirectory)
    } catch (error: unknown) {
      if (error instanceof WorkspaceConfigPathError || error instanceof WorkspaceConfigUnavailableError) {
        throw error
      }
      throw this.unavailable('准备 Workspace 配置目录失败', error)
    }
  }

  private async realPathInside(root: string, candidate: string): Promise<string> {
    const lexicalRoot = resolve(root)
    const lexicalCandidate = resolve(candidate)
    const lexicalRelativePath = relative(lexicalRoot, lexicalCandidate)
    if (lexicalRelativePath.startsWith('..') || lexicalRelativePath.includes('..' + '/')) {
      throw new WorkspaceConfigPathError('配置路径越出允许目录')
    }
    const resolvedRoot = await realpath(lexicalRoot)
    const resolvedCandidate = await realpath(lexicalCandidate)
    const relativePath = relative(resolvedRoot, resolvedCandidate)
    if (relativePath.startsWith('..') || relativePath.includes('..' + '/')) {
      throw new WorkspaceConfigPathError('配置路径越出允许目录')
    }
    return resolvedCandidate
  }

  private async rejectSymlink(path: string, label: string): Promise<void> {
    try {
      const stats = await lstat(path)
      if (stats.isSymbolicLink()) {
        throw new WorkspaceConfigPathError(`${label}不能是符号链接`)
      }
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return
      }
      throw error
    }
  }

  private async pruneBackups(directory: string): Promise<void> {
    const entries = await readdir(directory)
    const backups = entries
      .filter((entry) => /^config\.json\.bak-\d+-[a-f0-9-]+$/.test(entry))
      .sort()
      .reverse()
    await Promise.all(backups.slice(3).map((backup) => rm(join(directory, backup), { force: true })))
  }

  private workspaceKey(workspaceId: string): string {
    return createHash('sha256').update(workspaceId, 'utf8').digest('hex')
  }

  private validateDraft(workspaceId: string, draft: WorkspaceConfigDraft): void {
    if (draft.workspaceId !== workspaceId) {
      throw new WorkspaceConfigPathError('Workspace 配置草稿归属不一致')
    }
    if (draft.schemaVersion !== WORKSPACE_CONFIG_SCHEMA_VERSION) {
      throw new WorkspaceConfigUnavailableError('不支持的 Workspace 配置版本')
    }
  }

  private unavailable(message: string, cause: unknown): WorkspaceConfigUnavailableError {
    return new WorkspaceConfigUnavailableError(message, { cause })
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return false
      }
      throw error
    }
  }
}
