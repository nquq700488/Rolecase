import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  evaluateCapacity,
  type CapacityDimension,
  type CapacityLimits,
} from './capacity-admission.js'

const limits: CapacityLimits = {
  queuedTasks: 2,
  pendingPermissions: 3,
  workflowNodes: 4,
}

const originalTestLimitsEnv = process.env.ROLECAST_TEST_CAPACITY_LIMITS

afterEach(() => {
  if (originalTestLimitsEnv === undefined) {
    delete process.env.ROLECAST_TEST_CAPACITY_LIMITS
  } else {
    process.env.ROLECAST_TEST_CAPACITY_LIMITS = originalTestLimitsEnv
  }
})

describe('容量边界策略', () => {
  it.each<[CapacityDimension, number]>([
    ['queuedTasks', 2],
    ['pendingPermissions', 3],
    ['workflowNodes', 4],
  ])('%s 接受 used + requested <= limit，拒绝超限', (dimension, limit) => {
    expect(evaluateCapacity({ limits, dimension, used: 0, requested: limit })).toMatchObject({
      accepted: true, reason: 'accepted', limit, used: 0, requested: limit,
    })
    expect(evaluateCapacity({ limits, dimension, used: limit - 1, requested: 1 })).toMatchObject({
      accepted: true, reason: 'accepted',
    })
    expect(evaluateCapacity({ limits, dimension, used: 1, requested: limit })).toMatchObject({
      accepted: false, reason: 'capacity_exceeded', limit,
    })
    expect(evaluateCapacity({ limits, dimension, used: limit, requested: 1 })).toMatchObject({
      accepted: false, reason: 'capacity_exceeded',
    })
  })

  it('缺失、非法额度或非法 usage 一律 fail-closed', () => {
    expect(evaluateCapacity({ limits: undefined, dimension: 'queuedTasks', used: 0, requested: 1 }))
      .toMatchObject({ accepted: false, reason: 'limits_unconfigured', limit: null })
    expect(evaluateCapacity({ limits: null, dimension: 'queuedTasks', used: 0, requested: 1 }).reason)
      .toBe('limits_unconfigured')
    for (const invalid of [
      {},
      { ...limits, queuedTasks: 0 },
      { ...limits, queuedTasks: -1 },
      { ...limits, queuedTasks: 1.5 },
      { ...limits, queuedTasks: Number.NaN },
      { ...limits, pendingPermissions: Infinity },
      { ...limits, workflowNodes: '4' },
    ]) {
      expect(evaluateCapacity({ limits: invalid, dimension: 'queuedTasks', used: 0, requested: 1 }))
        .toMatchObject({ accepted: false, reason: 'limits_invalid', limit: null })
    }
    expect(evaluateCapacity({ limits, dimension: 'queuedTasks', used: -1, requested: 1 }).reason)
      .toBe('usage_invalid')
    expect(evaluateCapacity({ limits, dimension: 'queuedTasks', used: 0, requested: 0 }).reason)
      .toBe('usage_invalid')
    expect(evaluateCapacity({ limits, dimension: 'queuedTasks', used: 1.5, requested: 1 }).reason)
      .toBe('usage_invalid')
  })

  it('测试注入值不被环境变量或生产 composition 读取', async () => {
    process.env.ROLECAST_TEST_CAPACITY_LIMITS = JSON.stringify(limits)
    // 策略没有默认值，也不读取环境变量：缺失入参仍然 unconfigured。
    expect(evaluateCapacity({ limits: undefined, dimension: 'queuedTasks', used: 0, requested: 1 }).reason)
      .toBe('limits_unconfigured')

    const mainSource = await readFile(join(process.cwd(), 'src/main.ts'), 'utf8')
    expect(mainSource).not.toContain('capacity-admission')
    expect(mainSource).not.toContain('evaluateCapacity')
  })
})
