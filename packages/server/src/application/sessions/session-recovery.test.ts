import { describe, expect, it, vi } from 'vitest'

import type { CreateSessionRequest, RuntimeEvent } from '@rolecast/contract'

import type {
  AgentRuntimeConnection,
  AgentRuntimeConnectionInput,
  AgentRuntimePort,
  AgentRuntimeSession,
} from '../ports/agent-runtime-port.js'
import type { ProviderDefinitionPort } from '../ports/id-generator-port.js'
import { systemClock } from '../ports/clock-port.js'
import { SqliteDatabase } from '../../infrastructure/persistence/sqlite-database.js'
import { SqliteRepository } from '../../infrastructure/persistence/sqlite-repository.js'
import { SessionService } from './session-service.js'

const timestamp = '2026-10-14T10:00:00.000Z'

/** 记录 connect/resume 调用的 Fake Runtime。 */
class RecordingRuntime implements AgentRuntimePort {
  connects = 0
  resumes = 0
  closedConnections = 0
  readonly closedSessions: string[] = []
  readonly failedResumeSessionIds = new Set<string>()
  readonly failNextCloseSessions = new Set<string>()
  readonly failNextCloseConnections = new Set<string>()
  private createdSessions = 0

  async connect(_input: AgentRuntimeConnectionInput): Promise<AgentRuntimeConnection> {
    this.connects += 1
    return {
      connectionId: `connection-${this.connects}`,
      providerKind: 'claude',
      adapterVersion: '0.90.0',
      capabilities: {
        provider_kind: 'claude',
        adapter_version: '0.90.0',
        source: 'manual',
        observed_at: timestamp,
        capabilities: {},
      },
    }
  }

  async createSession(connection: AgentRuntimeConnection): Promise<AgentRuntimeSession> {
    this.createdSessions += 1
    return {
      sessionId: `acp-session-${String(this.createdSessions).padStart(3, '0')}`,
      connection,
      configOptions: [{ id: 'model', category: 'model', currentValue: 'model-a', options: [{ value: 'model-a' }] }],
    }
  }

  async resumeSession(connection: AgentRuntimeConnection, sessionId: string): Promise<AgentRuntimeSession> {
    this.resumes += 1
    if (this.failedResumeSessionIds.has(sessionId)) {
      throw new Error('fake resume failure')
    }
    return { sessionId, connection, configOptions: [] }
  }

  async *sendTurn(): AsyncIterable<RuntimeEvent> {}
  async respondPermission(): Promise<void> {}
  async cancelTurn(): Promise<void> {}
  async closeSession(session: AgentRuntimeSession): Promise<void> {
    this.closedSessions.push(session.sessionId)
    if (this.failNextCloseSessions.delete(session.sessionId)) {
      throw new Error('fake session close failure')
    }
  }
  async closeConnection(connectionId: string): Promise<void> {
    this.closedConnections += 1
    if (this.failNextCloseConnections.delete(connectionId)) {
      throw new Error('fake close failure')
    }
  }
}

class TestIds {
  private sequence = 0
  next(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }
}

const environment = {
  cwd: '/tmp/rolecast-work',
  environment: {},
  runtimeDirectory: (connectionId: string) => `/tmp/rolecast-runtime/${connectionId}`,
}

const setup = async (options: { fingerprint?: string } = {}) => {
  const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
  await repository.createWorkspace({
    id: 'workspace-001',
    name: '恢复工作区',
    created_at: timestamp,
    updated_at: timestamp,
  })
  const definitions: ProviderDefinitionPort = {
    get: () => ({
      adapterCommand: '/fake/adapter',
      adapterArgs: ['entry.js'],
      adapterVersion: '0.90.0',
      credentialEnvironmentKey: 'ANTHROPIC_API_KEY',
    }),
    fingerprint: async () => options.fingerprint ?? 'fp-current',
  }
  const connection = await repository.createProviderConnection({
    id: 'provider-001',
    workspace_id: 'workspace-001',
    provider_kind: 'claude',
    connection_kind: 'local',
    environment_mode: 'inherited',
    config_revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
  })
  return { repository, definitions, connection }
}

describe('SessionService Runtime attachment', () => {
  it('创建 Session 时原子保存 attachment，且不进入公共快照', async () => {
    const { repository, definitions } = await setup()
    const runtime = new RecordingRuntime()
    const service = new SessionService(repository, runtime, new TestIds(), systemClock, definitions, environment)

    const { session, agentSlot } = await service.create('workspace-001', {
      name: '会话',
      provider_connection_id: 'provider-001',
      model_id: 'model-a',
    })

    const attachment = await repository.getRuntimeAttachment(agentSlot.id)
    expect(attachment).toMatchObject({
      session_id: session.id,
      acp_session_id: 'acp-session-001',
      adapter_version: '0.90.0',
      adapter_fingerprint: 'fp-current',
    })
    const snapshot = await repository.getSessionSnapshot(session.id)
    expect(JSON.stringify(snapshot)).not.toContain('acp-session-001')
    await repository.close()
  })

  it('使用已验证 RoleBinding 创建唯一初始 Slot 并原子保存私有 Role snapshot', async () => {
    const { repository, definitions, connection } = await setup()
    const runtime = new RecordingRuntime()
    const binding = {
      id: 'binding-initial',
      workspace_id: 'workspace-001',
      role_id: 'role-initial',
      provider_connection_id: connection.id,
      model_id: 'model-a',
      runtime_options: {},
      priority: 0,
      enabled: true,
      version: 4,
      created_at: timestamp,
      updated_at: timestamp,
    }
    const role = {
      id: 'role-initial',
      workspace_id: 'workspace-001',
      name: '初始角色',
      description: '',
      system_prompt: '仅保存在私有 snapshot',
      required_guidelines: ['先验证证据'],
      gates: [],
      output_contract: '输出结论',
      blocking_conditions: [],
      selectable: true,
      dispatchable: true,
      version: 7,
      created_at: timestamp,
      updated_at: timestamp,
    }
    const resolveBindingForWorkspace = vi.fn(async (workspaceId: string, bindingId: string) => {
      expect(workspaceId).toBe('workspace-001')
      expect(bindingId).toBe(binding.id)
      return { binding, role }
    })
    const service = new SessionService(
      repository,
      runtime,
      new TestIds(),
      systemClock,
      definitions,
      environment,
      { resolveBindingForWorkspace },
    )

    const created = await service.create('workspace-001', {
      name: '角色会话',
      role_binding_id: binding.id,
    } as CreateSessionRequest)

    expect(resolveBindingForWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-001', binding.id)
    expect(created.agentSlot).toMatchObject({ role_binding_id: binding.id, model_id: binding.model_id })
    await expect(repository.listAgentSlots(created.session.id)).resolves.toEqual([created.agentSlot])
    await expect(repository.getRuntimeAttachment(created.agentSlot.id)).resolves.toMatchObject({
      provider_connection_id: binding.provider_connection_id,
      session_id: created.session.id,
    })
    await expect(repository.getAgentSlotRoleSnapshot(created.agentSlot.id)).resolves.toMatchObject({
      workspace_id: 'workspace-001',
      role_binding_id: binding.id,
      role_binding_version: binding.version,
      role_id: role.id,
      role_version: role.version,
      system_prompt: role.system_prompt,
    })
    expect(JSON.stringify(await repository.getSessionSnapshot(created.session.id))).not.toContain(role.system_prompt)
    expect(runtime.connects).toBe(1)
    await repository.close()
  })

  it('RoleBinding 校验失败时不连接 Runtime 或留下 Session', async () => {
    const { repository, definitions } = await setup()
    const runtime = new RecordingRuntime()
    const service = new SessionService(
      repository,
      runtime,
      new TestIds(),
      systemClock,
      definitions,
      environment,
      { resolveBindingForWorkspace: async () => { throw new Error('binding rejected') } },
    )

    await expect(service.create('workspace-001', {
      name: '拒绝的角色会话',
      role_binding_id: 'binding-invalid',
    } as CreateSessionRequest)).rejects.toThrow('binding rejected')

    expect(runtime.connects).toBe(0)
    await expect(repository.listSessions('workspace-001')).resolves.toEqual([])
    await repository.close()
  })

  it('持久化失败时尽力关闭 ACP Session 和连接且清理错误不覆盖创建错误', async () => {
    const { repository, definitions, connection } = await setup()
    const runtime = new RecordingRuntime()
    const binding = {
      id: 'binding-initial', workspace_id: 'workspace-001', role_id: 'role-initial',
      provider_connection_id: connection.id, model_id: 'model-a', runtime_options: {},
      priority: 0, enabled: true, version: 1, created_at: timestamp, updated_at: timestamp,
    }
    const role = {
      id: 'role-initial', workspace_id: 'workspace-001', name: '角色', description: '',
      system_prompt: 'prompt', required_guidelines: [], gates: [], output_contract: '',
      blocking_conditions: [], selectable: true, dispatchable: true, version: 1,
      created_at: timestamp, updated_at: timestamp,
    }
    const service = new SessionService(
      repository, runtime, new TestIds(), systemClock, definitions, environment,
      { resolveBindingForWorkspace: async () => ({ binding, role }) },
    )
    vi.spyOn(repository, 'saveSessionWithAttachment').mockRejectedValueOnce(new Error('sqlite write failed'))
    runtime.failNextCloseSessions.add('acp-session-001')
    runtime.failNextCloseConnections.add('connection-1')

    await expect(service.create('workspace-001', {
      name: '写入失败的会话', role_binding_id: binding.id,
    } as CreateSessionRequest)).rejects.toMatchObject({ code: 'session_create_failed' })

    expect(runtime.closedSessions).toEqual(['acp-session-001'])
    expect(runtime.closedConnections).toBe(1)
    expect(runtime.connects).toBe(1)
    await expect(repository.listSessions('workspace-001')).resolves.toEqual([])
    await expect(repository.getRuntimeAttachment('slot-2')).resolves.toBeNull()
    await repository.close()
  })

  it('通过 RoleBinding 创建独立 Slot、Runtime attachment 和私有 Role snapshot', async () => {
    const { repository, definitions, connection } = await setup()
    const runtime = new RecordingRuntime()
    const binding = {
      id: 'binding-001',
      workspace_id: 'workspace-001',
      role_id: 'role-001',
      provider_connection_id: connection.id,
      model_id: 'model-a',
      runtime_options: {},
      priority: 0,
      enabled: true,
      version: 3,
      created_at: timestamp,
      updated_at: timestamp,
    }
    const role = {
      id: 'role-001',
      workspace_id: 'workspace-001',
      name: '审查者',
      description: '',
      system_prompt: '找出可复现的问题',
      required_guidelines: ['引用证据'],
      gates: [],
      output_contract: '列出文件和行号',
      blocking_conditions: [],
      selectable: true,
      dispatchable: true,
      version: 2,
      created_at: timestamp,
      updated_at: timestamp,
    }
    const roleResolver = {
      async resolveBindingForWorkspace(workspaceId: string, bindingId: string) {
        expect(workspaceId).toBe('workspace-001')
        expect(bindingId).toBe(binding.id)
        return { binding, role }
      },
    }
    const service = new SessionService(
      repository,
      runtime,
      new TestIds(),
      systemClock,
      definitions,
      environment,
      roleResolver,
    )
    const created = await service.create('workspace-001', { name: '会话', provider_connection_id: connection.id, model_id: 'model-a' })

    const added = await service.addAgentSlot(created.session.id, {
      role_binding_id: binding.id,
      request_id: 'add-slot-idempotency',
    })
    const replay = await service.addAgentSlot(created.session.id, {
      role_binding_id: binding.id,
      request_id: 'add-slot-idempotency',
    })

    expect(added).toMatchObject({ role_binding_id: binding.id, model_id: 'model-a' })
    expect(replay.id).toBe(added.id)
    expect(runtime.connects).toBe(2)
    await expect(service.addAgentSlot(created.session.id, {
      role_binding_id: 'binding-other',
      request_id: 'add-slot-idempotency',
    })).rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
    await expect(repository.listAgentSlots(created.session.id)).resolves.toHaveLength(2)
    await expect(repository.getRuntimeAttachment(created.agentSlot.id)).resolves.toMatchObject({
      slot_id: created.agentSlot.id,
      acp_session_id: 'acp-session-001',
    })
    await expect(repository.getRuntimeAttachment(added.id)).resolves.toMatchObject({
      slot_id: added.id,
      provider_connection_id: connection.id,
      acp_session_id: 'acp-session-002',
    })
    await expect(repository.getAgentSlotRoleSnapshot(added.id)).resolves.toMatchObject({
      role_binding_id: binding.id,
      role_binding_version: 3,
      role_id: role.id,
      role_version: 2,
      system_prompt: role.system_prompt,
      required_guidelines: role.required_guidelines,
      output_contract: role.output_contract,
    })
    expect(service.getRuntimeSession(added.id)).not.toBeNull()
    const publicSnapshot = await repository.getSessionSnapshot(created.session.id)
    expect(JSON.stringify(publicSnapshot)).not.toContain(role.system_prompt)
    await repository.close()
  })

  it('删除非默认 Slot 时只关闭其 Runtime 并保留历史 snapshot', async () => {
    const { repository, definitions, connection } = await setup()
    const runtime = new RecordingRuntime()
    const binding = {
      id: 'binding-001', workspace_id: 'workspace-001', role_id: 'role-001',
      provider_connection_id: connection.id, model_id: 'model-a', runtime_options: {},
      priority: 0, enabled: true, version: 1, created_at: timestamp, updated_at: timestamp,
    }
    const role = {
      id: 'role-001', workspace_id: 'workspace-001', name: '执行者', description: '',
      system_prompt: '完成指定任务', required_guidelines: [], gates: [], output_contract: '',
      blocking_conditions: [], selectable: true, dispatchable: true, version: 1,
      created_at: timestamp, updated_at: timestamp,
    }
    const service = new SessionService(
      repository, runtime, new TestIds(), systemClock, definitions, environment,
      { resolveBindingForWorkspace: async () => ({ binding, role }) },
    )
    const created = await service.create('workspace-001', {
      name: '会话', provider_connection_id: connection.id, model_id: 'model-a',
    })
    const added = await service.addAgentSlot(created.session.id, { role_binding_id: binding.id })
    runtime.failNextCloseConnections.add('connection-2')

    await service.deleteAgentSlot(created.session.id, added.id)

    expect(runtime.closedSessions).toEqual(['acp-session-002'])
    expect(runtime.closedConnections).toBe(1)
    expect(service.getRuntimeSession(added.id)).toBeNull()
    expect(service.getRuntimeSession(created.agentSlot.id)).not.toBeNull()
    await expect(repository.getAgentSlot(added.id)).resolves.toBeNull()
    await expect(repository.getRuntimeAttachment(added.id)).resolves.toMatchObject({ acp_session_id: 'acp-session-002' })
    // 优雅关闭继续回收失败连接；只有关闭确认后才删除 cleanup attachment。
    await service.closeAll()
    expect(runtime.closedConnections).toBe(3)
    await expect(repository.getRuntimeAttachment(added.id)).resolves.toBeNull()
    await expect(repository.getAgentSlotRoleSnapshot(added.id)).resolves.toMatchObject({ role_id: role.id })
    await expect(repository.getSessionSnapshot(created.session.id)).resolves.toMatchObject({
      agent_slots: [{ id: created.agentSlot.id }],
    })
    await expect(service.deleteAgentSlot(created.session.id, created.agentSlot.id))
      .rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
    await repository.close()
  })

  it('重启后按 Slot 分别恢复 Runtime，不互相覆盖', async () => {
    const { repository, definitions, connection } = await setup()
    const initialRuntime = new RecordingRuntime()
    const binding = {
      id: 'binding-001', workspace_id: 'workspace-001', role_id: 'role-001',
      provider_connection_id: connection.id, model_id: 'model-a', runtime_options: {},
      priority: 0, enabled: true, version: 1, created_at: timestamp, updated_at: timestamp,
    }
    const role = {
      id: 'role-001', workspace_id: 'workspace-001', name: '执行者', description: '',
      system_prompt: '完成指定任务', required_guidelines: [], gates: [], output_contract: '',
      blocking_conditions: [], selectable: true, dispatchable: true, version: 1,
      created_at: timestamp, updated_at: timestamp,
    }
    const roleResolver = { resolveBindingForWorkspace: async () => ({ binding, role }) }
    const service = new SessionService(
      repository, initialRuntime, new TestIds(), systemClock, definitions, environment, roleResolver,
    )
    const created = await service.create('workspace-001', {
      name: '会话', provider_connection_id: connection.id, model_id: 'model-a',
    })
    const added = await service.addAgentSlot(created.session.id, { role_binding_id: binding.id })
    await repository.createTurn(
      { id: 'run-default', workspace_id: 'workspace-001', session_id: created.session.id, status: 'running', attempt: 1 },
      { id: 'task-default', workspace_id: 'workspace-001', session_id: created.session.id, run_id: 'run-default', slot_id: created.agentSlot.id, title: '默认', status: 'running', created_at: timestamp, updated_at: timestamp },
      { id: 'message-default', session_id: created.session.id, run_id: 'run-default', sender_kind: 'user', sender_id: null, content: '默认任务', created_at: timestamp },
    )
    await repository.createTurn(
      { id: 'run-bound', workspace_id: 'workspace-001', session_id: created.session.id, status: 'running', attempt: 1 },
      { id: 'task-bound', workspace_id: 'workspace-001', session_id: created.session.id, run_id: 'run-bound', slot_id: added.id, title: '绑定', status: 'running', created_at: timestamp, updated_at: timestamp },
      { id: 'message-bound', session_id: created.session.id, run_id: 'run-bound', sender_kind: 'user', sender_id: null, content: '绑定任务', created_at: timestamp },
    )

    const restartedRuntime = new RecordingRuntime()
    const restarted = new SessionService(repository, restartedRuntime, new TestIds(), systemClock, definitions, environment)
    await expect(restarted.recover()).resolves.toEqual({ recovered: 2, interrupted: 0 })

    expect(restartedRuntime.resumes).toBe(2)
    expect(restarted.getRuntimeSession(created.agentSlot.id)?.sessionId).toBe('acp-session-001')
    expect(restarted.getRuntimeSession(added.id)?.sessionId).toBe('acp-session-002')
    await expect(repository.getRun('run-default')).resolves.toMatchObject({ status: 'paused' })
    await expect(repository.getRun('run-bound')).resolves.toMatchObject({ status: 'paused' })
    await repository.close()
  })

  it('重启时只清理已删除 Slot attachment，不把它加入活动 Runtime', async () => {
    const { repository, definitions, connection } = await setup()
    const initialRuntime = new RecordingRuntime()
    const binding = {
      id: 'binding-001', workspace_id: 'workspace-001', role_id: 'role-001',
      provider_connection_id: connection.id, model_id: 'model-a', runtime_options: {},
      priority: 0, enabled: true, version: 1, created_at: timestamp, updated_at: timestamp,
    }
    const role = {
      id: 'role-001', workspace_id: 'workspace-001', name: '执行者', description: '',
      system_prompt: '完成指定任务', required_guidelines: [], gates: [], output_contract: '',
      blocking_conditions: [], selectable: true, dispatchable: true, version: 1,
      created_at: timestamp, updated_at: timestamp,
    }
    const resolver = { resolveBindingForWorkspace: async () => ({ binding, role }) }
    const initial = new SessionService(
      repository, initialRuntime, new TestIds(), systemClock, definitions, environment, resolver,
    )
    const created = await initial.create('workspace-001', {
      name: '会话', provider_connection_id: connection.id, model_id: 'model-a',
    })
    const added = await initial.addAgentSlot(created.session.id, { role_binding_id: binding.id })
    await expect(repository.softDeleteAgentSlot(created.session.id, added.id, timestamp)).resolves.toBe('deleted')

    const restartedRuntime = new RecordingRuntime()
    const restarted = new SessionService(
      repository, restartedRuntime, new TestIds(), systemClock, definitions, environment,
    )
    await expect(restarted.recover()).resolves.toEqual({ recovered: 1, interrupted: 0 })

    expect(restartedRuntime.closedSessions).toEqual(['acp-session-002'])
    expect(restarted.getRuntimeSession(created.agentSlot.id)).not.toBeNull()
    expect(restarted.getRuntimeSession(added.id)).toBeNull()
    await expect(repository.getRuntimeAttachment(added.id)).resolves.toBeNull()
    await repository.close()
  })

  it('已删除 Slot 的清理失败后保留 attachment 并在后续启动重试', async () => {
    const { repository, definitions, connection } = await setup()
    const binding = {
      id: 'binding-001', workspace_id: 'workspace-001', role_id: 'role-001',
      provider_connection_id: connection.id, model_id: 'model-a', runtime_options: {},
      priority: 0, enabled: true, version: 1, created_at: timestamp, updated_at: timestamp,
    }
    const role = {
      id: 'role-001', workspace_id: 'workspace-001', name: '执行者', description: '',
      system_prompt: '完成指定任务', required_guidelines: [], gates: [], output_contract: '',
      blocking_conditions: [], selectable: true, dispatchable: true, version: 1,
      created_at: timestamp, updated_at: timestamp,
    }
    const initial = new SessionService(
      repository,
      new RecordingRuntime(),
      new TestIds(),
      systemClock,
      definitions,
      environment,
      { resolveBindingForWorkspace: async () => ({ binding, role }) },
    )
    const created = await initial.create('workspace-001', {
      name: '会话', provider_connection_id: connection.id, model_id: 'model-a',
    })
    const added = await initial.addAgentSlot(created.session.id, { role_binding_id: binding.id })
    await expect(repository.softDeleteAgentSlot(created.session.id, added.id, timestamp)).resolves.toBe('deleted')

    const failedRuntime = new RecordingRuntime()
    failedRuntime.failedResumeSessionIds.add('acp-session-002')
    const failedRecovery = new SessionService(
      repository, failedRuntime, new TestIds(), systemClock, definitions, environment,
    )
    await expect(failedRecovery.recover()).resolves.toEqual({ recovered: 1, interrupted: 1 })
    await expect(repository.getRuntimeAttachment(added.id)).resolves.toMatchObject({
      acp_session_id: 'acp-session-002',
    })
    await expect(repository.getAgentSlot(added.id)).resolves.toBeNull()

    const retryRuntime = new RecordingRuntime()
    const retried = new SessionService(repository, retryRuntime, new TestIds(), systemClock, definitions, environment)
    await expect(retried.recover()).resolves.toEqual({ recovered: 1, interrupted: 0 })
    expect(retryRuntime.closedSessions).toEqual(['acp-session-002'])
    await expect(repository.getRuntimeAttachment(added.id)).resolves.toBeNull()
    await repository.close()
  })

  it('一个 Slot 重挂接失败不会中断同 Session 的其他 Slot', async () => {
    const { repository, definitions, connection } = await setup()
    const initialRuntime = new RecordingRuntime()
    const binding = {
      id: 'binding-001', workspace_id: 'workspace-001', role_id: 'role-001',
      provider_connection_id: connection.id, model_id: 'model-a', runtime_options: {},
      priority: 0, enabled: true, version: 1, created_at: timestamp, updated_at: timestamp,
    }
    const role = {
      id: 'role-001', workspace_id: 'workspace-001', name: '执行者', description: '',
      system_prompt: '完成指定任务', required_guidelines: [], gates: [], output_contract: '',
      blocking_conditions: [], selectable: true, dispatchable: true, version: 1,
      created_at: timestamp, updated_at: timestamp,
    }
    const roleResolver = { resolveBindingForWorkspace: async () => ({ binding, role }) }
    const service = new SessionService(
      repository, initialRuntime, new TestIds(), systemClock, definitions, environment, roleResolver,
    )
    const created = await service.create('workspace-001', {
      name: '会话', provider_connection_id: connection.id, model_id: 'model-a',
    })
    const added = await service.addAgentSlot(created.session.id, { role_binding_id: binding.id })
    await repository.createTurn(
      { id: 'run-default', workspace_id: 'workspace-001', session_id: created.session.id, status: 'running', attempt: 1 },
      { id: 'task-default', workspace_id: 'workspace-001', session_id: created.session.id, run_id: 'run-default', slot_id: created.agentSlot.id, title: '默认', status: 'running', created_at: timestamp, updated_at: timestamp },
      { id: 'message-default', session_id: created.session.id, run_id: 'run-default', sender_kind: 'user', sender_id: null, content: '默认任务', created_at: timestamp },
    )
    await repository.createTurn(
      { id: 'run-bound', workspace_id: 'workspace-001', session_id: created.session.id, status: 'running', attempt: 1 },
      { id: 'task-bound', workspace_id: 'workspace-001', session_id: created.session.id, run_id: 'run-bound', slot_id: added.id, title: '绑定', status: 'running', created_at: timestamp, updated_at: timestamp },
      { id: 'message-bound', session_id: created.session.id, run_id: 'run-bound', sender_kind: 'user', sender_id: null, content: '绑定任务', created_at: timestamp },
    )

    const restartedRuntime = new RecordingRuntime()
    restartedRuntime.failedResumeSessionIds.add('acp-session-002')
    const restarted = new SessionService(repository, restartedRuntime, new TestIds(), systemClock, definitions, environment)
    await expect(restarted.recover()).resolves.toEqual({ recovered: 1, interrupted: 1 })

    expect(restarted.getRuntimeSession(created.agentSlot.id)?.sessionId).toBe('acp-session-001')
    expect(restarted.getRuntimeSession(added.id)).toBeNull()
    await expect(repository.getRun('run-default')).resolves.toMatchObject({ status: 'paused' })
    await expect(repository.getRun('run-bound')).resolves.toMatchObject({ status: 'interrupted' })
    await expect(repository.getSession(created.session.id)).resolves.toMatchObject({ status: 'active' })
    await repository.close()
  })

  it('Slot snapshot 持久化失败时关闭新 Runtime 且不留下部分 Slot', async () => {
    const { repository, definitions, connection } = await setup()
    const runtime = new RecordingRuntime()
    const binding = {
      id: 'binding-001', workspace_id: 'workspace-001', role_id: 'role-001',
      provider_connection_id: connection.id, model_id: 'model-a', runtime_options: {},
      priority: 0, enabled: true, version: 1, created_at: timestamp, updated_at: timestamp,
    }
    const role = {
      id: 'role-001', workspace_id: 'workspace-001', name: '执行者', description: '',
      system_prompt: '完成任务', required_guidelines: [], gates: [], output_contract: '',
      blocking_conditions: [], selectable: true, dispatchable: true, version: 1,
      created_at: timestamp, updated_at: timestamp,
    }
    const roleResolver = { resolveBindingForWorkspace: async () => ({ binding, role }) }
    const service = new SessionService(
      repository, runtime, new TestIds(), systemClock, definitions, environment, roleResolver,
    )
    const created = await service.create('workspace-001', {
      name: '会话', provider_connection_id: connection.id, model_id: 'model-a',
    })
    const persist = vi.spyOn(repository, 'completeAgentSlotCreation')
      .mockRejectedValue(new Error('storage failed'))

    await expect(service.addAgentSlot(created.session.id, {
      role_binding_id: binding.id,
      request_id: 'retryable-slot-create',
    })).rejects.toMatchObject({ code: 'session_create_failed', statusCode: 502 })
    expect(runtime.closedConnections).toBe(1)
    await expect(repository.listAgentSlots(created.session.id)).resolves.toHaveLength(1)
    await expect(repository.listRuntimeAttachments()).resolves.toHaveLength(1)
    persist.mockRestore()

    const retried = await service.addAgentSlot(created.session.id, {
      role_binding_id: binding.id,
      request_id: 'retryable-slot-create',
    })
    await expect(repository.listAgentSlots(created.session.id)).resolves.toHaveLength(2)
    await expect(repository.getCommandReceipt('workspace-001', 'retryable-slot-create', 'add_slot'))
      .resolves.toMatchObject({ status: 'completed', target_slot_id: retried.id })
    await repository.close()
  })

  it('启动恢复使用 connect → resumeSession，并把非终态 Run 收敛为 paused', async () => {
    const { repository, definitions } = await setup()
    const runtime = new RecordingRuntime()
    const service = new SessionService(repository, runtime, new TestIds(), systemClock, definitions, environment)
    const { session, agentSlot } = await service.create('workspace-001', {
      name: '会话',
      provider_connection_id: 'provider-001',
      model_id: 'model-a',
    })
    await repository.createTurn(
      {
        id: 'run-001', workspace_id: 'workspace-001', session_id: session.id,
        status: 'running', attempt: 1, created_at: timestamp, updated_at: timestamp,
      },
      {
        id: 'task-001', workspace_id: 'workspace-001', session_id: session.id,
        run_id: 'run-001', slot_id: agentSlot.id, title: 't', status: 'running',
        created_at: timestamp, updated_at: timestamp,
      },
      {
        id: 'msg-001', session_id: session.id, run_id: 'run-001',
        sender_kind: 'user', sender_id: null, content: 'hello', created_at: timestamp,
      },
    )

    // 新进程：内存中的 Runtime 已丢失。
    const restarted = new SessionService(repository, runtime, new TestIds(), systemClock, definitions, environment)
    await expect(restarted.recover()).resolves.toEqual({ recovered: 1, interrupted: 0 })

    expect(runtime.resumes).toBe(1)
    await expect(repository.getRun('run-001')).resolves.toMatchObject({ status: 'paused' })
    await repository.close()
  })

  it('启动时收敛未完成命令回执：未派发转 failed，已 started 转 ambiguous', async () => {
    const { repository, definitions } = await setup()
    const runtime = new RecordingRuntime()
    const service = new SessionService(repository, runtime, new TestIds(), systemClock, definitions, environment)

    await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'req-undispatched', command: 'start',
      target_id: 'session-001', status: 'reserved', dispatch_state: 'not_started', updated_at: timestamp,
    })
    await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'req-started', command: 'start',
      target_id: 'session-001', status: 'running', dispatch_state: 'started',
      run_id: 'run-001', task_id: 'task-001', updated_at: timestamp,
    })
    await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'req-add-slot', command: 'add_slot',
      target_id: 'session-001', target_slot_id: 'slot-pending', input_digest: 'binding-digest',
      status: 'reserved', dispatch_state: 'not_started', updated_at: timestamp,
    })

    await service.recover()

    await expect(repository.getCommandReceipt('workspace-001', 'req-undispatched', 'start'))
      .resolves.toMatchObject({ status: 'failed', dispatch_state: 'not_started' })
    await expect(repository.getCommandReceipt('workspace-001', 'req-started', 'start'))
      .resolves.toMatchObject({ status: 'ambiguous', dispatch_state: 'started' })
    await expect(repository.getCommandReceipt('workspace-001', 'req-add-slot', 'add_slot'))
      .resolves.toMatchObject({
        status: 'failed', dispatch_state: 'not_started', target_slot_id: 'slot-pending',
        input_digest: 'binding-digest',
      })
    await repository.close()
  })

  it('启动时把无 attachment 的非终态 Run 收敛为 interrupted 并按 Run 重建 claim', async () => {
    const { repository, definitions } = await setup()
    await repository.createSession({
      id: 'session-001', workspace_id: 'workspace-001', name: '会话', status: 'active',
      created_at: timestamp, updated_at: timestamp,
    })
    await repository.createAgentSlot({
      id: 'slot-001', session_id: 'session-001', model_id: 'model-a', status: 'idle',
      created_at: timestamp,
    })
    // 终态 Run 的残留 claim 应被清理。
    await repository.createTurn(
      {
        id: 'run-old', workspace_id: 'workspace-001', session_id: 'session-001',
        status: 'completed', attempt: 1, created_at: timestamp, updated_at: timestamp,
      },
      {
        id: 'task-old', workspace_id: 'workspace-001', session_id: 'session-001',
        run_id: 'run-old', slot_id: 'slot-001', title: 't', status: 'completed',
        created_at: timestamp, updated_at: timestamp,
      },
      {
        id: 'msg-old', session_id: 'session-001', run_id: 'run-old',
        sender_kind: 'user', sender_id: null, content: 'old', created_at: timestamp,
      },
    )
    await repository.claimSlotActivity('slot-001', 'run-old', timestamp)
    await repository.createTurn(
      {
        id: 'run-active', workspace_id: 'workspace-001', session_id: 'session-001',
        status: 'running', attempt: 1, created_at: timestamp, updated_at: timestamp,
      },
      {
        id: 'task-active', workspace_id: 'workspace-001', session_id: 'session-001',
        run_id: 'run-active', slot_id: 'slot-001', title: 't', status: 'running',
        created_at: timestamp, updated_at: timestamp,
      },
      {
        id: 'msg-active', session_id: 'session-001', run_id: 'run-active',
        sender_kind: 'user', sender_id: null, content: 'hello', created_at: timestamp,
      },
    )

    const service = new SessionService(
      repository, new RecordingRuntime(), new TestIds(), systemClock, definitions, environment,
    )
    await service.recover()

    await expect(repository.getRun('run-active')).resolves.toMatchObject({
      status: 'interrupted', error_code: 'runtime_attachment_unavailable',
    })
    const snapshot = await repository.getSessionSnapshot('session-001')
    expect(snapshot?.tasks.find((task) => task.run_id === 'run-active')?.status).toBe('paused')
    await expect(repository.getSlotActivityClaim('slot-001'))
      .resolves.toMatchObject({ run_id: 'run-active', state: 'active' })
    await repository.close()
  })

  it('同 Slot 存在多个非终态 Run 时建立 recovery_conflict hold', async () => {
    const { repository, definitions } = await setup()
    await repository.createSession({
      id: 'session-001', workspace_id: 'workspace-001', name: '会话', status: 'active',
      created_at: timestamp, updated_at: timestamp,
    })
    await repository.createAgentSlot({
      id: 'slot-001', session_id: 'session-001', model_id: 'model-a', status: 'idle',
      created_at: timestamp,
    })
    for (const id of ['run-1', 'run-2']) {
      await repository.createTurn(
        {
          id, workspace_id: 'workspace-001', session_id: 'session-001',
          status: 'running', attempt: 1, created_at: timestamp, updated_at: timestamp,
        },
        {
          id: `task-${id}`, workspace_id: 'workspace-001', session_id: 'session-001',
          run_id: id, slot_id: 'slot-001', title: 't', status: 'running',
          created_at: timestamp, updated_at: timestamp,
        },
        {
          id: `msg-${id}`, session_id: 'session-001', run_id: id,
          sender_kind: 'user', sender_id: null, content: 'hello', created_at: timestamp,
        },
      )
    }

    const service = new SessionService(
      repository, new RecordingRuntime(), new TestIds(), systemClock, definitions, environment,
    )
    await service.recover()

    await expect(repository.getSlotActivityClaim('slot-001'))
      .resolves.toMatchObject({ run_id: null, state: 'recovery_conflict' })
    await expect(repository.getRun('run-1')).resolves.toMatchObject({ status: 'interrupted' })
    await expect(repository.getRun('run-2')).resolves.toMatchObject({ status: 'interrupted' })
    await repository.close()
  })

  it('Provider revision 或 Adapter 指纹不匹配时不 spawn，Run 收敛为 interrupted', async () => {
    for (const scenario of ['revision', 'fingerprint'] as const) {
      const setupResult = await setup({ fingerprint: 'fp-created' })
      // 创建与恢复使用不同实例，才能断言恢复阶段没有 spawn。
      const createRuntime = new RecordingRuntime()
      const runtime = new RecordingRuntime()
      const service = new SessionService(
        setupResult.repository, createRuntime, new TestIds(), systemClock, setupResult.definitions, environment,
      )
      const { session, agentSlot } = await service.create('workspace-001', {
        name: '会话',
        provider_connection_id: 'provider-001',
        model_id: 'model-a',
      })
      await setupResult.repository.createTurn(
        {
          id: 'run-001', workspace_id: 'workspace-001', session_id: session.id,
          status: 'running', attempt: 1, created_at: timestamp, updated_at: timestamp,
        },
        {
          id: 'task-001', workspace_id: 'workspace-001', session_id: session.id,
          run_id: 'run-001', slot_id: agentSlot.id, title: 't', status: 'running',
          created_at: timestamp, updated_at: timestamp,
        },
        {
          id: 'msg-001', session_id: session.id, run_id: 'run-001',
          sender_kind: 'user', sender_id: null, content: 'hello', created_at: timestamp,
        },
      )

      if (scenario === 'revision') {
        await setupResult.repository.updateProviderConnection({
          ...setupResult.connection,
          connection_kind: 'api_key',
          environment_mode: 'isolated',
          credential_ref: 'credential-001',
          updated_at: timestamp,
        }, 1)
      }
      const fingerprints = { current: scenario === 'fingerprint' ? 'fp-changed' : 'fp-created' }
      const restartedDefinitions: ProviderDefinitionPort = {
        ...setupResult.definitions,
        fingerprint: async () => fingerprints.current,
      }
      const restarted = new SessionService(
        setupResult.repository, runtime, new TestIds(), systemClock, restartedDefinitions, environment,
      )
      await expect(restarted.recover()).resolves.toEqual({ recovered: 0, interrupted: 1 })

      expect(runtime.connects).toBe(0)
      expect(runtime.resumes).toBe(0)
      await expect(setupResult.repository.getRun('run-001'))
        .resolves.toMatchObject({ status: 'interrupted', error_code: 'runtime_attachment_unavailable' })
      await setupResult.repository.close()
    }
  })
})
