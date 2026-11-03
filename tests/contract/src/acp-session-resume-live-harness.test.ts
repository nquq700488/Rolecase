import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CredentialStorePort } from '@rolecast/server'

import {
  acquireLiveGateLock,
  buildPromptParams,
  buildSessionNewParams,
  buildSyntheticTranscript,
  containsProxyEvidence,
  evaluateLiveGate,
  hasAdapterProxyEnvironmentFlow,
  hasProxyEvidence,
  LIVE_PROMPT,
  liveGateLockPath,
  pinnedClaudeProxyEvidence,
  readCredentialForLiveGate,
  runLiveGatePreflight,
  validateSyntheticTranscriptShape,
} from './acp-session-resume-live-harness.js'

const supportsPinnedClaudeEvidence = process.platform === 'darwin'
  && (process.arch === 'arm64' || process.arch === 'x64')
  && process.env.CLAUDE_CODE_EXECUTABLE === undefined

class FakeCredentialStore implements CredentialStorePort {
  readonly reads: string[] = []
  constructor(private readonly result: { value?: string | null; error?: unknown }) {}

  async save(): Promise<string> {
    throw new Error('unused')
  }

  async get(reference: string): Promise<string | null> {
    this.reads.push(reference)
    if (this.result.error !== undefined) {
      throw this.result.error
    }
    return this.result.value ?? null
  }

  async validate(): Promise<boolean> {
    return false
  }

  async rotate(): Promise<void> {
    throw new Error('unused')
  }

  async delete(): Promise<void> {
    throw new Error('unused')
  }
}

describe('Claude live gate 前置判定', () => {
  it('默认关闭且所有本地门禁通过前都不允许', () => {
    expect(evaluateLiveGate({ liveEnabled: false, httpsProxyProven: false })).toEqual({
      allowed: false,
      reason: 'gate_disabled',
    })
    expect(evaluateLiveGate({ liveEnabled: true, httpsProxyProven: false, credentialRef: 'ref' })).toEqual({
      allowed: false,
      reason: 'https_proxy_unproven',
    })
    expect(evaluateLiveGate({ liveEnabled: true, httpsProxyProven: true, credentialRef: 'ref' })).toEqual({
      allowed: false,
      reason: 'batch0_incomplete',
    })
    expect(evaluateLiveGate({
      liveEnabled: true,
      httpsProxyProven: true,
      batch0Complete: true,
      credentialRef: 'ref',
    })).toEqual({ allowed: false, reason: 'offline_resume_unproven' })
    expect(evaluateLiveGate({
      liveEnabled: true,
      httpsProxyProven: true,
      batch0Complete: true,
      offlineResumePassed: true,
      credentialRef: 'ref',
    })).toEqual({ allowed: false, reason: 'local_safety_unproven' })
    expect(evaluateLiveGate({
      liveEnabled: true,
      httpsProxyProven: true,
      batch0Complete: true,
      offlineResumePassed: true,
      localSafetyPassed: true,
    })).toEqual({ allowed: false, reason: 'credential_ref_missing' })
    expect(evaluateLiveGate({
      liveEnabled: true,
      httpsProxyProven: true,
      batch0Complete: true,
      offlineResumePassed: true,
      localSafetyPassed: true,
      credentialRef: 'ref',
    })).toEqual({ allowed: true, reason: 'allowed' })
  })

  it('被阻断时不读取凭据、不监听 broker、不 spawn', async () => {
    for (const environment of [
      { liveEnabled: false, httpsProxyProven: false },
      { liveEnabled: true, httpsProxyProven: false, credentialRef: 'ref' },
      { liveEnabled: true, httpsProxyProven: true, credentialRef: 'ref' },
      { liveEnabled: true, httpsProxyProven: true, batch0Complete: true, credentialRef: 'ref' },
      {
        liveEnabled: true,
        httpsProxyProven: true,
        batch0Complete: true,
        offlineResumePassed: true,
        credentialRef: 'ref',
      },
      { liveEnabled: true, httpsProxyProven: true, batch0Complete: true, offlineResumePassed: true, localSafetyPassed: true },
    ]) {
      let credentialReads = 0
      let brokerBinds = 0
      let spawns = 0
      const decision = await runLiveGatePreflight(environment, {
        readCredential: async () => { credentialReads += 1 },
        bindBroker: async () => { brokerBinds += 1 },
        spawnAdapter: async () => { spawns += 1 },
      })
      expect(decision.allowed).toBe(false)
      expect(credentialReads).toBe(0)
      expect(brokerBinds).toBe(0)
      expect(spawns).toBe(0)
    }
  })

  it('允许时按 broker → Keychain → spawn 顺序执行', async () => {
    const order: string[] = []
    const decision = await runLiveGatePreflight(
      {
        liveEnabled: true,
        httpsProxyProven: true,
        batch0Complete: true,
        offlineResumePassed: true,
        localSafetyPassed: true,
        credentialRef: 'ref',
      },
      {
        readCredential: async () => { order.push('credential') },
        bindBroker: async () => { order.push('broker') },
        spawnAdapter: async () => { order.push('spawn') },
      },
    )
    expect(decision.allowed).toBe(true)
    expect(order).toEqual(['broker', 'credential', 'spawn'])
  })

  it('代理证据只匹配显式 HTTPS_PROXY / ProxyAgent', async () => {
    expect(containsProxyEvidence('const agent = new ProxyAgent()')).toBe(true)
    expect(containsProxyEvidence('process.env.HTTPS_PROXY')).toBe(true)
    expect(containsProxyEvidence('no proxy here')).toBe(false)

    const directory = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-proxy-evidence-')))
    try {
      const withProxy = join(directory, 'with.js')
      const withoutProxy = join(directory, 'without.js')
      await writeFile(withProxy, 'HTTPS_PROXY', { encoding: 'utf8', mode: 0o600 })
      await writeFile(withoutProxy, 'plain adapter', { encoding: 'utf8', mode: 0o600 })
      expect(await hasProxyEvidence([withProxy])).toBe(true)
      expect(await hasProxyEvidence([withoutProxy])).toBe(false)
      expect(await hasProxyEvidence([join(directory, 'missing.js')])).toBe(false)
      expect(await hasProxyEvidence([join(directory, 'missing.js'), withProxy])).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('Adapter proxy 证据必须覆盖 env 继承到 SDK query 的链路', () => {
    const source = `const env = {
  ...process.env,
  ...userProvidedOptions?.env,
}
const options = {
  ...userProvidedOptions,
  env,
}
const q = query({ prompt: input, options })`
    expect(hasAdapterProxyEnvironmentFlow(source)).toBe(true)
    expect(hasAdapterProxyEnvironmentFlow(source.replace('  ...process.env,\n', ''))).toBe(false)
    expect(hasAdapterProxyEnvironmentFlow(source.replace('  env,\n', ''))).toBe(false)
  })

  it.skipIf(!supportsPinnedClaudeEvidence)('锁定产物含有 HTTPS_PROXY 到 Anthropic API fetch 的静态路径标记', async () => {
    await expect(pinnedClaudeProxyEvidence()).resolves.toBe(true)
  })

  it('设置 CLI 覆盖时不把默认二进制视作 live proxy 证据', async () => {
    const previousExecutable = process.env.CLAUDE_CODE_EXECUTABLE
    process.env.CLAUDE_CODE_EXECUTABLE = '/tmp/custom-claude'
    try {
      await expect(pinnedClaudeProxyEvidence()).resolves.toBe(false)
    } finally {
      if (previousExecutable === undefined) {
        delete process.env.CLAUDE_CODE_EXECUTABLE
      } else {
        process.env.CLAUDE_CODE_EXECUTABLE = previousExecutable
      }
    }
  })
})

describe('raw ACP 参数', () => {
  it('session/new 强制 tools 为空、轮次与预算受限', () => {
    expect(buildSessionNewParams('/tmp/work')).toEqual({
      cwd: '/tmp/work',
      mcpServers: [],
      _meta: { claudeCode: { options: { tools: [], maxTurns: 1, maxBudgetUsd: 1 } } },
    })
  })

  it('只构造一条固定 prompt', () => {
    expect(buildPromptParams('session-1')).toEqual({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: LIVE_PROMPT }],
    })
  })
})

describe('synthetic transcript fixture', () => {
  it('两条主线程记录链接正确', () => {
    const { jsonl } = buildSyntheticTranscript('session-1')
    expect(() => validateSyntheticTranscriptShape(jsonl, 'session-1')).not.toThrow()
    expect(jsonl.trim().split('\n')).toHaveLength(2)
  })

  it('缺少链接或 session 不匹配时拒绝', () => {
    const { jsonl } = buildSyntheticTranscript('session-1')
    expect(() => validateSyntheticTranscriptShape(jsonl, 'session-2')).toThrow('session id mismatch')
    expect(() => validateSyntheticTranscriptShape(`${jsonl}${jsonl}`, 'session-1')).toThrow('exactly two')
  })
})

describe('Keychain 门禁', () => {
  it('引用缺失时不调用 CredentialStore', async () => {
    const store = new FakeCredentialStore({ value: 'secret' })
    await expect(readCredentialForLiveGate(undefined, store)).resolves.toEqual({ ok: false, failure: 'missing' })
    expect(store.reads).toEqual([])
  })

  it('missing/denied/unavailable 分类稳定', async () => {
    const missing = new FakeCredentialStore({ value: null })
    await expect(readCredentialForLiveGate('ref', missing)).resolves.toEqual({ ok: false, failure: 'missing' })

    const denied = new FakeCredentialStore({ error: { code: 'credential_denied' } })
    await expect(readCredentialForLiveGate('ref', denied)).resolves.toEqual({ ok: false, failure: 'denied' })

    const unavailable = new FakeCredentialStore({ error: new Error('keychain down') })
    await expect(readCredentialForLiveGate('ref', unavailable)).resolves.toEqual({ ok: false, failure: 'unavailable' })
  })

  it('成功读取只在调用后返回内存值', async () => {
    const store = new FakeCredentialStore({ value: 'synthetic-secret' })
    await expect(readCredentialForLiveGate('ref', store)).resolves.toEqual({ ok: true, secret: 'synthetic-secret' })
    expect(store.reads).toEqual(['ref'])
  })
})

describe('跨进程 live gate 锁', () => {
  it('同一路径只能获取一次，释放后可再次获取', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-live-lock-')))
    const lockPath = liveGateLockPath(directory, 'run-1')
    try {
      const release = await acquireLiveGateLock(lockPath)
      await expect(acquireLiveGateLock(lockPath)).rejects.toThrow('already held')
      await release()
      const releaseAgain = await acquireLiveGateLock(lockPath)
      await releaseAgain()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('拒绝 symlink 锁与权限过宽的父目录', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-live-lock-')))
    const target = join(directory, 'target')
    await writeFile(target, 'x', { encoding: 'utf8', mode: 0o600 })
    const lockPath = liveGateLockPath(directory, 'run-2')
    await symlink(target, lockPath)
    try {
      await expect(acquireLiveGateLock(lockPath)).rejects.toThrow('already held')
      await chmod(directory, 0o755)
      await expect(acquireLiveGateLock(liveGateLockPath(directory, 'run-3'))).rejects.toThrow('group/world')
    } finally {
      await chmod(directory, 0o700).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
