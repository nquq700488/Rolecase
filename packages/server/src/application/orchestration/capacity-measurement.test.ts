import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { SqliteDatabase } from '../../infrastructure/persistence/sqlite-database.js'
import { SqliteRepository } from '../../infrastructure/persistence/sqlite-repository.js'
import { evaluateCapacity, type CapacityDimension, type CapacityLimits } from './capacity-admission.js'

const timestamp = '2026-10-14T10:00:00.000Z'

const limits: CapacityLimits = { queuedTasks: 2, pendingPermissions: 1, workflowNodes: 3 }

type Row = { count: number }

const countQueued = (database: SqliteDatabase): number => (
  database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'queued'").get() as Row
).count

const countPending = (database: SqliteDatabase): number => (
  database.prepare("SELECT COUNT(*) AS count FROM permission_requests WHERE status = 'pending'").get() as Row
).count

const tableCounts = (database: SqliteDatabase) => ({
  runs: (database.prepare('SELECT COUNT(*) AS count FROM runs').get() as Row).count,
  tasks: (database.prepare('SELECT COUNT(*) AS count FROM tasks').get() as Row).count,
  permissions: (database.prepare('SELECT COUNT(*) AS count FROM permission_requests').get() as Row).count,
})

const setup = async (
  seed: { queued: number; pending: number },
  options: {
    failSeed?: boolean
    onDirectory?: (directory: string) => void
    /** 测试注入：替换初始化失败时的目录清理操作。 */
    removeDirectory?: (directory: string) => Promise<void>
    /** 测试注入：在打开 SqliteDatabase 前准备损坏 fixture。 */
    prepareDirectory?: (directory: string) => void
  } = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), 'rolecast-capacity-'))
  options.onDirectory?.(directory)
  const path = join(directory, 'capacity.sqlite')
  let database: SqliteDatabase | null = null
  let repository: SqliteRepository | null = null
  try {
    options.prepareDirectory?.(directory)
    database = new SqliteDatabase(path)
    repository = new SqliteRepository(database)
    await repository.createWorkspace({ id: 'w', name: 'w', created_at: timestamp, updated_at: timestamp })
    await repository.createSession({
      id: 's', workspace_id: 'w', name: 's', status: 'active', created_at: timestamp, updated_at: timestamp,
    })
    await repository.createAgentSlot({
      id: 'slot-1', session_id: 's', model_id: 'm', status: 'idle', created_at: timestamp,
    })
    await repository.saveRun({
      id: 'run-1', workspace_id: 'w', session_id: 's', status: 'queued', attempt: 1,
      created_at: timestamp, updated_at: timestamp,
    })
    await repository.saveTask({
      id: 'task-base', workspace_id: 'w', session_id: 's', run_id: 'run-1', slot_id: 'slot-1',
      title: 'base', status: 'running', created_at: timestamp, updated_at: timestamp,
    })
    for (let index = 0; index < seed.queued; index += 1) {
      await repository.saveTask({
        id: `task-queued-${String(index)}`, workspace_id: 'w', session_id: 's', run_id: 'run-1',
        slot_id: 'slot-1', title: 'queued', status: 'queued', created_at: timestamp, updated_at: timestamp,
      })
    }
    for (let index = 0; index < seed.pending; index += 1) {
      await repository.savePermissionRequest({
        id: `permission-${String(index)}`, run_id: 'run-1', task_id: 'task-base', slot_id: 'slot-1',
        capability: 'execute', description: '执行命令',
        adapter_options: [{ option_id: 'allow_once', name: '允许一次', kind: 'allow_once' }],
        status: 'pending', requested_at: timestamp,
        soft_timeout_at: '2026-10-14T10:05:00.000Z', expires_at: '2026-10-14T10:30:00.000Z',
      })
    }
    if (options.failSeed === true) {
      throw new Error('injected seed failure')
    }
    return { directory, path, database, repository }
  } catch (error: unknown) {
    // 尽最大努力关闭资源并清理目录；清理失败不得静默吞掉。
    const cleanupErrors: unknown[] = []
    if (repository !== null) {
      try {
        await repository.close()
      } catch (closeError: unknown) {
        cleanupErrors.push(closeError)
        try {
          database?.close()
        } catch (fallbackError: unknown) {
          cleanupErrors.push(fallbackError)
        }
      }
    } else if (database !== null) {
      try {
        database.close()
      } catch (closeError: unknown) {
        cleanupErrors.push(closeError)
      }
    }
    const removeDirectory = options.removeDirectory
      ?? ((target: string) => rm(target, { recursive: true, force: true }))
    try {
      await removeDirectory(directory)
    } catch (removeError: unknown) {
      cleanupErrors.push(removeError)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `capacity measurement setup failed and cleanup also failed; temporary directory may remain: ${directory}`,
        { cause: error },
      )
    }
    throw error
  }
}

/** 测试专用 Fake Runtime：只记录 dispatch 调用，不启动 Adapter/子进程。 */
class FakeCapacityRuntime {
  readonly dispatchedTaskIds: string[] = []

  dispatch(taskId: string): void {
    this.dispatchedTaskIds.push(taskId)
  }
}

/** 在测试夹具中模拟「计数 → 判定 → 写入」同事务边界；只有事务提交且接受后才 dispatch。 */
const admitTask = (
  database: SqliteDatabase,
  injectedLimits: unknown,
  id: string,
) => database.transaction(() => {
  const decision = evaluateCapacity({
    limits: injectedLimits, dimension: 'queuedTasks', used: countQueued(database), requested: 1,
  })
  if (decision.accepted) {
    database.prepare(
      `INSERT INTO tasks(id, workspace_id, session_id, run_id, slot_id, title, status, created_at, updated_at)
       VALUES (?, 'w', 's', 'run-1', 'slot-1', 'queued', 'queued', ?, ?)`,
    ).run(id, timestamp, timestamp)
  }
  return decision
})

/** 事务 commit 返回后才调用 Fake Runtime；拒绝路径不会触达 dispatch。 */
const admitAndDispatchTask = (
  database: SqliteDatabase,
  injectedLimits: unknown,
  id: string,
  runtime: FakeCapacityRuntime,
) => {
  const decision = admitTask(database, injectedLimits, id)
  if (decision.accepted) {
    runtime.dispatch(id)
  }
  return decision
}

const admitPermission = (
  database: SqliteDatabase,
  injectedLimits: unknown,
  id: string,
) => database.transaction(() => {
  const decision = evaluateCapacity({
    limits: injectedLimits, dimension: 'pendingPermissions', used: countPending(database), requested: 1,
  })
  if (decision.accepted) {
    database.prepare(
      `INSERT INTO permission_requests(
        id, run_id, task_id, slot_id, capability, description, adapter_options_json,
        status, requested_at, soft_timeout_at, expires_at
      ) VALUES (?, 'run-1', 'task-base', 'slot-1', 'execute', '执行命令', '[]', 'pending', ?, ?, ?)`,
    ).run(id, timestamp, '2026-10-14T10:05:00.000Z', '2026-10-14T10:30:00.000Z')
  }
  return decision
})

describe('容量测量夹具（测试专用）', () => {
  it('Q/P 使用量来自真实 SQLite 行，关闭重开后计数一致且不持久化 quota', async () => {
    const { directory, path, database, repository } = await setup({ queued: 2, pending: 1 })
    try {
      expect(countQueued(database)).toBe(2)
      expect(countPending(database)).toBe(1)
      await repository.close()

      const reopened = new SqliteDatabase(path)
      try {
        expect(countQueued(reopened)).toBe(2)
        expect(countPending(reopened)).toBe(1)
        expect(reopened.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%quota%' OR name LIKE '%capacity%')",
        ).all()).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('Q/P 恰好达到上限接受，limit+1 拒绝且零 Runtime dispatch/零写入', async () => {
    const { directory, database, repository } = await setup({ queued: 1, pending: 0 })
    try {
      const runtime = new FakeCapacityRuntime()
      const first = admitAndDispatchTask(database, limits, 'task-new', runtime)
      expect(first).toMatchObject({ accepted: true, reason: 'accepted' })
      expect(countQueued(database)).toBe(2)
      expect(runtime.dispatchedTaskIds).toEqual(['task-new'])

      const rowsBeforeOverflow = tableCounts(database)
      const overflow = admitAndDispatchTask(database, limits, 'task-over', runtime)
      expect(overflow).toMatchObject({ accepted: false, reason: 'capacity_exceeded' })
      expect(tableCounts(database)).toEqual(rowsBeforeOverflow)
      expect(countQueued(database)).toBe(2)
      expect(runtime.dispatchedTaskIds).toEqual(['task-new'])

      // P 只做 pending 行准入，不触发 Runtime dispatch。
      expect(admitPermission(database, limits, 'permission-new')).toMatchObject({ accepted: true })
      expect(admitPermission(database, limits, 'permission-over')).toMatchObject({
        accepted: false, reason: 'capacity_exceeded',
      })
      expect(countPending(database)).toBe(1)
      expect(runtime.dispatchedTaskIds).toEqual(['task-new'])
    } finally {
      await repository.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('缺失/非法额度时 fail-closed，计数、写入与 dispatch 均为 0 增量', async () => {
    const { directory, database, repository } = await setup({ queued: 0, pending: 0 })
    try {
      const runtime = new FakeCapacityRuntime()
      const rowsBefore = tableCounts(database)
      for (const injected of [undefined, {}, { ...limits, queuedTasks: 0 }, { ...limits, queuedTasks: 1.5 }]) {
        expect(admitAndDispatchTask(database, injected, 'task-rejected', runtime))
          .toMatchObject({ accepted: false })
        expect(admitPermission(database, injected, 'permission-rejected')).toMatchObject({ accepted: false })
      }
      expect(countQueued(database)).toBe(0)
      expect(countPending(database)).toBe(0)
      expect(tableCounts(database)).toEqual(rowsBefore)
      expect(runtime.dispatchedTaskIds).toEqual([])
    } finally {
      await repository.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('同一进程/单连接顺序事务边界：第二次提交不超额，失败事务回滚且不 dispatch', async () => {
    const { directory, database, repository } = await setup({ queued: 0, pending: 0 })
    try {
      const runtime = new FakeCapacityRuntime()
      const sequential = { ...limits, queuedTasks: 1 }
      // 同一 Node 进程、同一 SQLite 连接上的连续事务；未验证多连接/跨进程并发。
      expect(admitAndDispatchTask(database, sequential, 'task-a', runtime)).toMatchObject({ accepted: true })
      expect(admitAndDispatchTask(database, sequential, 'task-b', runtime)).toMatchObject({
        accepted: false, reason: 'capacity_exceeded',
      })
      expect(countQueued(database)).toBe(1)
      expect(runtime.dispatchedTaskIds).toEqual(['task-a'])

      // 事务内插入后抛错：回滚且不会走到 commit 后的 dispatch。
      expect(() => database.transaction(() => {
        admitTask(database, sequential, 'task-rollback')
        throw new Error('injected rollback')
      })).toThrow('injected rollback')
      expect(countQueued(database)).toBe(1)
      expect(runtime.dispatchedTaskIds).toEqual(['task-a'])
    } finally {
      await repository.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('SqliteDatabase constructor 失败时 setup 删除受控临时目录', async () => {
    let directory = ''
    try {
      await expect(setup(
        { queued: 0, pending: 0 },
        {
          onDirectory: (created) => { directory = created },
          prepareDirectory: (created) => {
            // 连接可打开，但迁移 001 因缺少 applied_at 失败。
            const fixture = new Database(join(created, 'capacity.sqlite'))
            fixture.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)')
            fixture.close()
          },
        },
      )).rejects.toThrow('SQLite 初始化失败')
      expect(directory).not.toBe('')
      await expect(access(directory)).rejects.toBeTruthy()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('setup 初始化失败且清理失败时保留原错误、清理错误与临时路径', async () => {
    let directory = ''
    const cleanupError = new Error('injected cleanup failure')
    const rejection = await setup(
      { queued: 0, pending: 0 },
      {
        failSeed: true,
        onDirectory: (created) => { directory = created },
        removeDirectory: async () => { throw cleanupError },
      },
    ).then(() => null, (error: unknown) => error)

    try {
      expect(rejection).toBeInstanceOf(AggregateError)
      const aggregate = rejection as AggregateError
      expect(aggregate.message).toContain(directory)
      expect(aggregate.errors).toHaveLength(2)
      expect(aggregate.errors[0]).toMatchObject({ message: 'injected seed failure' })
      expect(aggregate.errors[1]).toBe(cleanupError)
      expect((aggregate as AggregateError & { cause?: unknown }).cause)
        .toMatchObject({ message: 'injected seed failure' })
    } finally {
      // 测试自身用真实清理删除注入失败后遗留的受控临时目录。
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('setup 初始化/seed 失败时关闭数据库并删除临时目录', async () => {
    let directory = ''
    await expect(setup(
      { queued: 0, pending: 0 },
      { failSeed: true, onDirectory: (created) => { directory = created } },
    )).rejects.toThrow('injected seed failure')
    expect(directory).not.toBe('')
    await expect(access(directory)).rejects.toBeTruthy()
  })

  it('N 只验证调用方预先计算的总节点数整数边界', () => {
    const dimension: CapacityDimension = 'workflowNodes'
    expect(evaluateCapacity({ limits, dimension, used: 0, requested: 3 }).accepted).toBe(true)
    expect(evaluateCapacity({ limits, dimension, used: 0, requested: 4 })).toMatchObject({
      accepted: false, reason: 'capacity_exceeded',
    })
    // 0B 不验证 DAG/嵌套遍历；输入就是总节点数整数。
    expect(evaluateCapacity({ limits, dimension, used: 0, requested: 1.5 }).reason).toBe('usage_invalid')
  })
})
