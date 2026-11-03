#!/usr/bin/env node
/**
 * 0C 本机容量曲线测量脚手架（Fake/合成数据 + 临时 SQLite）。
 *
 * 只报告观察值：不读取环境变量/配置/DI/生产入口作为额度，不设置生产 Q/P/N，
 * 不开放 production admission，不推断真实 Adapter 进程树或 SLO。
 *
 * 当前实测范围：合成 SQLite 的 Q/P 行数 + 纯容量策略判定；N 仅验证调用方
 * 预先计算的总节点数整数边界。未覆盖多 Adapter 调度、deny 事件、Permission
 * 中断、重启计数重建或 Template/DAG 遍历。
 *
 * 用法：node scripts/measure-capacity-curve.mjs [--out <path>]
 */

import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(SCRIPT_DIR)
const DIST_INDEX = join(REPO_ROOT, 'packages/server/dist/index.js')
const DIST_CAPACITY = join(
  REPO_ROOT,
  'packages/server/dist/application/orchestration/capacity-admission.js',
)

// 测试注入点：实验输入，不是生产额度候选或默认值。
const POINTS = [16, 64, 256, 1024, 4096]
const REPEATS = 3
const DIMENSIONS = ['queuedTasks', 'pendingPermissions', 'workflowNodes']
const PROGRESS_THRESHOLD_MS = 120_000
const TIMESTAMP = '2026-10-14T10:00:00.000Z'

const limitsFor = (point) => ({
  queuedTasks: point,
  pendingPermissions: point,
  workflowNodes: point,
})

/**
 * 读取文件字节数。
 *
 * DB 文件必须存在；WAL 可缺失（ENOENT → 0）。其他 stat 错误必须失败，
 * 不能伪装成有效的零字节观测。
 */
const fileBytes = async (path, optional = false) => {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (optional && error instanceof Error && error.code === 'ENOENT') {
      return 0
    }
    throw error
  }
}

const betterSqlite3Version = () => {
  try {
    const requireFromServer = createRequire(join(REPO_ROOT, 'packages/server/package.json'))
    const version = requireFromServer('better-sqlite3/package.json').version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

const ensureDist = async () => {
  try {
    await access(DIST_INDEX)
    await access(DIST_CAPACITY)
  } catch {
    throw new Error(
      '未找到 packages/server/dist 构建产物；请先运行 pnpm --filter @rolecast/server build',
    )
  }
}

const loadModules = async () => {
  const capacity = await import(pathToFileURL(DIST_CAPACITY).href)
  const server = await import(pathToFileURL(DIST_INDEX).href)
  if (typeof capacity.evaluateCapacity !== 'function' || typeof capacity.parseCapacityLimits !== 'function') {
    throw new Error('dist 中的容量策略导出缺失，请重新构建 @rolecast/server')
  }
  if (typeof server.SqliteDatabase !== 'function' || typeof server.SqliteRepository !== 'function') {
    throw new Error('dist 中的 SqliteDatabase/SqliteRepository 导出缺失，请重新构建 @rolecast/server')
  }
  return {
    evaluateCapacity: capacity.evaluateCapacity,
    parseCapacityLimits: capacity.parseCapacityLimits,
    SqliteDatabase: server.SqliteDatabase,
    SqliteRepository: server.SqliteRepository,
  }
}

const seedParents = async (repository) => {
  await repository.createWorkspace({ id: 'w', name: 'w', created_at: TIMESTAMP, updated_at: TIMESTAMP })
  await repository.createSession({
    id: 's', workspace_id: 'w', name: 's', status: 'active',
    created_at: TIMESTAMP, updated_at: TIMESTAMP,
  })
  await repository.createAgentSlot({
    id: 'slot-1', session_id: 's', model_id: 'm', status: 'idle', created_at: TIMESTAMP,
  })
  await repository.saveRun({
    id: 'run-1', workspace_id: 'w', session_id: 's', status: 'queued', attempt: 1,
    created_at: TIMESTAMP, updated_at: TIMESTAMP,
  })
  await repository.saveTask({
    id: 'task-base', workspace_id: 'w', session_id: 's', run_id: 'run-1', slot_id: 'slot-1',
    title: 'base', status: 'running', created_at: TIMESTAMP, updated_at: TIMESTAMP,
  })
}

const insertQueuedTasks = (database, startIndex, count) => {
  const insert = database.prepare(
    `INSERT INTO tasks(
      id, workspace_id, session_id, run_id, slot_id, title, status, created_at, updated_at
    ) VALUES (?, 'w', 's', 'run-1', 'slot-1', 'queued', 'queued', ?, ?)`,
  )
  database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(`queued-${String(startIndex + index)}`, TIMESTAMP, TIMESTAMP)
    }
  })
  return count
}

const insertPendingPermissions = (database, startIndex, count) => {
  const insert = database.prepare(
    `INSERT INTO permission_requests(
      id, run_id, task_id, slot_id, capability, description, adapter_options_json,
      status, requested_at, soft_timeout_at, expires_at
    ) VALUES (?, 'run-1', 'task-base', 'slot-1', 'execute', '执行命令', '[]', 'pending', ?, ?, ?)`,
  )
  database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(
        `permission-${String(startIndex + index)}`,
        TIMESTAMP,
        '2026-10-14T10:05:00.000Z',
        '2026-10-14T10:30:00.000Z',
      )
    }
  })
  return count
}

const countUsage = (database, dimension) => {
  const sql = dimension === 'queuedTasks'
    ? "SELECT COUNT(*) AS count FROM tasks WHERE status = 'queued'"
    : "SELECT COUNT(*) AS count FROM permission_requests WHERE status = 'pending'"
  return database.prepare(sql).get().count
}

const collectEnvironment = async (SqliteDatabase) => {
  const directory = await mkdtemp(join(tmpdir(), 'rolecast-capacity-env-'))
  let database = null
  let environment = null
  let measurementError = null
  try {
    database = new SqliteDatabase(join(directory, 'environment.sqlite'))
    const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version
    const journalMode = database.prepare('PRAGMA journal_mode').get().journal_mode
    const foreignKeys = database.prepare('PRAGMA foreign_keys').get().foreign_keys
    const cpuList = cpus()
    environment = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      os_release: release(),
      cpu_model: cpuList[0]?.model ?? 'unknown',
      cpu_count: cpuList.length,
      total_mem_bytes: totalmem(),
      better_sqlite3_version: betterSqlite3Version(),
      sqlite_version: sqliteVersion,
      journal_mode: journalMode,
      foreign_keys: foreignKeys,
      sqlite_settings_note: 'SqliteDatabase 只显式设置 foreign_keys 与 journal_mode；其他 PRAGMA 保持 SQLite 默认值，未在此声称其他设置。',
      collected_at: new Date().toISOString(),
    }
  } catch (error) {
    measurementError = error
  }
  const cleanupError = await cleanupResources({
    repository: null,
    database,
    directory,
    originalError: measurementError,
  })
  if (cleanupError !== null) {
    throw cleanupError
  }
  return environment
}

/**
 * 清理连接与临时目录。
 *
 * 成功返回 null 或原始测量错误；任一清理失败返回可抛出的错误：
 * 有原始错误时抛 AggregateError（errors 同时保留原始错误与清理错误，
 * cause 为原始错误），否则抛仅含清理错误的 AggregateError，并包含受控
 * 临时目录路径。清理失败不会静默通过。
 */
const cleanupResources = async ({ repository, database, directory, originalError }) => {
  const cleanupErrors = []
  if (repository !== null) {
    try {
      await repository.close()
    } catch (error) {
      cleanupErrors.push(error)
      try {
        database?.close()
      } catch (fallbackError) {
        cleanupErrors.push(fallbackError)
      }
    }
  } else if (database !== null) {
    try {
      database.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length === 0) {
    return originalError
  }
  const message = `容量测量清理失败；受控临时目录可能残留: ${directory}`
  return originalError === null
    ? new AggregateError(cleanupErrors, message)
    : new AggregateError([originalError, ...cleanupErrors], message, { cause: originalError })
}

const parseInjectedLimits = (modules, point) => {
  const parsed = modules.parseCapacityLimits(limitsFor(point))
  if (parsed === 'unconfigured' || parsed === 'invalid') {
    throw new Error(`测试注入额度非法: ${JSON.stringify(limitsFor(point))}`)
  }
  return parsed
}

/** Q/P：真实填充与 COUNT 观测；seed_rows 取自最终实测 COUNT。 */
const observeQpRows = (database, dimension, point) => {
  const insertRows = dimension === 'queuedTasks' ? insertQueuedTasks : insertPendingPermissions
  const seedStarted = performance.now()
  insertRows(database, 0, point - 1)
  let seedMs = performance.now() - seedStarted

  const lowStarted = performance.now()
  const observedLow = countUsage(database, dimension)
  const countMsLow = performance.now() - lowStarted

  const extendStarted = performance.now()
  insertRows(database, point - 1, 1)
  seedMs += performance.now() - extendStarted

  const limitStarted = performance.now()
  const observedAtLimit = countUsage(database, dimension)
  const countMs = performance.now() - limitStarted

  return {
    seedMs,
    countMs,
    countMsLow,
    seedRows: observedAtLimit,
    observedLow,
    observedAtLimit,
  }
}

/** 用实测（Q/P）或调用方预计算（N）的 used 做两侧纯策略判定。 */
const evaluateBoundary = (modules, dimension, point, parsedLimits, observedLow, observedAtLimit) => {
  const usedLow = observedLow ?? (point - 1)
  const usedAtLimit = observedAtLimit ?? point
  const started = performance.now()
  const low = modules.evaluateCapacity({
    limits: parsedLimits, dimension, used: usedLow, requested: 1,
  })
  const atLimit = modules.evaluateCapacity({
    limits: parsedLimits, dimension, used: usedAtLimit, requested: 1,
  })
  const decideMs = performance.now() - started
  return {
    decideMs,
    boundary: {
      limit: point,
      low: {
        observed_count: observedLow,
        used: usedLow,
        requested: 1,
        decision: low.reason,
      },
      at_limit: {
        observed_count: observedAtLimit,
        used: usedAtLimit,
        requested: 1,
        decision: atLimit.reason,
      },
    },
  }
}

const reportSlowPoint = (dimension, point, repeat, observation, decideMs) => {
  const totalMs = (observation.seedMs ?? 0)
    + (observation.countMsLow ?? 0)
    + (observation.countMs ?? 0)
    + decideMs
  if (totalMs > PROGRESS_THRESHOLD_MS) {
    process.stderr.write(
      `[measure] slow point dimension=${dimension} point=${point} repeat=${repeat} elapsed=${Math.round(totalMs)}ms\n`,
    )
  }
}

const formatRunResult = async ({
  dimension, point, repeat, observation, boundary, decideMs, rssBaseline, dbPath,
}) => {
  const rssSnapshot = process.memoryUsage().rss
  return {
    dimension,
    point,
    repeat,
    seed_ms: observation.seedMs,
    count_ms: observation.countMs,
    count_ms_low: observation.countMsLow,
    decide_ms: decideMs,
    seed_rows: observation.seedRows,
    boundary,
    rss_baseline_bytes: rssBaseline,
    rss_snapshot_bytes: rssSnapshot,
    rss_delta_bytes: rssSnapshot - rssBaseline,
    rss_note: '共享 Node 进程 RSS 绝对快照（含 V8/SQLite 与此前测试点高水位），不是单点增量或生产内存成本。',
    db_bytes: await fileBytes(dbPath),
    wal_bytes: await fileBytes(`${dbPath}-wal`, true),
    ...(dimension === 'workflowNodes'
      ? { clamped: Number.isSafeInteger(point) && point > 0 }
      : {}),
  }
}

/** 只协调临时目录/DB/repository 生命周期与错误清理；测量职责在拆分函数中。 */
const measureOnce = async (modules, dimension, point, repeat) => {
  const directory = await mkdtemp(join(tmpdir(), 'rolecast-capacity-curve-'))
  const dbPath = join(directory, 'capacity.sqlite')
  let database = null
  let repository = null
  let result = null
  let measurementError = null
  try {
    database = new modules.SqliteDatabase(dbPath)
    repository = new modules.SqliteRepository(database)
    await seedParents(repository)
    const parsedLimits = parseInjectedLimits(modules, point)
    const rssBaseline = process.memoryUsage().rss
    const observation = dimension === 'workflowNodes'
      ? {
        seedMs: null,
        countMs: null,
        countMsLow: null,
        seedRows: 0,
        observedLow: null,
        observedAtLimit: null,
      }
      : observeQpRows(database, dimension, point)
    const { decideMs, boundary } = evaluateBoundary(
      modules, dimension, point, parsedLimits, observation.observedLow, observation.observedAtLimit,
    )
    reportSlowPoint(dimension, point, repeat, observation, decideMs)
    result = await formatRunResult({
      dimension, point, repeat, observation, boundary, decideMs, rssBaseline, dbPath,
    })
  } catch (error) {
    measurementError = error
  }
  const cleanupError = await cleanupResources({
    repository,
    database,
    directory,
    originalError: measurementError,
  })
  if (cleanupError !== null) {
    throw cleanupError
  }
  return result
}

const selfCheck = (runs) => {
  const failures = []
  for (const run of runs) {
    if (run.boundary.low.decision !== 'accepted') {
      failures.push(`${run.dimension}/${run.point}/${run.repeat}: low decision=${run.boundary.low.decision}`)
    }
    if (run.boundary.at_limit.decision !== 'capacity_exceeded') {
      failures.push(`${run.dimension}/${run.point}/${run.repeat}: at_limit decision=${run.boundary.at_limit.decision}`)
    }
    if (run.dimension === 'workflowNodes') {
      if (run.seed_rows !== 0) {
        failures.push(`${run.dimension}/${run.point}/${run.repeat}: N seed_rows=${run.seed_rows}`)
      }
      continue
    }
    if (run.seed_rows !== run.point) {
      failures.push(`${run.dimension}/${run.point}/${run.repeat}: seed_rows=${run.seed_rows}`)
    }
    if (run.boundary.low.observed_count !== run.point - 1) {
      failures.push(`${run.dimension}/${run.point}/${run.repeat}: low count=${run.boundary.low.observed_count}`)
    }
    if (run.boundary.at_limit.observed_count !== run.point) {
      failures.push(`${run.dimension}/${run.point}/${run.repeat}: limit count=${run.boundary.at_limit.observed_count}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`容量测量自检失败:\n${failures.join('\n')}`)
  }
}

const parseOutPath = (argv) => {
  const index = argv.indexOf('--out')
  if (index < 0) {
    return null
  }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--out 需要一个文件路径')
  }
  return resolve(process.cwd(), value)
}

const main = async () => {
  const outPath = parseOutPath(process.argv.slice(2))
  await ensureDist()
  const modules = await loadModules()
  const environment = await collectEnvironment(modules.SqliteDatabase)
  const runs = []
  for (const dimension of DIMENSIONS) {
    for (const point of POINTS) {
      for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
        const run = await measureOnce(modules, dimension, point, repeat)
        runs.push(run)
        process.stderr.write(
          `[measure] ${dimension} point=${point} repeat=${repeat} seed_rows=${run.seed_rows} `
          + `low_count=${String(run.boundary.low.observed_count)} `
          + `limit_count=${String(run.boundary.at_limit.observed_count)} `
          + `seed=${run.seed_ms === null ? 'n/a' : Math.round(run.seed_ms)}ms `
          + `count=${run.count_ms === null ? 'n/a' : run.count_ms.toFixed(3)}ms `
          + `decide=${run.decide_ms.toFixed(3)}ms\n`,
        )
      }
    }
  }
  selfCheck(runs)
  const output = { environment, runs }
  const text = JSON.stringify(output, null, 2)
  process.stdout.write(`${text}\n`)
  if (outPath !== null) {
    await writeFile(outPath, `${text}\n`, 'utf8')
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
})
