import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  WorkspaceConfigConflictError,
  WorkspaceConfigPathError,
  type WorkspaceConfigDraft,
} from '../../application/ports/workspace-config-port.js'
import { JsonWorkspaceConfig } from './json-workspace-config.js'

describe('JsonWorkspaceConfig', () => {
  it('首次读取返回空 Workspace 配置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rolecast-config-'))
    const config = new JsonWorkspaceConfig(root)

    await expect(config.read('workspace-001')).resolves.toMatchObject({
      workspaceId: 'workspace-001',
      schemaVersion: 1,
      version: 0,
      roles: [],
      bindings: [],
    })
  })

  it('在同一 Workspace 内串行执行 async mutation 并拒绝旧 CAS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rolecast-config-'))
    const config = new JsonWorkspaceConfig(root)
    const draft = (workspaceId: string): WorkspaceConfigDraft => ({
      workspaceId,
      schemaVersion: 1,
      roles: [],
      bindings: [],
    })

    const first = config.mutate('workspace-001', 0, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { value: 'first', draft: draft('workspace-001') }
    })
    const second = config.mutate('workspace-001', 0, async () => ({
      value: 'second',
      draft: draft('workspace-001'),
    }))

    await expect(first).resolves.toBe('first')
    await expect(second).rejects.toBeInstanceOf(WorkspaceConfigConflictError)
    await expect(config.read('workspace-001')).resolves.toMatchObject({ version: 1 })
  })

  it('配置文件使用安全 hash 目录并在替换时留下有限备份', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rolecast-config-'))
    const config = new JsonWorkspaceConfig(root)
    const workspaceId = '../workspace/with-slash'
    const makeDraft = (): WorkspaceConfigDraft => ({
      workspaceId,
      schemaVersion: 1,
      roles: [],
      bindings: [],
    })

    await config.mutate(workspaceId, 0, async () => ({ value: null, draft: makeDraft() }))
    await config.mutate(workspaceId, 1, async () => ({ value: null, draft: makeDraft() }))

    const workspaceEntries = await readdir(join(root, 'workspaces'), { withFileTypes: true })
    expect(workspaceEntries).toHaveLength(1)
    expect(workspaceEntries[0]?.name).toMatch(/^[a-f0-9]{64}$/)
    const files = await readdir(join(root, 'workspaces', workspaceEntries[0]?.name ?? ''))
    expect(files.some((file) => file.startsWith('config.json.bak-'))).toBe(true)
    const content = await readFile(join(root, 'workspaces', workspaceEntries[0]?.name ?? '', 'config.json'), 'utf8')
    expect(JSON.parse(content)).toMatchObject({ version: 2, workspace_id: workspaceId })
  })

  it('在写入前拒绝预置的 Workspace 目录符号链接', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rolecast-config-'))
    const external = await mkdtemp(join(tmpdir(), 'rolecast-external-'))
    const workspaceId = 'workspace-symlink'
    const workspaceKey = createHash('sha256').update(workspaceId, 'utf8').digest('hex')
    await mkdir(join(root, 'workspaces'), { recursive: true })
    await symlink(external, join(root, 'workspaces', workspaceKey), 'dir')
    const config = new JsonWorkspaceConfig(root)

    await expect(config.read(workspaceId)).rejects.toBeInstanceOf(WorkspaceConfigPathError)
  })
})
