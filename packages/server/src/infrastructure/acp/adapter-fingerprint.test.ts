import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { computeAdapterFingerprint } from './adapter-fingerprint.js'

describe('computeAdapterFingerprint', () => {
  it('同路径内容替换会改变指纹', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-fingerprint-'))
    try {
      const entry = join(directory, 'adapter.js')
      await writeFile(entry, 'console.log("a")\n', 'utf8')
      const first = await computeAdapterFingerprint({
        providerKind: 'claude',
        command: process.execPath,
        args: [entry],
      })
      await writeFile(entry, 'console.log("b")\n', 'utf8')
      const second = await computeAdapterFingerprint({
        providerKind: 'claude',
        command: process.execPath,
        args: [entry],
      })

      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect(first).not.toBe(second)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('override 改变参数会改变指纹（版本号相同）', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-fingerprint-args-'))
    try {
      const a = join(directory, 'a.js')
      const b = join(directory, 'b.js')
      await writeFile(a, 'same\n', 'utf8')
      await writeFile(b, 'same\n', 'utf8')

      const first = await computeAdapterFingerprint({ providerKind: 'claude', command: process.execPath, args: [a] })
      const second = await computeAdapterFingerprint({ providerKind: 'claude', command: process.execPath, args: [b] })
      expect(first).not.toBe(second)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('同路径可执行文件内容替换会改变指纹（固定 adapter_version 下）', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-fingerprint-exec-'))
    try {
      const executable = join(directory, 'adapter-bin')
      const entry = join(directory, 'entry.js')
      await writeFile(executable, 'binary-a\n', 'utf8')
      await writeFile(entry, 'entry\n', 'utf8')

      const first = await computeAdapterFingerprint({ providerKind: 'claude', command: executable, args: [entry] })
      await writeFile(executable, 'binary-b\n', 'utf8')
      const second = await computeAdapterFingerprint({ providerKind: 'claude', command: executable, args: [entry] })

      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect(first).not.toBe(second)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('无法确认入口时返回 null（fail-closed）', async () => {
    await expect(computeAdapterFingerprint({
      providerKind: 'claude',
      command: '/path/that/does/not/exist',
      args: ['/also/missing.js'],
    })).resolves.toBeNull()
  })

  it('可执行文件存在但入口文件缺失时返回 null（fail-closed）', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-fingerprint-missing-entry-'))
    try {
      const missing = join(directory, 'missing-entry.js')
      await expect(computeAdapterFingerprint({
        providerKind: 'claude',
        command: process.execPath,
        args: [missing],
      })).resolves.toBeNull()
      // 只有 flag、没有任何可验证入口时同样不做可恢复承诺。
      await expect(computeAdapterFingerprint({
        providerKind: 'claude',
        command: process.execPath,
        args: ['--experimental-strip-types'],
      })).resolves.toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('flag 后的入口文件仍参与内容指纹', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-fingerprint-flag-entry-'))
    try {
      const entry = join(directory, 'adapter.js')
      await writeFile(entry, 'console.log("a")\n', 'utf8')
      const first = await computeAdapterFingerprint({
        providerKind: 'claude',
        command: process.execPath,
        args: ['--no-warnings', entry],
      })
      await writeFile(entry, 'console.log("b")\n', 'utf8')
      const second = await computeAdapterFingerprint({
        providerKind: 'claude',
        command: process.execPath,
        args: ['--no-warnings', entry],
      })
      expect(first).not.toBeNull()
      expect(first).not.toBe(second)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('指纹不含原始路径或参数', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-fingerprint-secret-'))
    try {
      const entry = join(directory, 'adapter.js')
      await writeFile(entry, 'content\n', 'utf8')
      const canaryPath = join(directory, 'CANARY_PATH_9f3a.js')
      await writeFile(canaryPath, 'x\n', 'utf8')
      const fingerprint = await computeAdapterFingerprint({
        providerKind: 'codex',
        command: process.execPath,
        args: [entry, 'CANARY_ARG_7c1e'],
      })
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(fingerprint).not.toContain('CANARY')
      expect(fingerprint).not.toContain(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
