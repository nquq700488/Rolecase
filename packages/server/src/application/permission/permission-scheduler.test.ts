import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '@rolecast/contract'

import type {
  AgentRuntimeConnection,
  AgentRuntimePort,
  AgentRuntimeSession,
} from '../ports/agent-runtime-port.js'
import { systemClock } from '../ports/clock-port.js'
import { PermissionScheduler } from './permission-scheduler.js'
import { InProcessEventBus } from '../../infrastructure/events/in-process-event-bus.js'
import { SqliteDatabase } from '../../infrastructure/persistence/sqlite-database.js'
import { SqliteRepository } from '../../infrastructure/persistence/sqlite-repository.js'

class TestRuntime implements AgentRuntimePort {
  readonly responses: Array<{ requestId: string | number; cancelled?: boolean }> = []
  private readonly connection: AgentRuntimeConnection = {
    connectionId: 'connection-001',
    providerKind: 'claude',
    adapterVersion: 'test',
    capabilities: {
      provider_kind: 'claude',
      adapter_version: 'test',
      source: 'manual',
      observed_at: '2026-10-14T10:00:00.000Z',
      capabilities: {},
    },
  }

  async connect(): Promise<AgentRuntimeConnection> { return this.connection }
  async createSession(connection: AgentRuntimeConnection): Promise<AgentRuntimeSession> {
    return { sessionId: 'acp-session-001', connection, configOptions: [] }
  }
  async getSession(): Promise<AgentRuntimeSession> {
    return this.createSession(this.connection)
  }
  async *sendTurn(): AsyncIterable<RuntimeEvent> {}
  async respondPermission(input: { requestId: string | number; cancelled?: boolean }): Promise<void> {
    this.responses.push({
      requestId: input.requestId,
      ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
    })
  }
  async cancelTurn(): Promise<void> {}
  async resumeSession(): Promise<AgentRuntimeSession> { return this.createSession(this.connection) }
  async closeSession(): Promise<void> {}
  async closeConnection(): Promise<void> {}
}

describe('PermissionScheduler', () => {
  it('未注入容量额度时 pending Permission 仍可注册', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const runtime = new TestRuntime()
    await repository.createWorkspace({
      id: 'workspace-001', name: '测试',
      created_at: '2026-10-14T10:00:00.000Z', updated_at: '2026-10-14T10:00:00.000Z',
    })
    await repository.createSession({
      id: 'session-001', workspace_id: 'workspace-001', name: '会话', status: 'active',
      created_at: '2026-10-14T10:00:00.000Z', updated_at: '2026-10-14T10:00:00.000Z',
    })
    await repository.createAgentSlot({
      id: 'slot-001', session_id: 'session-001', model_id: 'model-001', status: 'idle',
      created_at: '2026-10-14T10:00:00.000Z',
    })
    await repository.saveRun({
      id: 'run-001', workspace_id: 'workspace-001', session_id: 'session-001',
      status: 'running', attempt: 1,
    })
    await repository.saveTask({
      id: 'task-001', workspace_id: 'workspace-001', session_id: 'session-001', run_id: 'run-001',
      slot_id: 'slot-001', title: '权限任务', status: 'running',
      created_at: '2026-10-14T10:00:00.000Z', updated_at: '2026-10-14T10:00:00.000Z',
    })
    const scheduler = new PermissionScheduler(repository, runtime, systemClock)
    await scheduler.register({
      id: 'permission-legacy', run_id: 'run-001', task_id: 'task-001', slot_id: 'slot-001',
      capability: 'execute', description: '执行命令',
      adapter_options: [{ option_id: 'allow_once', name: '允许一次', kind: 'allow_once' }],
      status: 'pending', requested_at: '2026-10-14T10:00:00.000Z',
      soft_timeout_at: '2026-10-14T10:05:00.000Z', expires_at: '2026-10-14T10:30:00.000Z',
    }, await runtime.getSession())
    await expect(repository.getPermissionRequest('permission-legacy'))
      .resolves.toMatchObject({ status: 'pending' })
    await repository.close()
  })

  it('驱动软提醒和硬超时，并只向 Runtime 回传一次取消', async () => {
    const eventBus = new InProcessEventBus()
    const receivedEvents: string[] = []
    eventBus.subscribe((event) => {
      receivedEvents.push(event.type)
    })
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'), eventBus)
    const runtime = new TestRuntime()
    await repository.createWorkspace({
      id: 'workspace-001', name: '测试',
      created_at: '2026-10-14T10:00:00.000Z', updated_at: '2026-10-14T10:00:00.000Z',
    })
    await repository.createSession({
      id: 'session-001', workspace_id: 'workspace-001', name: '会话', status: 'active',
      created_at: '2026-10-14T10:00:00.000Z', updated_at: '2026-10-14T10:00:00.000Z',
    })
    await repository.createAgentSlot({
      id: 'slot-001', session_id: 'session-001', model_id: 'model-001', status: 'idle',
      created_at: '2026-10-14T10:00:00.000Z',
    })
    await repository.saveRun({ id: 'run-001', workspace_id: 'workspace-001', session_id: 'session-001', status: 'running', attempt: 1 })
    await repository.saveTask({
      id: 'task-001', workspace_id: 'workspace-001', session_id: 'session-001', run_id: 'run-001',
      slot_id: 'slot-001', title: '权限任务', status: 'running',
      created_at: '2026-10-14T10:00:00.000Z', updated_at: '2026-10-14T10:00:00.000Z',
    })
    const request = {
      id: 'permission-001', run_id: 'run-001', task_id: 'task-001', slot_id: 'slot-001',
      capability: 'execute', description: '执行命令',
      adapter_options: [{ option_id: 'allow_once', name: '允许一次', kind: 'allow_once' as const }],
      status: 'pending' as const, requested_at: '2026-10-14T10:00:00.000Z',
      soft_timeout_at: '2026-10-14T10:05:00.000Z', expires_at: '2026-10-14T10:30:00.000Z',
    }
    const session = await runtime.getSession()
    const scheduler = new PermissionScheduler(repository, runtime, systemClock)
    await scheduler.register(request, session)

    await scheduler.tickNow(new Date('2026-10-14T10:05:00.000Z'))
    expect((await repository.getPermissionRequest(request.id))?.overdue_at).toBe('2026-10-14T10:05:00.000Z')
    expect((await repository.getPermissionRequest(request.id))?.status).toBe('pending')

    await scheduler.tickNow(new Date('2026-10-14T10:30:00.000Z'))
    await scheduler.tickNow(new Date('2026-10-14T10:31:00.000Z'))
    expect((await repository.getPermissionRequest(request.id))?.status).toBe('expired')
    expect(runtime.responses).toEqual([{ requestId: request.id, cancelled: true }])
    const events = await repository.replayEvents('run-001', 0)
    expect(events.map((event) => event.type)).toEqual([
      'agent.permission_requested',
      'agent.permission_overdue',
      'agent.permission_expired',
      'run.interrupted',
    ])
    expect(receivedEvents).toEqual(events.map((event) => event.type))
    await repository.close()
  })
})

