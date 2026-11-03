import { describe, expect, it } from 'vitest'

import type {
  AgentSlotDto,
  MessageDto,
  ProviderConnectionDto,
  RunDto,
  SessionDto,
  TaskDto,
  WorkspaceDto,
} from '@rolecast/contract'

import { SqliteDatabase } from './sqlite-database.js'
import { SqliteRepository } from './sqlite-repository.js'

const timestamp = '2026-10-14T10:00:00.000Z'

const workspace = (id: string): WorkspaceDto => ({
  id,
  name: `Workspace ${id}`,
  created_at: timestamp,
  updated_at: timestamp,
})

const session = (id: string, workspaceId: string): SessionDto => ({
  id,
  workspace_id: workspaceId,
  name: `Session ${id}`,
  status: 'active',
  created_at: timestamp,
  updated_at: timestamp,
})

const slot = (id: string, sessionId: string): AgentSlotDto => ({
  id,
  session_id: sessionId,
  model_id: 'model-001',
  role_binding_id: undefined,
  status: 'idle',
  created_at: timestamp,
})

const run = (id: string, workspaceId: string, sessionId: string): RunDto => ({
  id,
  workspace_id: workspaceId,
  session_id: sessionId,
  status: 'queued',
  attempt: 1,
})

const task = (id: string, workspaceId: string, sessionId: string, runId: string): TaskDto => ({
  id,
  workspace_id: workspaceId,
  session_id: sessionId,
  run_id: runId,
  slot_id: 'slot-001',
  title: '处理消息',
  status: 'queued',
  created_at: timestamp,
  updated_at: timestamp,
})

const message = (id: string, sessionId: string): MessageDto => ({
  id,
  session_id: sessionId,
  run_id: null,
  sender_kind: 'user',
  sender_id: null,
  content: '你好',
  created_at: timestamp,
})

describe('SQLite Repository', () => {
  it('执行迁移并按 Workspace 隔离查询', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    await repository.createWorkspace(workspace('workspace-002'))
    await repository.createSession(session('session-001', 'workspace-001'))

    await expect(repository.listSessions('workspace-002')).resolves.toEqual([])
    await expect(repository.listSessions('workspace-001')).resolves.toHaveLength(1)

    await repository.close()
  })

  it('在一致性快照中返回消息、Run、Task、Slot 和 sequence', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    await repository.createSession(session('session-001', 'workspace-001'))
    await repository.createAgentSlot(slot('slot-001', 'session-001'))
    await repository.saveRun(run('run-001', 'workspace-001', 'session-001'))
    await repository.saveTask(task('task-001', 'workspace-001', 'session-001', 'run-001'))
    await repository.saveMessage(message('message-001', 'session-001'))
    await repository.appendEvent({
      event_id: 'event-001',
      schema_version: 1,
      workspace_id: 'workspace-001',
      session_id: 'session-001',
      run_id: 'run-001',
      type: 'run.started',
      source: 'test',
      occurred_at: timestamp,
      payload: {},
    })

    const snapshot = await repository.getSessionSnapshot('session-001')

    expect(snapshot?.messages).toHaveLength(1)
    expect(snapshot?.runs).toHaveLength(1)
    expect(snapshot?.tasks).toHaveLength(1)
    expect(snapshot?.agent_slots).toHaveLength(1)
    expect(snapshot?.latest_sequences).toEqual({ 'run-001': 1 })

    await repository.close()
  })

  it('软删除 Slot 时保留历史行与 Runtime cleanup attachment', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    await repository.createSession(session('session-001', 'workspace-001'))
    await repository.createAgentSlot(slot('slot-default', 'session-001'))
    await repository.createAgentSlot({ ...slot('slot-002', 'session-001'), role_binding_id: 'binding-001' })
    await repository.saveRuntimeAttachment({
      slot_id: 'slot-002',
      session_id: 'session-001',
      provider_connection_id: 'provider-001',
      provider_kind: 'claude',
      config_revision: 1,
      adapter_version: 'test',
      adapter_fingerprint: null,
      cwd: '/tmp/work',
      runtime_directory: '/tmp/runtime',
      acp_session_id: 'acp-session-002',
      updated_at: timestamp,
    })

    await expect(repository.softDeleteAgentSlot('session-001', 'slot-002', timestamp)).resolves.toBe('deleted')
    await expect(repository.getAgentSlot('slot-002')).resolves.toBeNull()
    await expect(repository.listAgentSlots('session-001')).resolves.toHaveLength(1)
    await expect(repository.getSessionSnapshot('session-001')).resolves.toMatchObject({
      agent_slots: [{ id: 'slot-default' }],
    })
    await expect(repository.getRuntimeAttachment('slot-002')).resolves.toMatchObject({
      acp_session_id: 'acp-session-002',
    })
    await expect(repository.listRuntimeAttachments()).resolves.toEqual([])
    await expect(repository.listDeletedSlotRuntimeAttachments()).resolves.toMatchObject([
      { slot_id: 'slot-002', acp_session_id: 'acp-session-002' },
    ])
    expect(database.prepare("SELECT status, deleted_at FROM agent_slots WHERE id = 'slot-002'").get())
      .toEqual({ status: 'stopped', deleted_at: timestamp })
    await expect(repository.softDeleteAgentSlot('session-001', 'slot-002', timestamp)).resolves.toBe('already_deleted')
    await repository.close()
  })

  it('不允许删除默认 Slot 或仍被非终态 Run 占用的 Slot', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    await repository.createWorkspace(workspace('workspace-001'))
    await repository.createSession(session('session-001', 'workspace-001'))
    await repository.createAgentSlot(slot('slot-default', 'session-001'))
    await repository.createAgentSlot({ ...slot('slot-002', 'session-001'), role_binding_id: 'binding-001' })
    const activeRun = run('run-active', 'workspace-001', 'session-001')
    await repository.saveRun(activeRun)
    await repository.saveTask({ ...task('task-active', 'workspace-001', 'session-001', activeRun.id), slot_id: 'slot-002' })

    await expect(repository.softDeleteAgentSlot('session-001', 'slot-default', timestamp)).resolves.toBe('default_slot')
    await expect(repository.softDeleteAgentSlot('session-001', 'slot-002', timestamp)).resolves.toBe('slot_busy')
    await expect(repository.getAgentSlot('slot-002')).resolves.toMatchObject({ id: 'slot-002' })
    await repository.close()
  })

  it('add_slot reservation 与 Slot/attachment/snapshot/completed receipt 原子闭环', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    await repository.createSession(session('session-001', 'workspace-001'))
    const receipt = {
      workspace_id: 'workspace-001', request_id: 'add-slot-key', command: 'add_slot',
      target_id: 'session-001', target_slot_id: 'slot-reserved', status: 'reserved' as const,
      dispatch_state: 'not_started' as const, input_digest: 'digest-binding-001', updated_at: timestamp,
    }
    const reservation = await repository.reserveAgentSlotCreation(receipt)
    expect(reservation.kind).toBe('reserved')
    if (reservation.kind !== 'reserved') {
      throw new Error('reservation was not acquired')
    }
    await expect(repository.reserveAgentSlotCreation({ ...receipt, target_slot_id: 'slot-race' }))
      .resolves.toMatchObject({ kind: 'in_progress' })

    const slotRecord = {
      ...slot(reservation.receipt.target_slot_id ?? '', 'session-001'),
      role_binding_id: 'binding-001',
    }
    const attachment = {
      slot_id: slotRecord.id, session_id: slotRecord.session_id,
      provider_connection_id: 'provider-001', provider_kind: 'claude' as const,
      config_revision: 1, adapter_version: 'test', adapter_fingerprint: 'fingerprint',
      cwd: '/tmp/work', runtime_directory: '/tmp/runtime', acp_session_id: 'acp-slot-reserved',
      updated_at: timestamp,
    }
    const roleSnapshot = {
      slot_id: slotRecord.id, workspace_id: 'workspace-001', role_binding_id: 'binding-001',
      role_binding_version: 1, role_id: 'role-001', role_version: 1, role_name: '执行者',
      system_prompt: '完成任务', required_guidelines: ['保留证据'], output_contract: '列出结果',
      created_at: timestamp,
    }

    await expect(repository.completeAgentSlotCreation(slotRecord, attachment, roleSnapshot, reservation.receipt))
      .resolves.toBe('created')
    await expect(repository.getCommandReceipt('workspace-001', 'add-slot-key', 'add_slot')).resolves.toMatchObject({
      status: 'completed', target_slot_id: 'slot-reserved', input_digest: 'digest-binding-001',
    })
    await expect(repository.listAgentSlots('session-001')).resolves.toMatchObject([{ id: 'slot-reserved' }])
    await expect(repository.reserveAgentSlotCreation({ ...receipt, input_digest: 'different-binding' }))
      .resolves.toMatchObject({ kind: 'conflict' })
    await repository.close()
  })

  it('原子保存额外 Slot、Runtime attachment 与私有 Role snapshot', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    await repository.createSession(session('session-001', 'workspace-001'))
    const slotRecord = {
      ...slot('slot-002', 'session-001'),
      role_binding_id: 'binding-001',
    }
    const attachment = {
      slot_id: slotRecord.id,
      session_id: slotRecord.session_id,
      provider_connection_id: 'provider-002',
      provider_kind: 'claude' as const,
      config_revision: 1,
      adapter_version: '0.90.0',
      adapter_fingerprint: 'fp-002',
      cwd: '/tmp/work',
      runtime_directory: '/tmp/provider-002',
      acp_session_id: 'private-acp-session-002',
      updated_at: timestamp,
    }
    const roleSnapshot = {
      slot_id: slotRecord.id,
      workspace_id: 'workspace-001',
      role_binding_id: 'binding-001',
      role_binding_version: 3,
      role_id: 'role-001',
      role_version: 2,
      role_name: '审查者',
      system_prompt: '找出可复现问题',
      required_guidelines: ['引用证据'],
      output_contract: '列出文件与行号',
      created_at: timestamp,
    }

    await repository.addAgentSlotWithAttachmentAndRoleSnapshot(slotRecord, attachment, roleSnapshot)

    await expect(repository.getRuntimeAttachment(slotRecord.id)).resolves.toEqual(attachment)
    await expect(repository.getAgentSlotRoleSnapshot(slotRecord.id)).resolves.toEqual(roleSnapshot)
    const publicSnapshot = await repository.getSessionSnapshot('session-001')
    expect(publicSnapshot?.agent_slots).toEqual([slotRecord])
    expect(JSON.stringify(publicSnapshot)).not.toContain('private-acp-session-002')
    expect(JSON.stringify(publicSnapshot)).not.toContain('找出可复现问题')
    await repository.close()
  })

  it('Role snapshot Workspace 不匹配时回滚 Slot 与 attachment', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    await repository.createSession(session('session-001', 'workspace-001'))
    const slotRecord = { ...slot('slot-rollback', 'session-001'), role_binding_id: 'binding-001' }
    const attachment = {
      slot_id: slotRecord.id,
      session_id: slotRecord.session_id,
      provider_connection_id: 'provider-002',
      provider_kind: 'claude' as const,
      config_revision: 1,
      adapter_version: '0.90.0',
      adapter_fingerprint: 'fp-002',
      cwd: '/tmp/work',
      runtime_directory: '/tmp/provider-002',
      acp_session_id: 'private-acp-session-rollback',
      updated_at: timestamp,
    }
    const roleSnapshot = {
      slot_id: slotRecord.id,
      workspace_id: 'workspace-foreign',
      role_binding_id: 'binding-001',
      role_binding_version: 1,
      role_id: 'role-001',
      role_version: 1,
      role_name: '审查者',
      system_prompt: '私有指令',
      required_guidelines: [],
      output_contract: '',
      created_at: timestamp,
    }

    await expect(repository.addAgentSlotWithAttachmentAndRoleSnapshot(slotRecord, attachment, roleSnapshot))
      .rejects.toThrow('Role snapshot workspace does not match Session')
    await expect(repository.getAgentSlot(slotRecord.id)).resolves.toBeNull()
    await expect(repository.getRuntimeAttachment(slotRecord.id)).resolves.toBeNull()
    await expect(repository.getAgentSlotRoleSnapshot(slotRecord.id)).resolves.toBeNull()
    await repository.close()
  })

  it('命令回执往返保存 target_slot_id，并保留旧记录的 NULL 语义', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    const targeted = await repository.insertCommandReceipt({
      workspace_id: 'workspace-001',
      request_id: 'request-targeted',
      command: 'start',
      target_id: 'session-001',
      target_slot_id: 'slot-002',
      status: 'reserved',
      dispatch_state: 'not_started',
      updated_at: timestamp,
    })
    const legacy = await repository.insertCommandReceipt({
      workspace_id: 'workspace-001',
      request_id: 'request-legacy',
      command: 'start',
      target_id: 'session-001',
      status: 'reserved',
      dispatch_state: 'not_started',
      updated_at: timestamp,
    })

    expect(targeted.target_slot_id).toBe('slot-002')
    expect(legacy.target_slot_id).toBeUndefined()
    await repository.close()
  })

  it('同一 Run 的事件 sequence 单调递增并可重放', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    const first = await repository.appendEvent({
      event_id: 'event-001',
      schema_version: 1,
      workspace_id: 'workspace-001',
      session_id: 'session-001',
      run_id: 'run-001',
      type: 'run.started',
      source: 'test',
      occurred_at: timestamp,
      payload: {},
    })
    const second = await repository.appendEvent({
      event_id: 'event-002',
      schema_version: 1,
      workspace_id: 'workspace-001',
      session_id: 'session-001',
      run_id: 'run-001',
      type: 'agent.message',
      source: 'test',
      occurred_at: timestamp,
      payload: { text: 'hello' },
    })

    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(2)
    await expect(repository.replayEvents('run-001', 1)).resolves.toEqual([second])

    await repository.close()
  })

  it('adapter_request_id 的类型身份经过 SQLite 往返后保持不变', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    await repository.createSession(session('session-001', 'workspace-001'))
    await repository.createAgentSlot(slot('slot-001', 'session-001'))
    await repository.saveRun(run('run-001', 'workspace-001', 'session-001'))
    await repository.saveTask(task('task-001', 'workspace-001', 'session-001', 'run-001'))
    const base = {
      run_id: 'run-001',
      task_id: 'task-001',
      slot_id: 'slot-001',
      capability: 'execute',
      description: '执行命令',
      adapter_options: [{ option_id: 'allow_once', name: '允许一次', kind: 'allow_once' as const }],
      status: 'pending' as const,
      requested_at: timestamp,
      soft_timeout_at: '2026-10-14T10:05:00.000Z',
      expires_at: '2026-10-14T10:30:00.000Z',
    }
    await repository.savePermissionRequest({ ...base, id: 'permission-numeric', adapter_request_id: 1 })
    await repository.savePermissionRequest({ ...base, id: 'permission-string', adapter_request_id: '1' })

    const numeric = await repository.getPermissionRequest('permission-numeric')
    const textual = await repository.getPermissionRequest('permission-string')

    expect(numeric?.adapter_request_id).toBe(1)
    expect(typeof numeric?.adapter_request_id).toBe('number')
    expect(textual?.adapter_request_id).toBe('1')
    expect(typeof textual?.adapter_request_id).toBe('string')
    await repository.close()
  })

  it('服务重启时收敛无法重新挂接 Runtime 的 pending 权限', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    await repository.createSession(session('session-001', 'workspace-001'))
    await repository.createAgentSlot(slot('slot-001', 'session-001'))
    await repository.saveRun({
      ...run('run-001', 'workspace-001', 'session-001'),
      status: 'waiting_user',
    })
    await repository.saveTask({
      ...task('task-001', 'workspace-001', 'session-001', 'run-001'),
      status: 'paused',
    })
    await repository.savePermissionRequest({
      id: 'permission-001',
      run_id: 'run-001',
      task_id: 'task-001',
      slot_id: 'slot-001',
      capability: 'execute',
      description: '执行命令',
      adapter_options: [{ option_id: 'allow_once', name: '允许一次', kind: 'allow_once' }],
      status: 'pending',
      requested_at: timestamp,
      soft_timeout_at: '2026-10-14T10:05:00.000Z',
      expires_at: '2026-10-14T10:30:00.000Z',
    })

    await expect(repository.reconcileUnattachedPermissions(new Date('2026-10-14T10:01:00.000Z'))).resolves.toBe(1)

    const snapshot = await repository.getSessionSnapshot('session-001')
    expect(snapshot?.permissions[0]?.status).toBe('expired')
    expect(snapshot?.permissions[0]?.expiration_reason).toBe('runtime_unavailable')
    expect(snapshot?.runs[0]?.status).toBe('interrupted')
    expect(snapshot?.tasks[0]?.status).toBe('paused')
    expect((await repository.replayEvents('run-001', 0)).map((event) => event.type)).toEqual([
      'agent.permission_expired',
      'run.interrupted',
    ])

    await repository.close()
  })

  it('权限恢复在同一事务内处理全部 pending 权限并连续推进游标', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    await repository.createSession(session('session-001', 'workspace-001'))
    await repository.createAgentSlot(slot('slot-001', 'session-001'))
    await repository.saveRun({ ...run('run-001', 'workspace-001', 'session-001'), status: 'waiting_user' })
    await repository.saveTask({ ...task('task-001', 'workspace-001', 'session-001', 'run-001'), status: 'paused' })
    for (const id of ['permission-001', 'permission-002']) {
      await repository.savePermissionRequest({
        id,
        run_id: 'run-001',
        task_id: 'task-001',
        slot_id: 'slot-001',
        capability: 'execute',
        description: '执行命令',
        adapter_options: [{ option_id: 'allow_once', name: '允许一次', kind: 'allow_once' }],
        status: 'pending',
        requested_at: timestamp,
        soft_timeout_at: '2026-10-14T10:05:00.000Z',
        expires_at: '2026-10-14T10:30:00.000Z',
      })
    }

    await expect(repository.reconcileUnattachedPermissions(new Date('2026-10-14T10:01:00.000Z'))).resolves.toBe(2)
    const snapshot = await repository.getSessionSnapshot('session-001')
    expect(snapshot?.permissions.every((permission) => permission.status === 'expired')).toBe(true)
    expect((await repository.replayEvents('run-001', 0)).map((event) => event.sequence)).toEqual([1, 2, 3, 4])
    const cursor = database
      .prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?')
      .get('run-001') as { event_sequence: number; completed_sequence: number | null }
    expect(cursor).toEqual({ event_sequence: 4, completed_sequence: null })

    // 真正终态 Run 的 pending 权限不得通过 recovery 改写或追加事件。
    await repository.saveRun({ ...run('run-002', 'workspace-001', 'session-001'), status: 'completed' })
    await repository.saveTask({ ...task('task-002', 'workspace-001', 'session-001', 'run-002'), status: 'completed' })
    await repository.savePermissionRequest({
      id: 'permission-003', run_id: 'run-002', task_id: 'task-002', slot_id: 'slot-001',
      capability: 'execute', description: '执行命令',
      adapter_options: [{ option_id: 'allow_once', name: '允许一次', kind: 'allow_once' }],
      status: 'pending', requested_at: timestamp,
      soft_timeout_at: '2026-10-14T10:05:00.000Z', expires_at: '2026-10-14T10:30:00.000Z',
    })
    await expect(repository.reconcileUnattachedPermissions(new Date('2026-10-14T10:02:00.000Z'))).resolves.toBe(0)
    await expect(repository.getPermissionRequest('permission-003')).resolves.toMatchObject({ status: 'pending' })
    await expect(repository.replayEvents('run-002', 0)).resolves.toEqual([])
    await repository.close()
  })

  it('recovery 第二条权限事件失败时整体回滚，恢复成功后 resume 延续游标', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    await repository.createSession(session('session-001', 'workspace-001'))
    await repository.createAgentSlot(slot('slot-001', 'session-001'))
    await repository.saveRun({ ...run('run-001', 'workspace-001', 'session-001'), status: 'waiting_user' })
    await repository.saveTask({ ...task('task-001', 'workspace-001', 'session-001', 'run-001'), status: 'paused' })
    for (const id of ['permission-001', 'permission-002']) {
      await repository.savePermissionRequest({
        id, run_id: 'run-001', task_id: 'task-001', slot_id: 'slot-001',
        capability: 'execute', description: '执行命令',
        adapter_options: [{ option_id: 'allow_once', name: '允许一次', kind: 'allow_once' }],
        status: 'pending', requested_at: timestamp,
        soft_timeout_at: '2026-10-14T10:05:00.000Z', expires_at: '2026-10-14T10:30:00.000Z',
      })
    }

    // 在第二条 permission 的第二个恢复 Event 写入处注入失败。
    const originalPrepare = database.prepare.bind(database)
    let eventInserts = 0
    database.prepare = ((sql: string) => {
      const statement = originalPrepare(sql)
      if (sql.includes('INSERT INTO events')) {
        eventInserts += 1
        if (eventInserts === 4) {
          return {
            ...statement,
            run: () => {
              throw new Error('injected recovery failure')
            },
          } as unknown as typeof statement
        }
      }
      return statement
    }) as typeof database.prepare
    await expect(repository.reconcileUnattachedPermissions(new Date('2026-10-14T10:01:00.000Z')))
      .rejects.toThrow('injected recovery failure')
    database.prepare = originalPrepare

    const rolledBack = await repository.getSessionSnapshot('session-001')
    expect(rolledBack?.permissions.every((permission) => permission.status === 'pending')).toBe(true)
    expect(rolledBack?.runs[0]?.status).toBe('waiting_user')
    expect(await repository.replayEvents('run-001', 0)).toEqual([])
    expect(database.prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?')
      .get('run-001')).toEqual({ event_sequence: 0, completed_sequence: null })

    // 成功路径完整处理两条权限，游标连续。
    await expect(repository.reconcileUnattachedPermissions(new Date('2026-10-14T10:02:00.000Z'))).resolves.toBe(2)
    expect((await repository.replayEvents('run-001', 0)).map((event) => event.sequence)).toEqual([1, 2, 3, 4])

    // interrupted 后正式 resume：保留游标，下一条 Event 使用 5。
    let current = await repository.getRun('run-001')
    let revision = await repository.getRunStateRevision('run-001')
    await repository.finalizeRun({
      run: { ...current!, status: 'running' }, expectedStateRevision: revision ?? 1,
      taskId: 'task-001', taskStatus: 'running', slotId: 'slot-001', releaseClaim: false,
    })
    const resumed = await repository.appendEvent({
      event_id: 'e-resume', schema_version: 1, workspace_id: 'workspace-001', session_id: 'session-001',
      run_id: 'run-001', type: 'agent.message', source: 'acp-runtime', occurred_at: timestamp,
      payload: { text: 'resumed' },
    })
    expect(resumed.sequence).toBe(5)

    // 仅成功完成事务冻结水位。
    current = await repository.getRun('run-001')
    revision = await repository.getRunStateRevision('run-001')
    await repository.finalizeRun({
      run: { ...current!, status: 'completed' }, expectedStateRevision: revision ?? 1,
      taskId: 'task-001', taskStatus: 'completed', slotId: 'slot-001', releaseClaim: true,
    })
    await expect(repository.getHandoffSource('session-001', 'run-001'))
      .resolves.toMatchObject({ completed_sequence: 5 })
    await repository.close()
  })

  it('创建一轮消息时 Run、Task、Message 失败会整体回滚', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    await repository.createSession(session('session-001', 'workspace-001'))
    await expect(repository.createTurn(
      run('run-rollback', 'workspace-001', 'session-001'),
      { ...task('task-rollback', 'workspace-001', 'session-001', 'run-rollback'), slot_id: 'missing-slot' },
      message('message-rollback', 'session-001'),
    )).rejects.toThrow()
    await expect(repository.getRun('run-rollback')).resolves.toBeNull()
    await repository.close()
  })

  it('配置更新成功后旧模型目录不可见', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    const connection: ProviderConnectionDto = {
      id: 'provider-001',
      workspace_id: 'workspace-001',
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'inherited',
      config_revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }
    await repository.createProviderConnection(connection)
    await repository.saveModelsIfCurrentRevision(connection.id, 1, [{
      id: 'model-001',
      workspace_id: 'workspace-001',
      provider_connection_id: connection.id,
      provider_kind: 'claude',
      model_id: 'old-model',
      display_name: 'Old',
      capabilities: {},
      observed_at: timestamp,
    }])
    await expect(repository.listModels(connection.id)).resolves.toHaveLength(1)

    await repository.updateProviderConnection({
      ...connection,
      connection_kind: 'custom_endpoint',
      base_url: 'https://gateway.example.test/v1',
      updated_at: '2026-10-14T10:01:00.000Z',
    }, 1)

    // 配置一变，旧目录必须立刻失效，不能等到下次 discover。
    await expect(repository.listModels(connection.id)).resolves.toEqual([])
    await repository.close()
  })

  it('发现结果只在捕获时的 config_revision 仍是当前版本时写入', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    const connection: ProviderConnectionDto = {
      id: 'provider-001',
      workspace_id: 'workspace-001',
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'inherited',
      config_revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }
    await repository.createProviderConnection(connection)
    const model = (modelId: string) => ({
      id: `model-${modelId}`,
      workspace_id: 'workspace-001',
      provider_connection_id: connection.id,
      provider_kind: 'claude' as const,
      model_id: modelId,
      display_name: modelId,
      capabilities: {},
      observed_at: timestamp,
    })

    // 旧发现先捕获 revision=1；随后配置更新到 revision=2。
    const staleRevision = 1
    await repository.updateProviderConnection({
      ...connection,
      connection_kind: 'custom_endpoint',
      base_url: 'https://gateway.example.test/v1',
      updated_at: '2026-10-14T10:01:00.000Z',
    }, 1)

    // 旧发现此时才完成：必须被拒绝，且不能写入。
    await expect(repository.saveModelsIfCurrentRevision(connection.id, staleRevision, [model('stale-model')]))
      .resolves.toBe(false)
    await expect(repository.listModels(connection.id)).resolves.toEqual([])

    // 新 revision 的发现可以写入。
    await expect(repository.saveModelsIfCurrentRevision(connection.id, 2, [model('fresh-model')]))
      .resolves.toBe(true)
    await expect(repository.listModels(connection.id)).resolves.toEqual([
      expect.objectContaining({ model_id: 'fresh-model' }),
    ])
    await repository.close()
  })

  it('持久化 Codex 非秘密配置并以 config_revision 执行条件更新', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
    await repository.createWorkspace(workspace('workspace-001'))
    const connection: ProviderConnectionDto = {
      id: 'provider-codex',
      workspace_id: 'workspace-001',
      provider_kind: 'codex',
      connection_kind: 'local',
      environment_mode: 'inherited',
      config_revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }
    await repository.createProviderConnection(connection)
    const updated = await repository.updateProviderConnection({
      ...connection,
      base_url: 'https://gateway.example.test/v1',
      environment_mode: 'isolated',
      codex_config: { model: 'gpt-test', wire_api: 'responses' },
      updated_at: '2026-10-14T10:01:00.000Z',
    }, 1)

    expect(updated).toMatchObject({
      config_revision: 2,
      environment_mode: 'isolated',
      codex_config: { model: 'gpt-test', wire_api: 'responses' },
    })
    await expect(repository.updateProviderConnection({
      ...connection,
      codex_config: { model: 'stale-model' },
      updated_at: '2026-10-14T10:02:00.000Z',
    }, 1)).resolves.toBeNull()
    await expect(repository.getProviderConnection(connection.id)).resolves.toMatchObject({
      config_revision: 2,
      codex_config: { model: 'gpt-test' },
    })
    database.prepare('UPDATE provider_connections SET codex_config_json = ? WHERE id = ?')
      .run(JSON.stringify({ api_key: 'not-test-secret' }), connection.id)
    await expect(repository.getProviderConnection(connection.id)).rejects.toThrow('SQLite Codex 配置字段无效')
    await repository.close()
  })
})
