import { describe, expect, it } from 'vitest'

import { summarizeUrl } from './auth-summary.js'
import { decideDeviceCodeOutcome, type DeviceCodeObservation } from './device-code-outcome.js'

const url = summarizeUrl('https://chatgpt.com/device?code=abc')

const observation = (overrides: Partial<DeviceCodeObservation> = {}): DeviceCodeObservation => ({
  methodDeclared: true,
  elicitationObserved: true,
  cancellationDelivered: true,
  authenticateCancelled: true,
  adapterSettled: true,
  pendingRequests: 0,
  resourcesReleased: true,
  egressBlocked: false,
  url,
  ...overrides,
})

describe('decideDeviceCodeOutcome', () => {
  it('未声明方法时 unsupported', () => {
    expect(decideDeviceCodeOutcome(observation({ methodDeclared: false })))
      .toEqual({ status: 'unsupported', reason: 'method_not_declared' })
  })

  it('full evidence 才算取消并清理完成', () => {
    expect(decideDeviceCodeOutcome(observation()))
      .toEqual({ status: 'cancelled_and_cleaned', url })
  })

  it('网络阻断导致未观察到 elicitation → unverified', () => {
    expect(decideDeviceCodeOutcome(observation({
      elicitationObserved: false,
      egressBlocked: true,
    }))).toEqual({
      status: 'unverified',
      reason: 'elicitation_not_observed_before_network_block',
    })
  })

  it('未观察且未阻断同样不能算通过', () => {
    expect(decideDeviceCodeOutcome(observation({ elicitationObserved: false })))
      .toEqual({ status: 'unverified', reason: 'elicitation_not_observed' })
  })

  it('取消未送达、Adapter 未收敛、有 pending、资源未回收都判 unverified', () => {
    expect(decideDeviceCodeOutcome(observation({ cancellationDelivered: false })))
      .toEqual({ status: 'unverified', reason: 'cancellation_not_delivered' })
    expect(decideDeviceCodeOutcome(observation({ authenticateCancelled: false })))
      .toEqual({ status: 'unverified', reason: 'authenticate_not_cancelled' })
    expect(decideDeviceCodeOutcome(observation({ adapterSettled: false })))
      .toEqual({ status: 'unverified', reason: 'adapter_did_not_settle' })
    expect(decideDeviceCodeOutcome(observation({ pendingRequests: 1 })))
      .toEqual({ status: 'unverified', reason: 'pending_requests_remain' })
    expect(decideDeviceCodeOutcome(observation({ resourcesReleased: false })))
      .toEqual({ status: 'unverified', reason: 'resources_not_released' })
    expect(decideDeviceCodeOutcome(observation({ url: null })))
      .toEqual({ status: 'unverified', reason: 'elicitation_url_missing' })
  })

  it('除 full evidence 外永远不会返回通过', () => {
    const nonPassing: Array<Partial<DeviceCodeObservation>> = [
      { methodDeclared: false },
      { elicitationObserved: false },
      { cancellationDelivered: false },
      { authenticateCancelled: false },
      { adapterSettled: false },
      { pendingRequests: 1 },
      { resourcesReleased: false },
      { url: null },
    ]
    for (const override of nonPassing) {
      expect(decideDeviceCodeOutcome(observation(override)).status).not.toBe('cancelled_and_cleaned')
    }
  })
})
