import { describe, expect, it } from 'vitest'

import type { MessageDto, RunDto, TaskDto } from '@rolecast/contract'
import type { AgentSlotRoleSnapshotRecord, RuntimeAttachmentRecord } from '../../application/ports/repository-port.js'

import { SqliteDatabase } from './sqlite-database.js'
import { SqliteRepository } from './sqlite-repository.js'

const timestamp = '2026-10-14T10:00:00.000Z'

const run = (id: string, overrides: Partial<RunDto> = {}): RunDto => ({
  id,
  workspace_id: 'workspace-001',
  session_id: 'session-001',
  status: 'running',
  attempt: 1,
  created_at: timestamp,
  updated_at: timestamp,
  ...overrides,
})

const task = (id: string, runId: string): TaskDto => ({
  id,
  workspace_id: 'workspace-001',
  session_id: 'session-001',
  run_id: runId,
  slot_id: 'slot-001',
  title: '处理用户消息',
  status: 'running',
  created_at: timestamp,
  updated_at: timestamp,
})

const message = (id: string, runId: string): MessageDto => ({
  id,
  session_id: 'session-001',
  run_id: runId,
  sender_kind: 'user',
  sender_id: null,
  content: 'hello',
  created_at: timestamp,
})

const createRetryTurn = async (
  repository: SqliteRepository,
  parentRunId: string,
  nextRun: RunDto,
  nextTask: TaskDto,
  requestId: string,
) => {
  const receipt = await repository.insertCommandReceipt({
    workspace_id: 'workspace-001', request_id: requestId, command: 'retry',
    target_id: parentRunId, status: 'reserved', dispatch_state: 'not_started', updated_at: timestamp,
  })
  return repository.createRetryTurn(parentRunId, nextRun, nextTask, receipt, {
    status: receipt.status,
    dispatch_state: receipt.dispatch_state,
    run_id: receipt.run_id ?? null,
    task_id: receipt.task_id ?? null,
    message_id: receipt.message_id ?? null,
  }, timestamp)
}

/** 建一个含 Workspace/Session/Slot 的最小数据库。 */
const setup = async () => {
  const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
  await repository.createWorkspace({
    id: 'workspace-001',
    name: '闭环工作区',
    created_at: timestamp,
    updated_at: timestamp,
  })
  await repository.createSession({
    id: 'session-001',
    workspace_id: 'workspace-001',
    name: '会话',
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp,
  })
  await repository.createAgentSlot({
    id: 'slot-001',
    session_id: 'session-001',
    model_id: 'model-001',
    status: 'idle',
    created_at: timestamp,
  })
  return repository
}

describe('SqliteRunClosureStore', () => {
  it('start 与 claim 原子提交，第二个 request 被拒绝', async () => {
    const repository = await setup()
    const first = run('run-001')
    await expect(repository.createTurnWithClaim(first, task('task-001', first.id), message('msg-001', first.id), timestamp))
      .resolves.toBe(true)

    const second = run('run-002')
    await expect(repository.createTurnWithClaim(second, task('task-002', second.id), message('msg-002', second.id), timestamp))
      .resolves.toBe(false)

    await expect(repository.getRun('run-002')).resolves.toBeNull()
    await expect(repository.getSlotActivityClaim('slot-001')).resolves.toMatchObject({
      run_id: 'run-001',
      state: 'active',
    })
    await expect(repository.getRunInputMessage('run-001')).resolves.toMatchObject({ id: 'msg-001' })
    await repository.close()
  })

  it('Run CAS 只在 revision 匹配时成功，并拒绝覆盖终态', async () => {
    const repository = await setup()
    const first = run('run-001')
    await repository.createTurnWithClaim(first, task('task-001', first.id), message('msg-001', first.id), timestamp)

    const completed = await repository.updateRunIfRevision(
      { ...first, status: 'completed', ended_at: timestamp, updated_at: timestamp },
      1,
    )
    expect(completed).toMatchObject({ status: 'completed' })
    // 迟到事件用旧 revision 写入必须失败。
    await expect(repository.updateRunIfRevision(
      { ...first, status: 'failed', updated_at: timestamp },
      1,
    )).resolves.toBeNull()
    await expect(repository.getRun('run-001')).resolves.toMatchObject({ status: 'completed' })
    await repository.close()
  })

  it('新 Run 从 1 连续分配 sequence，completed 冻结水位且拒绝后续普通 append', async () => {
    const repository = await setup()
    const first = run('run-001')
    await repository.createTurnWithClaim(first, task('task-001', first.id), message('msg-001', first.id), timestamp)
    const append = async (id: string): Promise<number> => (await repository.appendEvent({
      event_id: id, schema_version: 1, workspace_id: 'workspace-001', session_id: 'session-001',
      run_id: 'run-001', type: 'agent.message', source: 'acp-runtime', occurred_at: timestamp,
      payload: { text: id },
    })).sequence
    expect(await append('e1')).toBe(1)
    expect(await append('e2')).toBe(2)
    const revision = await repository.getRunStateRevision('run-001')
    await repository.finalizeRun({
      run: { ...first, status: 'completed' }, expectedStateRevision: revision ?? 1,
      taskId: 'task-001', taskStatus: 'completed', slotId: 'slot-001', releaseClaim: false,
    })
    const database = (repository as unknown as { database: SqliteDatabase }).database
    const cursor = database
      .prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?')
      .get('run-001') as { event_sequence: number; completed_sequence: number }
    expect(cursor).toEqual({ event_sequence: 2, completed_sequence: 2 })
    await expect(repository.appendEvent({
      event_id: 'late', schema_version: 1, workspace_id: 'workspace-001', session_id: 'session-001',
      run_id: 'run-001', type: 'agent.message', source: 'acp-runtime', occurred_at: timestamp,
      payload: { text: 'late' },
    })).rejects.toThrow('terminally closed')
    await repository.close()
  })

  it('closure Event 计入 completed_sequence，非 completed 状态不产生水位', async () => {
    const repository = await setup()
    const first = run('run-001')
    await repository.createTurnWithClaim(first, task('task-001', first.id), message('msg-001', first.id), timestamp)
    await repository.appendEvent({
      event_id: 'e1', schema_version: 1, workspace_id: 'workspace-001', session_id: 'session-001',
      run_id: 'run-001', type: 'agent.message', source: 'acp-runtime', occurred_at: timestamp,
      payload: { text: 'hello' },
    })
    const revision = await repository.getRunStateRevision('run-001')
    await repository.finalizeRun({
      run: { ...first, status: 'completed' }, expectedStateRevision: revision ?? 1,
      taskId: 'task-001', taskStatus: 'completed', slotId: 'slot-001', releaseClaim: true,
      event: {
        event_id: 'e2', schema_version: 1, workspace_id: 'workspace-001', session_id: 'session-001',
        run_id: 'run-001', type: 'run.completed', source: 'conversation-service',
        occurred_at: timestamp, payload: {},
      },
    })
    const database = (repository as unknown as { database: SqliteDatabase }).database
    expect(database.prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?')
      .get('run-001')).toEqual({ event_sequence: 2, completed_sequence: 2 })

    const failed = run('run-002')
    await repository.createTurnWithClaim(failed, task('task-002', failed.id), message('msg-002', failed.id), timestamp)
    const failedRevision = await repository.getRunStateRevision('run-002')
    await repository.finalizeRun({
      run: { ...failed, status: 'failed' }, expectedStateRevision: failedRevision ?? 1,
      taskId: 'task-002', taskStatus: 'failed', slotId: 'slot-001', releaseClaim: true,
    })
    expect(database.prepare('SELECT completed_sequence FROM runs WHERE id = ?').get('run-002'))
      .toEqual({ completed_sequence: null })
    await repository.close()
  })

  it('legacy active Run 续写保持 sequence 连续但不建立可信游标', async () => {
    const repository = await setup()
    const first = run('run-001')
    await repository.createTurnWithClaim(first, task('task-001', first.id), message('msg-001', first.id), timestamp)
    const append = async (id: string): Promise<number> => (await repository.appendEvent({
      event_id: id, schema_version: 1, workspace_id: 'workspace-001', session_id: 'session-001',
      run_id: 'run-001', type: 'agent.message', source: 'acp-runtime', occurred_at: timestamp,
      payload: { text: id },
    })).sequence
    expect(await append('e1')).toBe(1)

    // 模拟 v7 → v8 迁移后的旧 active Run：游标与水位均为 NULL。
    const database = (repository as unknown as { database: SqliteDatabase }).database
    database.prepare('UPDATE runs SET event_sequence = NULL, completed_sequence = NULL WHERE id = ?')
      .run('run-001')

    // interrupted → 正式 resume 不初始化可信游标。
    let current = await repository.getRun('run-001')
    let revision = await repository.getRunStateRevision('run-001')
    await repository.finalizeRun({
      run: { ...current!, status: 'interrupted' }, expectedStateRevision: revision ?? 1,
      taskId: 'task-001', taskStatus: 'paused', slotId: 'slot-001', releaseClaim: false,
    })
    current = await repository.getRun('run-001')
    revision = await repository.getRunStateRevision('run-001')
    await repository.finalizeRun({
      run: { ...current!, status: 'running' }, expectedStateRevision: revision ?? 1,
      taskId: 'task-001', taskStatus: 'running', slotId: 'slot-001', releaseClaim: false,
    })
    expect(await append('e2')).toBe(2)

    current = await repository.getRun('run-001')
    revision = await repository.getRunStateRevision('run-001')
    await repository.finalizeRun({
      run: { ...current!, status: 'completed', ended_at: timestamp, updated_at: timestamp },
      expectedStateRevision: revision ?? 1, taskId: 'task-001', taskStatus: 'completed',
      slotId: 'slot-001', releaseClaim: true,
    })
    expect(database.prepare('SELECT event_sequence, completed_sequence FROM runs WHERE id = ?')
      .get('run-001')).toEqual({ event_sequence: null, completed_sequence: null })
    await expect(repository.getHandoffSource('session-001', 'run-001')).resolves.toBeNull()
    await repository.close()
  })

  it('retry 只允许叶节点，并把 claim 移交给子 Run', async () => {
    const repository = await setup()
    const root = run('run-001', { status: 'failed' })
    await repository.createTurnWithClaim(root, task('task-001', root.id), message('msg-001', root.id), timestamp)

    const child = run('run-002', { status: 'failed', attempt: 2, retry_of_run_id: root.id })
    await expect(createRetryTurn(repository, root.id, child, task('task-002', child.id), 'retry-002'))
      .resolves.toMatchObject({ run_id: 'run-002' })
    await expect(repository.getSlotActivityClaim('slot-001')).resolves.toMatchObject({ run_id: 'run-002' })

    const grandchild = run('run-003', { status: 'failed', attempt: 3 })
    await expect(createRetryTurn(repository, child.id, grandchild, task('task-003', grandchild.id), 'retry-003'))
      .resolves.toMatchObject({ run_id: 'run-003' })

    // 祖先仍有后代：拒绝，且不新增行。
    const staleRetry = run('run-004', { status: 'failed', attempt: 4 })
    await expect(createRetryTurn(repository, root.id, staleRetry, task('task-004', staleRetry.id), 'retry-stale'))
      .resolves.toBeNull()
    await expect(repository.getRun('run-004')).resolves.toBeNull()

    // 同一父 Run 至多一个子 Run（唯一索引兜底）。
    const duplicate = run('run-005', { status: 'failed', attempt: 4 })
    await expect(createRetryTurn(repository, child.id, duplicate, task('task-005', duplicate.id), 'retry-duplicate'))
      .resolves.toBeNull()
    await repository.close()
  })

  it('retry 复用父 Run 的输入消息，且不暴露到公共 DTO', async () => {
    const repository = await setup()
    const root = run('run-001', { status: 'failed' })
    await repository.createTurnWithClaim(root, task('task-001', root.id), message('msg-001', root.id), timestamp)
    const child = run('run-002', { status: 'running', attempt: 2 })
    await createRetryTurn(repository, root.id, child, task('task-002', child.id), 'retry-input')

    await expect(repository.getRunInputMessage('run-002')).resolves.toMatchObject({ id: 'msg-001' })
    const snapshot = await repository.getSessionSnapshot('session-001')
    expect(JSON.stringify(snapshot)).not.toContain('input_message_id')
    await repository.close()
  })

  it('Runtime attachment 与 Session/Slot 原子保存并可替换', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '附件工作区',
      created_at: timestamp,
      updated_at: timestamp,
    })
    const attachment = {
      slot_id: 'slot-001',
      session_id: 'session-001',
      provider_connection_id: 'provider-001',
      provider_kind: 'claude' as const,
      config_revision: 1,
      adapter_version: '0.90.0',
      adapter_fingerprint: 'fp-1',
      cwd: '/tmp/work',
      runtime_directory: '/tmp/runtime',
      acp_session_id: 'acp-001',
      updated_at: timestamp,
    }
    await repository.saveSessionWithAttachment(
      { id: 'session-001', workspace_id: 'workspace-001', name: '会话', status: 'active', created_at: timestamp, updated_at: timestamp },
      { id: 'slot-001', session_id: 'session-001', model_id: 'model-001', status: 'idle', created_at: timestamp },
      attachment,
    )

    await expect(repository.getRuntimeAttachment('slot-001')).resolves.toMatchObject({ acp_session_id: 'acp-001' })
    await expect(repository.listRuntimeAttachments()).resolves.toHaveLength(1)
    // 公共 snapshot 不得包含 ACP Session ID。
    const snapshot = await repository.getSessionSnapshot('session-001')
    expect(JSON.stringify(snapshot)).not.toContain('acp-001')
    await repository.close()
  })

  it('绑定初始 Slot 的私有 Role snapshot 与 Session/attachment 同事务保存', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    await repository.createWorkspace({
      id: 'workspace-001', name: '附件工作区', created_at: timestamp, updated_at: timestamp,
    })
    const session = {
      id: 'session-001', workspace_id: 'workspace-001', name: '绑定会话',
      status: 'active' as const, created_at: timestamp, updated_at: timestamp,
    }
    const slot = {
      id: 'slot-bound', session_id: session.id, role_binding_id: 'binding-001',
      model_id: 'model-001', status: 'idle' as const, created_at: timestamp,
    }
    const attachment: RuntimeAttachmentRecord = {
      slot_id: slot.id, session_id: session.id, provider_connection_id: 'provider-001',
      provider_kind: 'claude', config_revision: 1, adapter_version: '0.90.0',
      adapter_fingerprint: 'fp-1', cwd: '/tmp/work', runtime_directory: '/tmp/runtime',
      acp_session_id: 'acp-bound', updated_at: timestamp,
    }
    const roleSnapshot: AgentSlotRoleSnapshotRecord = {
      slot_id: slot.id, workspace_id: session.workspace_id, role_binding_id: 'binding-001',
      role_binding_version: 2, role_id: 'role-001', role_version: 3, role_name: '执行者',
      system_prompt: '私有提示', required_guidelines: ['引用证据'],
      output_contract: '结论', created_at: timestamp,
    }

    await repository.saveSessionWithAttachment(session, slot, attachment, roleSnapshot)

    await expect(repository.getAgentSlotRoleSnapshot(slot.id)).resolves.toEqual(roleSnapshot)
    await expect(repository.getRuntimeAttachment(slot.id)).resolves.toEqual(attachment)
    expect(JSON.stringify(await repository.getSessionSnapshot(session.id))).not.toContain(roleSnapshot.system_prompt)
    await repository.close()
  })

  it.each([
    ['绑定 Slot 缺 snapshot', 'missing-snapshot'],
    ['默认 Slot 带 snapshot', 'default-with-snapshot'],
    ['attachment 的 Slot ID 不一致', 'attachment-slot-mismatch'],
    ['snapshot 的 Slot ID 不一致', 'snapshot-slot-mismatch'],
    ['snapshot 的 Binding ID 不一致', 'snapshot-binding-mismatch'],
    ['snapshot 的 Workspace 不一致', 'snapshot-workspace-mismatch'],
  ])('%s 时原子保存回滚', async (_label, scenario) => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    await repository.createWorkspace({
      id: 'workspace-001', name: '附件工作区', created_at: timestamp, updated_at: timestamp,
    })
    const session = {
      id: 'session-001', workspace_id: 'workspace-001', name: '绑定会话',
      status: 'active' as const, created_at: timestamp, updated_at: timestamp,
    }
    const isBound = scenario !== 'default-with-snapshot'
    const slot = {
      id: 'slot-bound', session_id: session.id,
      ...(isBound ? { role_binding_id: 'binding-001' } : {}),
      model_id: 'model-001', status: 'idle' as const, created_at: timestamp,
    }
    const attachment: RuntimeAttachmentRecord = {
      slot_id: scenario === 'attachment-slot-mismatch' ? 'slot-other' : slot.id,
      session_id: session.id, provider_connection_id: 'provider-001', provider_kind: 'claude',
      config_revision: 1, adapter_version: '0.90.0', adapter_fingerprint: 'fp-1',
      cwd: '/tmp/work', runtime_directory: '/tmp/runtime', acp_session_id: 'acp-bound', updated_at: timestamp,
    }
    const snapshot: AgentSlotRoleSnapshotRecord = {
      slot_id: scenario === 'snapshot-slot-mismatch' ? 'slot-other' : slot.id,
      workspace_id: scenario === 'snapshot-workspace-mismatch' ? 'workspace-other' : session.workspace_id,
      role_binding_id: scenario === 'snapshot-binding-mismatch' ? 'binding-other' : 'binding-001',
      role_binding_version: 2, role_id: 'role-001', role_version: 3,
      role_name: '执行者', system_prompt: '私有提示', required_guidelines: [],
      output_contract: '结论', created_at: timestamp,
    }

    await expect(repository.saveSessionWithAttachment(
      session,
      slot,
      attachment,
      scenario === 'missing-snapshot' ? undefined : snapshot,
    )).rejects.toThrow()

    await expect(repository.getSession(session.id)).resolves.toBeNull()
    await expect(repository.getAgentSlot(slot.id)).resolves.toBeNull()
    await expect(repository.getRuntimeAttachment(slot.id)).resolves.toBeNull()
    await repository.close()
  })

  it('终态事务按 state_revision CAS 原子更新 Run、Task、claim 与事件', async () => {
    const repository = await setup()
    const first = run('run-001')
    await repository.createTurnWithClaim(first, task('task-001', first.id), message('msg-001', first.id), timestamp)

    const finalized = await repository.finalizeRun({
      run: { ...first, status: 'completed', ended_at: timestamp, updated_at: timestamp },
      expectedStateRevision: 1,
      taskId: 'task-001',
      taskStatus: 'completed',
      slotId: 'slot-001',
      releaseClaim: true,
      event: {
        event_id: 'event-001',
        schema_version: 1,
        workspace_id: 'workspace-001',
        session_id: 'session-001',
        run_id: 'run-001',
        type: 'run.completed',
        source: 'test',
        occurred_at: timestamp,
        payload: {},
      },
    })
    expect(finalized?.run.status).toBe('completed')
    expect(finalized?.task.status).toBe('completed')
    await expect(repository.getSlotActivityClaim('slot-001')).resolves.toBeNull()
    await expect(repository.replayEvents('run-001', 0)).resolves.toHaveLength(1)

    // 迟到事件用旧 revision 写入必须失败，且不得改 Task/claim。
    await expect(repository.finalizeRun({
      run: { ...first, status: 'failed', updated_at: timestamp },
      expectedStateRevision: 1,
      taskId: 'task-001',
      taskStatus: 'failed',
      slotId: 'slot-001',
      releaseClaim: true,
    })).resolves.toBeNull()
    await expect(repository.getRun('run-001')).resolves.toMatchObject({ status: 'completed' })
    await repository.close()
  })

  it('start 的 receipt 引用与 Run/Task/Message/claim 原子提交，派发边界仍为 not_started', async () => {
    const repository = await setup()
    await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'req-1', command: 'start',
      target_id: 'session-001', status: 'reserved', dispatch_state: 'not_started', updated_at: timestamp,
    })
    const first = run('run-001')
    const receipt = await repository.getCommandReceipt('workspace-001', 'req-1', 'start')

    await expect(repository.createTurnWithReceipt(
      first,
      task('task-001', first.id),
      message('msg-001', first.id),
      receipt!,
      { status: 'reserved', dispatch_state: 'not_started', target_id: 'session-001', target_slot_id: null },
      timestamp,
    )).resolves.toBe('created')

    // 引用已提交，但真正的 dispatch 边界仍由调用 Runtime 前的 CAS 推进。
    await expect(repository.getCommandReceipt('workspace-001', 'req-1', 'start')).resolves.toMatchObject({
      status: 'reserved', dispatch_state: 'not_started',
      run_id: 'run-001', task_id: 'task-001', message_id: 'msg-001',
    })
    await expect(repository.getSlotActivityClaim('slot-001')).resolves.toMatchObject({ run_id: 'run-001' })
    await repository.close()
  })

  it('Slot 软删除后旧快照不能创建 Run/Task/Message 或 claim', async () => {
    const repository = await setup()
    await repository.createAgentSlot({
      id: 'slot-deleted',
      session_id: 'session-001',
      role_binding_id: 'binding-001',
      model_id: 'model-002',
      status: 'idle',
      created_at: timestamp,
    })
    await expect(repository.softDeleteAgentSlot('session-001', 'slot-deleted', timestamp)).resolves.toBe('deleted')
    const receipt = await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'req-deleted-slot', command: 'start',
      target_id: 'session-001', target_slot_id: 'slot-deleted',
      status: 'reserved', dispatch_state: 'not_started', updated_at: timestamp,
    })
    const runRecord = run('run-deleted-slot')
    const taskRecord = { ...task('task-deleted-slot', runRecord.id), slot_id: 'slot-deleted' }

    await expect(repository.createTurnWithReceipt(
      runRecord,
      taskRecord,
      message('message-deleted-slot', runRecord.id),
      receipt,
      { status: 'reserved', dispatch_state: 'not_started', target_id: 'session-001', target_slot_id: 'slot-deleted' },
      timestamp,
    )).resolves.toBe('slot_unavailable')
    await expect(repository.getRun(runRecord.id)).resolves.toBeNull()
    await expect(repository.getSlotActivityClaim('slot-deleted')).resolves.toBeNull()
    await repository.close()
  })

  it('同 request_id 的并发重复创建返回既有引用而不污染回执', async () => {
    const repository = await setup()
    const receipt = await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'req-concurrent', command: 'start',
      target_id: 'session-001', target_slot_id: 'slot-001',
      status: 'reserved', dispatch_state: 'not_started', updated_at: timestamp,
    })
    const firstRun = run('run-first')
    await expect(repository.createTurnWithReceipt(
      firstRun,
      task('task-first', firstRun.id),
      message('message-first', firstRun.id),
      receipt,
      { status: 'reserved', dispatch_state: 'not_started', target_id: 'session-001', target_slot_id: 'slot-001' },
      timestamp,
    )).resolves.toBe('created')

    const duplicateRun = run('run-duplicate')
    await expect(repository.createTurnWithReceipt(
      duplicateRun,
      task('task-duplicate', duplicateRun.id),
      message('message-duplicate', duplicateRun.id),
      receipt,
      { status: 'reserved', dispatch_state: 'not_started', target_id: 'session-001', target_slot_id: 'slot-001' },
      timestamp,
    )).resolves.toBe('receipt_conflict')

    await expect(repository.getRun('run-duplicate')).resolves.toBeNull()
    await expect(repository.getCommandReceipt('workspace-001', 'req-concurrent', 'start'))
      .resolves.toMatchObject({ status: 'reserved', run_id: 'run-first', task_id: 'task-first' })
    await repository.close()
  })

  it('Slot 已软删除后拒绝创建 retry 子 Run', async () => {
    const repository = await setup()
    await repository.createAgentSlot({
      id: 'slot-deleted', session_id: 'session-001', role_binding_id: 'binding-001',
      model_id: 'model-002', status: 'idle', created_at: timestamp,
    })
    await repository.saveRun(run('run-parent', { status: 'failed' }))
    await expect(repository.softDeleteAgentSlot('session-001', 'slot-deleted', timestamp)).resolves.toBe('deleted')

    await expect(createRetryTurn(
      repository,
      'run-parent',
      run('run-child', { attempt: 2 }),
      { ...task('task-child', 'run-child'), slot_id: 'slot-deleted' },
      'retry-deleted-slot',
    )).resolves.toBeNull()
    await expect(repository.getRun('run-child')).resolves.toBeNull()
    await repository.close()
  })

  it('retry 子 Run 与 receipt 引用同事务提交，rollback 先赢时 stale dispatch 失败', async () => {
    const repository = await setup()
    const parent = run('run-parent', { status: 'failed' })
    await repository.createTurnWithClaim(parent, task('task-parent', parent.id), message('message-parent', parent.id), timestamp)
    const receipt = await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'retry-key', command: 'retry',
      target_id: parent.id, status: 'failed', dispatch_state: 'not_started', updated_at: timestamp,
    })
    const child = run('run-child', { attempt: 2 })
    const childTask = task('task-child', child.id)

    const createdReceipt = await repository.createRetryTurn(
      parent.id,
      child,
      childTask,
      receipt,
      { status: 'failed', dispatch_state: 'not_started', run_id: null, task_id: null, message_id: null },
      timestamp,
    )
    expect(createdReceipt).toMatchObject({ run_id: child.id, task_id: childTask.id, message_id: 'message-parent' })
    await expect(repository.rollbackRetryTurn(createdReceipt!, child.id, parent.id, childTask.slot_id)).resolves.toBe(true)

    await expect(repository.updateCommandReceipt({
      ...createdReceipt!, status: 'running', dispatch_state: 'started', updated_at: timestamp,
    }, 'failed', 'not_started')).resolves.toBeNull()
    await expect(repository.getRun(child.id)).resolves.toBeNull()
    await expect(repository.getSlotActivityClaim(childTask.slot_id)).resolves.toMatchObject({ run_id: parent.id })
    const rolledBackReceipt = await repository.getCommandReceipt('workspace-001', 'retry-key', 'retry')
    expect(rolledBackReceipt).toMatchObject({ status: 'failed', dispatch_state: 'not_started' })
    expect(rolledBackReceipt?.run_id).toBeUndefined()
    expect(rolledBackReceipt?.task_id).toBeUndefined()
    expect(rolledBackReceipt?.message_id).toBeUndefined()
    await repository.close()
  })

  it('retry 回滚会删除子 Run/Task 并把 claim 还给父 Run', async () => {
    const repository = await setup()
    const root = run('run-001', { status: 'failed' })
    await repository.createTurnWithClaim(root, task('task-001', root.id), message('msg-001', root.id), timestamp)
    const child = run('run-002', { status: 'running', attempt: 2 })
    const childReceipt = await createRetryTurn(repository, root.id, child, task('task-002', child.id), 'retry-same-key')

    await expect(repository.rollbackRetryTurn(childReceipt!, child.id, root.id, 'slot-001')).resolves.toBe(true)

    await expect(repository.getRun('run-002')).resolves.toBeNull()
    await expect(repository.getSlotActivityClaim('slot-001')).resolves.toMatchObject({ run_id: 'run-001' })
    const retryReceipt = await repository.getCommandReceipt('workspace-001', 'retry-same-key', 'retry')
    expect(retryReceipt?.status).toBe('failed')
    expect(retryReceipt?.run_id).toBeUndefined()
    expect(retryReceipt?.task_id).toBeUndefined()
    expect(retryReceipt?.message_id).toBeUndefined()
    // 回滚后相同 request_id 可创建新 attempt。
    const again = run('run-003', { status: 'running', attempt: 2 })
    await expect(createRetryTurn(repository, root.id, again, task('task-003', again.id), 'retry-same-key'))
      .resolves.toMatchObject({ run_id: 'run-003' })
    await repository.close()
  })

  it('start 原子记录 Role、Binding 与原始消息的 ContextSource', async () => {
    const repository = await setup()
    const slotRecord = {
      id: 'slot-002',
      session_id: 'session-001',
      role_binding_id: 'binding-002',
      model_id: 'model-002',
      status: 'idle' as const,
      created_at: timestamp,
    }
    await repository.addAgentSlotWithAttachmentAndRoleSnapshot(slotRecord, {
      slot_id: slotRecord.id,
      session_id: slotRecord.session_id,
      provider_connection_id: 'provider-002',
      provider_kind: 'claude',
      config_revision: 1,
      adapter_version: '0.90.0',
      adapter_fingerprint: 'fp-002',
      cwd: '/tmp/work',
      runtime_directory: '/tmp/provider-002',
      acp_session_id: 'private-acp-session-002',
      updated_at: timestamp,
    }, {
      slot_id: slotRecord.id,
      workspace_id: 'workspace-001',
      role_binding_id: 'binding-002',
      role_binding_version: 3,
      role_id: 'role-002',
      role_version: 2,
      role_name: '审查者',
      system_prompt: '找出问题',
      required_guidelines: ['引用证据'],
      output_contract: '给出行号',
      created_at: timestamp,
    })
    const receipt = await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'req-context', command: 'start',
      target_id: 'session-001', target_slot_id: slotRecord.id,
      status: 'reserved', dispatch_state: 'not_started', updated_at: timestamp,
    })
    const runRecord = run('run-context')
    const taskRecord = { ...task('task-context', runRecord.id), slot_id: slotRecord.id }
    const inputMessage = message('message-context', runRecord.id)

    await expect(repository.createTurnWithReceipt(
      runRecord,
      taskRecord,
      inputMessage,
      receipt,
      {
        status: 'reserved',
        dispatch_state: 'not_started',
        target_id: 'session-001',
        target_slot_id: slotRecord.id,
      },
      timestamp,
    )).resolves.toBe('created')
    await expect(repository.getTaskContextSources(taskRecord.id)).resolves.toEqual([
      { task_id: taskRecord.id, source_type: 'role', source_id: 'role-002', source_version: 2, created_at: timestamp },
      { task_id: taskRecord.id, source_type: 'role_binding', source_id: 'binding-002', source_version: 3, created_at: timestamp },
      { task_id: taskRecord.id, source_type: 'message', source_id: inputMessage.id, source_version: 1, created_at: timestamp },
    ])
    await repository.close()
  })

  it('target_slot_id 不匹配时原子拒绝创建 Run', async () => {
    const repository = await setup()
    await repository.createAgentSlot({
      id: 'slot-002',
      session_id: 'session-001',
      role_binding_id: 'binding-002',
      model_id: 'model-002',
      status: 'idle',
      created_at: timestamp,
    })
    await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'req-slot', command: 'start',
      target_id: 'session-001', target_slot_id: 'slot-002',
      status: 'reserved', dispatch_state: 'not_started', updated_at: timestamp,
    })
    const receipt = await repository.getCommandReceipt('workspace-001', 'req-slot', 'start')
    const runRecord = run('run-slot')

    await expect(repository.createTurnWithReceipt(
      runRecord,
      task('task-slot', runRecord.id),
      message('msg-slot', runRecord.id),
      receipt!,
      {
        status: 'reserved',
        dispatch_state: 'not_started',
        target_id: 'session-001',
        target_slot_id: 'slot-001',
      },
      timestamp,
    )).resolves.toBe('receipt_conflict')
    await expect(repository.getRun(runRecord.id)).resolves.toBeNull()
    await expect(repository.getCommandReceipt('workspace-001', 'req-slot', 'start'))
      .resolves.toMatchObject({ target_slot_id: 'slot-002' })
    await repository.close()
  })

  it('回执失败边界与目标不匹配时不会创建 Run', async () => {
    const repository = await setup()
    // 预占一个活动 Run，制造 slot_busy。
    const active = run('run-active')
    await repository.createTurnWithClaim(active, task('task-active', active.id), message('msg-active', active.id), timestamp)

    await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'req-1', command: 'start',
      target_id: 'session-001', status: 'reserved', dispatch_state: 'not_started', updated_at: timestamp,
    })
    const receipt = await repository.getCommandReceipt('workspace-001', 'req-1', 'start')
    const blocked = run('run-002')
    await expect(repository.createTurnWithReceipt(
      blocked,
      task('task-002', blocked.id),
      message('msg-002', blocked.id),
      receipt!,
      { status: 'reserved', dispatch_state: 'not_started', target_id: 'session-001', target_slot_id: null },
      timestamp,
    )).resolves.toBe('slot_busy')
    await expect(repository.getRun('run-002')).resolves.toBeNull()
    await expect(repository.getCommandReceipt('workspace-001', 'req-1', 'start'))
      .resolves.toMatchObject({ status: 'failed', dispatch_state: 'not_started', error_code: 'slot_busy' })

    // 目标不匹配（并发 insert-or-get 命中别的键）不得写入。
    await repository.insertCommandReceipt({
      workspace_id: 'workspace-001', request_id: 'req-2', command: 'start',
      target_id: 'session-other', status: 'reserved', dispatch_state: 'not_started', updated_at: timestamp,
    })
    const other = await repository.getCommandReceipt('workspace-001', 'req-2', 'start')
    await expect(repository.createTurnWithReceipt(
      run('run-003'),
      task('task-003', 'run-003'),
      message('msg-003', 'run-003'),
      other!,
      { status: 'reserved', dispatch_state: 'not_started', target_id: 'session-001', target_slot_id: null },
      timestamp,
    )).resolves.toBe('receipt_conflict')
    await expect(repository.getRun('run-003')).resolves.toBeNull()
    await repository.close()
  })

  it('命令回执按状态与派发边界 CAS 迁移', async () => {
    const repository = await setup()
    const receipt = {
      workspace_id: 'workspace-001',
      request_id: 'req-1',
      command: 'start',
      target_id: 'session-001',
      status: 'reserved' as const,
      dispatch_state: 'not_started' as const,
      updated_at: timestamp,
    }
    const inserted = await repository.insertCommandReceipt(receipt)
    expect(inserted.status).toBe('reserved')
    // 同键插入返回既有回执，不覆盖。
    const again = await repository.insertCommandReceipt({ ...receipt, status: 'completed' })
    expect(again.status).toBe('reserved')

    const failed = await repository.updateCommandReceipt(
      { ...receipt, status: 'failed', error_code: 'provider_needs_configuration', updated_at: timestamp },
      'reserved',
      'not_started',
    )
    expect(failed).toMatchObject({ status: 'failed', error_code: 'provider_needs_configuration' })

    // 错误的前置状态不能迁移。
    await expect(repository.updateCommandReceipt(
      { ...receipt, status: 'completed', updated_at: timestamp },
      'reserved',
      'not_started',
    )).resolves.toBeNull()
    await repository.close()
  })
})
