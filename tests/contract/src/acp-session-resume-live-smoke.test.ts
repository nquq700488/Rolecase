import { describe, expect, it } from 'vitest'

import {
  CREDENTIAL_REF_ENV,
  LIVE_GATE_ENV,
  evaluateLiveGate,
  pinnedClaudeProxyEvidence,
  runLiveGatePreflight,
} from './acp-session-resume-live-harness.js'

const liveEnabled = process.env[LIVE_GATE_ENV] === '1'
const supportedLivePlatform = process.platform === 'darwin'
  && (process.arch === 'arm64' || process.arch === 'x64')
const credentialRef = process.env[CREDENTIAL_REF_ENV]

describe('Claude 单轮 live resume gate 默认关闭', () => {
  it('未启用时不读凭据、不监听 broker、不 spawn', async () => {
    const calls = { credential: 0, broker: 0, spawn: 0 }
    const decision = await runLiveGatePreflight(
      { liveEnabled: false, httpsProxyProven: true, credentialRef },
      {
        readCredential: async () => { calls.credential += 1 },
        bindBroker: async () => { calls.broker += 1 },
        spawnAdapter: async () => { calls.spawn += 1 },
      },
    )
    expect(decision).toEqual({ allowed: false, reason: 'gate_disabled' })
    expect(calls).toEqual({ credential: 0, broker: 0, spawn: 0 })
  })

  it('代理证据缺失时 fail-closed，且无任何副作用', async () => {
    const calls = { credential: 0, broker: 0, spawn: 0 }
    const decision = await runLiveGatePreflight(
      { liveEnabled: true, httpsProxyProven: false, credentialRef },
      {
        readCredential: async () => { calls.credential += 1 },
        bindBroker: async () => { calls.broker += 1 },
        spawnAdapter: async () => { calls.spawn += 1 },
      },
    )
    expect(decision).toEqual({ allowed: false, reason: 'https_proxy_unproven' })
    expect(calls).toEqual({ credential: 0, broker: 0, spawn: 0 })
  })

  it('本地 gates 通过后仍要求 credential_ref', () => {
    expect(evaluateLiveGate({
      liveEnabled: true,
      httpsProxyProven: true,
      batch0Complete: true,
      offlineResumePassed: true,
      localSafetyPassed: true,
    }).reason).toBe('credential_ref_missing')
  })
})

describe.skipIf(!liveEnabled || !supportedLivePlatform)('Claude 单轮 live resume smoke', () => {
  it('Batch 0 未完成时保持 BLOCKED，不读 Keychain、不 bind broker、不 spawn', async () => {
    const proxyProven = await pinnedClaudeProxyEvidence()
    expect(proxyProven).toBe(true)
    const calls = { credential: 0, broker: 0, spawn: 0 }
    const decision = await runLiveGatePreflight(
      {
        liveEnabled: true,
        httpsProxyProven: proxyProven,
        batch0Complete: false,
        offlineResumePassed: false,
        localSafetyPassed: false,
        credentialRef,
      },
      {
        readCredential: async () => { calls.credential += 1 },
        bindBroker: async () => { calls.broker += 1 },
        spawnAdapter: async () => { calls.spawn += 1 },
      },
    )
    expect(decision).toEqual({ allowed: false, reason: 'batch0_incomplete' })
    expect(calls).toEqual({ credential: 0, broker: 0, spawn: 0 })
  })
})
