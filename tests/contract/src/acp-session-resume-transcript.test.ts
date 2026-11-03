import type { Dirent } from 'node:fs'
import { lstat, mkdir, mkdtemp, opendir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  attachTranscriptEvidence,
  describeClaudeTranscript,
  type TranscriptDirectory,
} from './acp-session-resume-transcript.js'

const sessionId = '11111111-2222-3333-4444-555555555555'
const canary = 'synthetic-transcript-canary'

const createLayout = async () => {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-transcript-')))
  const adapterRoot = join(parentRoot, 'adapter')
  await mkdir(adapterRoot, { mode: 0o700 })
  return { parentRoot, adapterRoot }
}

/** 固定顺序的测试目录句柄，用于消除文件系统遍历顺序的不确定性。 */
const fakeDirectory = (names: readonly string[]): TranscriptDirectory => {
  let index = 0
  return {
    close: async () => undefined,
    [Symbol.asyncIterator]: (): AsyncIterator<Dirent> => ({
      next: async (): Promise<IteratorResult<Dirent>> => {
        if (index >= names.length) {
          return { done: true, value: undefined as never }
        }
        const value = { name: names[index] } as Dirent
        index += 1
        return { done: false, value }
      },
      return: async (): Promise<IteratorResult<Dirent>> => {
        index = names.length
        return { done: true, value: undefined as never }
      },
    }),
  }
}

describe('Claude transcript 元数据诊断', () => {
  it('找到匹配 transcript 时只返回元数据，不读取内容', async () => {
    const { parentRoot, adapterRoot } = await createLayout()
    const projectDir = join(adapterRoot, '.claude', 'projects', 'project-slug')
    await mkdir(projectDir, { recursive: true, mode: 0o700 })
    await writeFile(
      join(projectDir, `${sessionId}.jsonl`),
      `{"role":"user","content":"${canary}"}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )

    try {
      const evidence = await describeClaudeTranscript(adapterRoot, sessionId, canary)
      expect(evidence).toContain(`${sessionId}.jsonl`)
      expect(evidence).toContain('file')
      expect(evidence).toContain('size=')
      expect(evidence).toContain('nlink=')
      expect(evidence).not.toContain(canary)
      expect(evidence).not.toContain('content')
      expect(evidence).not.toContain(parentRoot)
      expect(evidence.length).toBeLessThanOrEqual(240)
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('找不到匹配 transcript 时报告 not-found', async () => {
    const { parentRoot, adapterRoot } = await createLayout()
    const projectDir = join(adapterRoot, '.claude', 'projects', 'project-slug')
    await mkdir(projectDir, { recursive: true, mode: 0o700 })
    await writeFile(join(projectDir, 'other-session.jsonl'), 'unrelated', { encoding: 'utf8', mode: 0o600 })

    try {
      const evidence = await describeClaudeTranscript(adapterRoot, sessionId, canary)
      expect(evidence).toContain('not-found')
      expect(evidence).not.toContain('scan-incomplete')
      expect(evidence).not.toContain('scan-truncated')
      expect(evidence).not.toContain(parentRoot)
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('opendir 失败时报告 scan-incomplete 而不是 not-found', async () => {
    const { parentRoot, adapterRoot } = await createLayout()

    try {
      const evidence = await describeClaudeTranscript(adapterRoot, sessionId, canary, {
        opendir: async () => {
          throw new Error(`EACCES: scandir '${parentRoot}' ${canary}`)
        },
      })
      expect(evidence).toContain('scan-incomplete')
      expect(evidence).toContain('opendir')
      expect(evidence).not.toContain('not-found')
      expect(evidence).not.toContain(canary)
      expect(evidence).not.toContain(parentRoot)
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('lstat 失败时报告 scan-incomplete', async () => {
    const { parentRoot, adapterRoot } = await createLayout()
    await writeFile(join(adapterRoot, 'entry.txt'), 'x', { encoding: 'utf8', mode: 0o600 })

    try {
      const evidence = await describeClaudeTranscript(adapterRoot, sessionId, canary, {
        lstat: async () => {
          throw new Error('EIO: cannot stat')
        },
      })
      expect(evidence).toContain('scan-incomplete')
      expect(evidence).toContain('lstat')
      expect(evidence).not.toContain('not-found')
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('transcript symlink 不跟随且只报告相对路径', async () => {
    const { parentRoot, adapterRoot } = await createLayout()
    const projectDir = join(adapterRoot, '.claude', 'projects', 'project-slug')
    await mkdir(projectDir, { recursive: true, mode: 0o700 })
    const outside = join(parentRoot, 'outside-transcript.jsonl')
    await writeFile(outside, canary, { encoding: 'utf8', mode: 0o600 })
    await symlink(outside, join(projectDir, `${sessionId}.jsonl`))

    try {
      const evidence = await describeClaudeTranscript(adapterRoot, sessionId, canary)
      expect(evidence).toContain(`${sessionId}.jsonl`)
      expect(evidence).toContain('symlink, not followed')
      expect(evidence).toContain('scan-incomplete')
      expect(evidence).not.toContain('not-found')
      expect(evidence).not.toContain('outside-transcript')
      expect(evidence).not.toContain(canary)
      expect(evidence).not.toContain(parentRoot)
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('目录 symlink 不跟随且整体扫描标记为 scan-incomplete', async () => {
    const { parentRoot, adapterRoot } = await createLayout()
    const linkedTarget = join(parentRoot, 'outside-projects')
    await mkdir(linkedTarget, { mode: 0o700 })
    await writeFile(join(linkedTarget, `${sessionId}.jsonl`), canary, { encoding: 'utf8', mode: 0o600 })
    const projectRoot = join(adapterRoot, '.claude', 'projects')
    await mkdir(projectRoot, { recursive: true, mode: 0o700 })
    await symlink(linkedTarget, join(projectRoot, 'linked-project'), 'dir')

    try {
      const evidence = await describeClaudeTranscript(adapterRoot, sessionId, canary)
      expect(evidence).toContain('scan-incomplete')
      expect(evidence).toContain('symlink')
      expect(evidence).toContain('linked-project')
      expect(evidence).not.toContain('not-found')
      expect(evidence).not.toContain('outside-projects')
      expect(evidence).not.toContain(canary)
      expect(evidence).not.toContain(parentRoot)
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('多条匹配时输出有界并标记 scan-truncated', async () => {
    const { parentRoot, adapterRoot } = await createLayout()
    for (let index = 0; index < 8; index += 1) {
      const directory = join(adapterRoot, '.claude', 'projects', `project-${String(index)}`)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, `${sessionId}.jsonl`), 'x', { encoding: 'utf8', mode: 0o600 })
    }

    try {
      const evidence = await describeClaudeTranscript(adapterRoot, sessionId, canary)
      expect(evidence).toContain('scan-truncated')
      expect(evidence).not.toContain('not-found')
      expect(evidence.length).toBeLessThanOrEqual(240)
      expect((evidence.match(new RegExp(sessionId, 'g')) ?? []).length).toBeLessThanOrEqual(5)
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('未匹配但达到深度上限时报告 scan-truncated，不宣称 not-found', async () => {
    const { parentRoot, adapterRoot } = await createLayout()
    let current = adapterRoot
    for (let index = 0; index < 7; index += 1) {
      current = join(current, `level-${String(index)}`)
    }
    await mkdir(current, { recursive: true, mode: 0o700 })

    try {
      const evidence = await describeClaudeTranscript(adapterRoot, sessionId, canary)
      expect(evidence).toContain('scan-truncated')
      expect(evidence).not.toContain('not-found')
      expect(evidence).not.toContain(parentRoot)
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('单目录超过 entry 上限后立即停止消费后续目录项', async () => {
    const { parentRoot, adapterRoot } = await createLayout()
    const bigDirectory = join(adapterRoot, 'big')
    await mkdir(bigDirectory, { mode: 0o700 })
    await Promise.all(Array.from({ length: 120 }, (_, index) => writeFile(
      join(bigDirectory, `file-${String(index).padStart(3, '0')}.txt`),
      'x',
      { encoding: 'utf8', mode: 0o600 },
    )))

    let lstatCalls = 0
    try {
      const evidence = await describeClaudeTranscript(adapterRoot, sessionId, canary, {
        lstat: async (path) => {
          lstatCalls += 1
          return lstat(path)
        },
      })
      // root 的 big 目录项 + 每目录上限内的 100 个文件。
      expect(lstatCalls).toBe(101)
      expect(evidence).toContain('scan-truncated')
      expect(evidence).not.toContain('not-found')
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('全扫描总 entry 上限后立即停止打开后续目录', async () => {
    const { parentRoot, adapterRoot } = await createLayout()
    for (let directoryIndex = 0; directoryIndex < 6; directoryIndex += 1) {
      const directory = join(adapterRoot, `d-${String(directoryIndex)}`)
      await mkdir(directory, { mode: 0o700 })
      await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(
        join(directory, `f-${String(index).padStart(3, '0')}.txt`),
        'x',
        { encoding: 'utf8', mode: 0o600 },
      )))
    }

    let lstatCalls = 0
    try {
      const evidence = await describeClaudeTranscript(adapterRoot, sessionId, canary, {
        lstat: async (path) => {
          lstatCalls += 1
          return lstat(path)
        },
      })
      // 6 个目录项 + 494 个文件后到达全局 500 上限。
      expect(lstatCalls).toBe(500)
      expect(evidence).toContain('scan-truncated')
      expect(evidence).not.toContain('not-found')
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('已发生 symlink 后达到深度上限也必须立即停止遍历', async () => {
    const { parentRoot, adapterRoot } = await createLayout()
    await symlink(join(parentRoot, 'missing-target'), join(adapterRoot, 'a-link'))
    let deep = join(adapterRoot, 'b-deep')
    for (let index = 0; index < 5; index += 1) {
      deep = join(deep, `level-${String(index)}`)
    }
    await mkdir(deep, { recursive: true, mode: 0o700 })
    await Promise.all(Array.from({ length: 5 }, (_, index) => mkdir(
      join(adapterRoot, `c-extra-${String(index)}`),
      { mode: 0o700 },
    )))

    const openCalls: string[] = []
    try {
      const evidence = await describeClaudeTranscript(adapterRoot, sessionId, canary, {
        opendir: async (path) => {
          openCalls.push(path)
          if (path === adapterRoot) {
            return fakeDirectory([
              'a-link', 'b-deep', 'c-extra-0', 'c-extra-1', 'c-extra-2', 'c-extra-3', 'c-extra-4',
            ])
          }
          return opendir(path)
        },
      })
      // root + b-deep + level-0..level-3；到达 depth 6 后不得再访问 c-extra。
      expect(openCalls).toHaveLength(6)
      expect(evidence).toContain('scan-incomplete')
      expect(evidence).toContain('symlink')
      expect(evidence).toContain('scan-truncated')
      expect(evidence).not.toContain('not-found')
      expect(evidence.length).toBeLessThanOrEqual(240)
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('evidence 附加到失败诊断', () => {
    const combined = attachTranscriptEvidence(new Error('base failure'), 'claude transcript metadata: not-found')
    expect(combined.message).toBe('base failure; claude transcript metadata: not-found')
    expect(attachTranscriptEvidence(new Error('base'), null).message).toBe('base')
  })
})
