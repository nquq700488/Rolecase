import { describe, expect, it } from 'vitest'

import type { PermissionRequestDto } from '@rolecast/contract'

import {
  PermissionExpiredError,
  PermissionStateCoordinator,
  type PermissionRuntimePort,
  type PermissionStateStore,
} from './permission-state-coordinator.js'

const requestFixture = (): PermissionRequestDto => ({
  id: 'permission-001',
  run_id: 'run-001',
  task_id: 'task-001',
  slot_id: 'slot-001',
  capability: 'execute',
  description: 'Run a command',
  adapter_options: [
    {
      option_id: 'allow_once',
      name: 'Yes, proceed',
      kind: 'allow_once',
    },
  ],
  status: 'pending',
  requested_at: '2026-10-14T10:00:00.000Z',
  soft_timeout_at: '2026-10-14T10:05:00.000Z',
  expires_at: '2026-10-14T10:30:00.000Z',
  adapter_request_id: '900',
})

class FakePermissionStore implements PermissionStateStore {
  readonly requests = new Map<string, PermissionRequestDto>()
  readonly runStates: Array<{ runId: string; status: string }> = []
  readonly taskStates: Array<{ taskId: string; status: string }> = []
  readonly events: string[] = []
  readonly messages: string[] = []
  readonly decisionClaims = new Map<string, { requestId: string; leaseUntil: Date }>()

  async getPermissionRequest(id: string): Promise<PermissionRequestDto | null> {
    return this.requests.get(id) ?? null
  }

  async savePermissionRequest(request: PermissionRequestDto): Promise<void> {
    this.requests.set(request.id, request)
  }

  async updatePermissionIfCurrent(
    requestId: string,
    expectedStatus: PermissionRequestDto['status'],
    request: PermissionRequestDto,
  ): Promise<boolean> {
    const current = this.requests.get(requestId)
    if (current?.status !== expectedStatus) {
      return false
    }
    this.requests.set(requestId, request)
    return true
  }

  async beginPermissionDecision(
    requestId: string,
    expectedStatus: 'pending',
    decisionId: string,
    leaseUntil: Date,
  ): Promise<PermissionRequestDto | null> {
    const current = this.requests.get(requestId)
    const claimed = [...this.decisionClaims.values()].some((claim) => claim.requestId === requestId)
    if (current?.status !== expectedStatus || claimed) {
      return null
    }
    this.decisionClaims.set(decisionId, { requestId, leaseUntil })
    return current
  }

  async completePermissionDecision(
    decisionId: string,
    request: PermissionRequestDto,
    runStatus: 'running' | 'interrupted',
    taskStatus: 'paused' | 'running',
  ): Promise<boolean> {
    const claim = this.decisionClaims.get(decisionId)
    if (claim === undefined || claim.requestId !== request.id) {
      return false
    }
    this.decisionClaims.delete(decisionId)
    this.requests.set(request.id, request)
    await this.transitionRun(request.run_id, runStatus)
    await this.transitionTask(request.task_id, taskStatus)
    return true
  }

  async releasePermissionDecision(decisionId: string): Promise<void> {
    this.decisionClaims.delete(decisionId)
  }

  async recoverPermissionDecisions(now: Date): Promise<number> {
    const stale = [...this.decisionClaims.entries()]
      .filter(([, claim]) => claim.leaseUntil <= now)
      .map(([decisionId]) => decisionId)
    for (const decisionId of stale) {
      this.decisionClaims.delete(decisionId)
    }
    return stale.length
  }

  async transitionRun(runId: string, status: string): Promise<void> {
    this.runStates.push({ runId, status })
  }

  async transitionTask(taskId: string, status: string): Promise<void> {
    this.taskStates.push({ taskId, status })
  }

  async publish(type: string): Promise<void> {
    this.events.push(type)
  }

  async createSystemMessage(kind: string): Promise<void> {
    this.messages.push(kind)
  }
}

class FakeRuntime implements PermissionRuntimePort {
  readonly answers: Array<{ requestId: string; optionId?: string; cancelled?: boolean }> = []
  failNext = false

  async respondPermission(input: {
    requestId: string
    optionId?: string
    cancelled?: boolean
  }): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('runtime response failed')
    }
    this.answers.push(input)
  }
}

describe('PermissionStateCoordinator', () => {
  it('注册权限请求时暂停 Task 并等待用户', async () => {
    const store = new FakePermissionStore()
    const coordinator = new PermissionStateCoordinator(store, new FakeRuntime())

    await coordinator.register(requestFixture())

    expect(store.runStates).toEqual([{ runId: 'run-001', status: 'waiting_user' }])
    expect(store.taskStates).toEqual([{ taskId: 'task-001', status: 'paused' }])
    expect(store.events).toEqual(['agent.permission_requested'])
  })

  it('软超时只提醒一次，仍保持 pending', async () => {
    const store = new FakePermissionStore()
    const coordinator = new PermissionStateCoordinator(store, new FakeRuntime())
    await coordinator.register(requestFixture())

    await coordinator.tick('permission-001', new Date('2026-10-14T10:05:00.000Z'))
    await coordinator.tick('permission-001', new Date('2026-10-14T10:06:00.000Z'))

    expect(store.requests.get('permission-001')?.status).toBe('pending')
    expect(store.events).toEqual([
      'agent.permission_requested',
      'agent.permission_overdue',
    ])
  })

  it('硬超时过期并中断 Run，过期后不能回答', async () => {
    const store = new FakePermissionStore()
    const runtime = new FakeRuntime()
    const coordinator = new PermissionStateCoordinator(store, runtime)
    await coordinator.register(requestFixture())

    await coordinator.tick('permission-001', new Date('2026-10-14T10:30:00.000Z'))

    expect(store.requests.get('permission-001')?.status).toBe('expired')
    expect(runtime.answers).toEqual([{ requestId: '900', cancelled: true }])
    expect(store.runStates.at(-1)).toEqual({ runId: 'run-001', status: 'interrupted' })
    expect(store.taskStates.at(-1)).toEqual({ taskId: 'task-001', status: 'paused' })
    expect(store.events).toContain('agent.permission_expired')
    expect(store.messages).toEqual(['permission_expired'])
    await expect(coordinator.answer('permission-001', 'allow_once')).rejects.toBeInstanceOf(
      PermissionExpiredError,
    )
  })

  it('回答 pending 请求后恢复 Run 和 Task', async () => {
    const store = new FakePermissionStore()
    const runtime = new FakeRuntime()
    const coordinator = new PermissionStateCoordinator(store, runtime)
    await coordinator.register(requestFixture())

    await coordinator.answer('permission-001', 'allow_once')

    expect(runtime.answers).toEqual([{ requestId: '900', optionId: 'allow_once' }])
    expect(store.requests.get('permission-001')?.status).toBe('answered')
    expect(store.runStates.at(-1)).toEqual({ runId: 'run-001', status: 'running' })
    expect(store.taskStates.at(-1)).toEqual({ taskId: 'task-001', status: 'running' })
    expect(store.events).toContain('agent.permission_answered')
  })

  it('并发回答和硬超时只允许一个 Adapter 决定', async () => {
    const store = new FakePermissionStore()
    const runtime = new FakeRuntime()
    const coordinator = new PermissionStateCoordinator(store, runtime)
    await coordinator.register(requestFixture())

    await Promise.all([
      coordinator.answer('permission-001', 'allow_once'),
      coordinator.tick('permission-001', new Date('2026-10-14T10:30:00.000Z')),
    ])

    expect(runtime.answers).toHaveLength(1)
    expect(store.requests.get('permission-001')?.status).toBe('answered')
    expect(store.events).not.toContain('agent.permission_expired')
  })

  it('不同协调器实例竞争时只有一个能领取决定', async () => {
    const store = new FakePermissionStore()
    const firstRuntime = new FakeRuntime()
    const secondRuntime = new FakeRuntime()
    const first = new PermissionStateCoordinator(store, firstRuntime)
    const second = new PermissionStateCoordinator(store, secondRuntime)
    await first.register(requestFixture())

    const results = await Promise.allSettled([
      first.answer('permission-001', 'allow_once'),
      second.answer('permission-001', 'allow_once'),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(firstRuntime.answers.length + secondRuntime.answers.length).toBe(1)
    expect(store.requests.get('permission-001')?.status).toBe('answered')
  })

  it('Adapter 应答失败后释放领取并允许安全重试', async () => {
    const store = new FakePermissionStore()
    const runtime = new FakeRuntime()
    const coordinator = new PermissionStateCoordinator(store, runtime)
    await coordinator.register(requestFixture())
    runtime.failNext = true

    await expect(coordinator.answer('permission-001', 'allow_once')).rejects.toThrow(
      'runtime response failed',
    )
    expect(store.requests.get('permission-001')?.status).toBe('pending')

    await coordinator.answer('permission-001', 'allow_once')
    expect(store.requests.get('permission-001')?.status).toBe('answered')
  })

  it('服务重启后释放过期领取并允许恢复处理', async () => {
    const store = new FakePermissionStore()
    const runtime = new FakeRuntime()
    const coordinator = new PermissionStateCoordinator(store, runtime)
    await coordinator.register(requestFixture())
    await store.beginPermissionDecision(
      'permission-001',
      'pending',
      'stale-decision',
      new Date('2026-10-14T09:59:00.000Z'),
    )

    await expect(coordinator.recoverStaleDecisions(new Date('2026-10-14T10:00:00.000Z'))).resolves.toBe(1)
    await coordinator.answer('permission-001', 'allow_once')
    expect(store.requests.get('permission-001')?.status).toBe('answered')
  })
})
