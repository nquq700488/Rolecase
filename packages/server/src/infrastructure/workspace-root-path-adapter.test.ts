import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { NodeWorkspaceRootPathAdapter } from './workspace-root-path-adapter.js'

describe('NodeWorkspaceRootPathAdapter', () => {
  let temporaryDirectory: string
  let adapter: NodeWorkspaceRootPathAdapter

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'rolecast-root-path-'))
    adapter = new NodeWorkspaceRootPathAdapter()
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('返回现存目录的 canonical 路径', async () => {
    const directory = join(temporaryDirectory, 'workspace')
    await mkdir(directory)

    await expect(adapter.resolveExistingDirectory(directory)).resolves.toBe(await realpath(directory))
  })

  it('拒绝相对路径', async () => {
    await expect(adapter.resolveExistingDirectory('relative/workspace')).rejects.toThrow()
  })

  it('拒绝不存在的路径', async () => {
    await expect(adapter.resolveExistingDirectory(join(temporaryDirectory, 'missing'))).rejects.toThrow()
  })

  it('拒绝普通文件', async () => {
    const filePath = join(temporaryDirectory, 'file')
    await writeFile(filePath, '')

    await expect(adapter.resolveExistingDirectory(filePath)).rejects.toThrow()
  })

  it('接受目录符号链接并返回目标 canonical 路径', async () => {
    const directory = join(temporaryDirectory, 'workspace')
    const alias = join(temporaryDirectory, 'workspace-alias')
    await mkdir(directory)
    await symlink(directory, alias, 'dir')

    await expect(adapter.resolveExistingDirectory(alias)).resolves.toBe(await realpath(directory))
  })

  it('拒绝悬空符号链接', async () => {
    const danglingAlias = join(temporaryDirectory, 'dangling')
    await symlink(join(temporaryDirectory, 'missing'), danglingAlias, 'dir')

    await expect(adapter.resolveExistingDirectory(danglingAlias)).rejects.toThrow()
  })
})
