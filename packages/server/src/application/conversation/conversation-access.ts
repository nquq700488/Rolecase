import type { RunDto, TaskDto } from '@rolecast/contract'

import { ApplicationError } from '../errors.js'
import type { AgentRuntimePort, AgentRuntimeSession } from '../ports/agent-runtime-port.js'
import type { RepositoryPort, RuntimeAttachmentRecord } from '../ports/repository-port.js'
import type { RuntimeSessionRegistryPort } from '../sessions/session-service.js'

/** 读取 Run；不存在时转换为稳定 404。 */
export async function requireRun(repository: RepositoryPort, runId: string): Promise<RunDto> {
  const run = await repository.getRun(runId)
  if (run === null) {
    throw new ApplicationError('Run 不存在', 'not_found', 404, { resource: 'run' })
  }
  return run
}

/** 读取 Run 关联的 Task；缺失表示数据不一致。 */
export async function requireTask(repository: RepositoryPort, run: RunDto): Promise<TaskDto> {
  const snapshot = await repository.getSessionSnapshot(run.session_id)
  const task = snapshot?.tasks.find((candidate) => candidate.run_id === run.id)
  if (task === undefined) {
    throw new ApplicationError('Run 没有关联 Task', 'state_conflict', 409)
  }
  return task
}

/** 按 task id 在 Session 内查找 Task。 */
export async function findTask(
  repository: RepositoryPort,
  sessionId: string,
  taskId: string,
): Promise<TaskDto | null> {
  const snapshot = await repository.getSessionSnapshot(sessionId)
  return snapshot?.tasks.find((candidate) => candidate.id === taskId) ?? null
}

/** 读取 Run 当前 state_revision。 */
export async function requireRevision(repository: RepositoryPort, runId: string): Promise<number> {
  const revision = await repository.getRunStateRevision(runId)
  if (revision === null) {
    throw new ApplicationError('Run 不存在', 'not_found', 404, { resource: 'run' })
  }
  return revision
}

/** resume/retry 前不允许存在任何 pending Permission。 */
export async function assertNoPendingPermission(
  repository: RepositoryPort,
  run: RunDto,
): Promise<void> {
  const snapshot = await repository.getSessionSnapshot(run.session_id)
  if (snapshot?.permissions.some((permission) => permission.status === 'pending') === true) {
    throw new ApplicationError('存在待处理权限请求，请先回答或取消', 'state_conflict', 409)
  }
}

/** resume 需要活动 Runtime；内存缺失时按 Slot attachment 重挂接。 */
export async function ensureRuntimeSession(
  sessions: RuntimeSessionRegistryPort,
  slotId: string,
): Promise<AgentRuntimeSession> {
  const existing = sessions.getRuntimeSession(slotId)
  if (existing !== null) {
    return existing
  }
  const reattached = await sessions.reattach?.(slotId)
  if (reattached === null || reattached === undefined) {
    throw new ApplicationError('Runtime 无法恢复，请重新创建 Session', 'state_conflict', 409)
  }
  return reattached
}

/**
 * 确保 Run 拥有 Slot 的 dispatch 权。
 *
 * resume / 重新派发前调用：claim 已被其他 Run 占用时必须拒绝，避免同一
 * ACP Session 上并发两轮 turn；claim 缺失时由当前 Run 重新取得。
 */
export async function ensureSlotClaim(
  repository: RepositoryPort,
  task: TaskDto,
  run: RunDto,
  now: string,
): Promise<void> {
  const claim = await repository.getSlotActivityClaim(task.slot_id)
  if (claim !== null && claim.run_id === run.id) {
    return
  }
  if (claim !== null) {
    throw new ApplicationError('该 Slot 已有其他活动 Run', 'slot_busy', 409)
  }
  const claimed = await repository.claimSlotActivity(task.slot_id, run.id, now)
  if (!claimed) {
    throw new ApplicationError('该 Slot 已被占用', 'slot_busy', 409)
  }
}

/** 读取 Run 所属 Slot 的私有 Runtime attachment。 */
export async function requireAttachment(
  repository: RepositoryPort,
  run: RunDto,
): Promise<RuntimeAttachmentRecord> {
  const snapshot = await repository.getSessionSnapshot(run.session_id)
  const slotId = snapshot?.tasks.find((task) => task.run_id === run.id)?.slot_id
  if (slotId === undefined) {
    throw new ApplicationError('Run 没有关联 Slot', 'state_conflict', 409)
  }
  const attachment = await repository.getRuntimeAttachment(slotId)
  if (attachment === null) {
    throw new ApplicationError('Runtime attachment 缺失', 'state_conflict', 409)
  }
  return attachment
}

/** 回收未被任何 Run 追踪的临时 ACP Session 与连接。 */
export async function discardRuntimeSession(
  runtime: AgentRuntimePort,
  opened: { connection: { connectionId: string }; session: AgentRuntimeSession },
): Promise<void> {
  try {
    await runtime.closeSession(opened.session)
  } catch {
    // 继续回收连接。
  }
  if (runtime.closeConnection !== undefined) {
    await runtime.closeConnection(opened.connection.connectionId).catch(() => undefined)
  }
}
