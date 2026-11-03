import { describe, expect, it } from 'vitest'

import { SqliteDatabase } from './sqlite-database.js'
import { SqlitePermissionEventStore } from './sqlite-permission-event-store.js'
import { SqliteRepository } from './sqlite-repository.js'

describe('SQLite 权限事件事务', () => {
  it('审计事件写入失败时回滚权限状态更新', async () => {
    const database = new SqliteDatabase(':memory:')
    const repository = new SqliteRepository(database)
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
      id: 'run-001', workspace_id: 'workspace-001', session_id: 'session-001', status: 'waiting_user', attempt: 1,
    })
    await repository.saveTask({
      id: 'task-001', workspace_id: 'workspace-001', session_id: 'session-001', run_id: 'run-001',
      slot_id: 'slot-001', title: '权限任务', status: 'paused',
      created_at: '2026-10-14T10:00:00.000Z', updated_at: '2026-10-14T10:00:00.000Z',
    })
    const request = {
      id: 'permission-001', run_id: 'run-001', task_id: 'task-001', slot_id: 'slot-001',
      capability: 'execute', description: '执行命令', adapter_options: [], status: 'pending' as const,
      requested_at: '2026-10-14T10:00:00.000Z', soft_timeout_at: '2026-10-14T10:05:00.000Z',
      expires_at: '2026-10-14T10:30:00.000Z', overdue_at: '2026-10-14T10:05:00.000Z',
    }
    const originalRequest = { ...request, overdue_at: undefined }
    await repository.savePermissionRequest(originalRequest)
    database.prepare('DROP TABLE events').run()

    const eventStore = new SqlitePermissionEventStore(database, null)
    await expect(eventStore.updatePermissionIfCurrent('pending', request)).rejects.toThrow()
    const restored = await repository.getPermissionRequest(request.id)
    expect(restored?.status).toBe('pending')
    expect(restored?.overdue_at).toBeUndefined()
    await repository.close()
  })
})
