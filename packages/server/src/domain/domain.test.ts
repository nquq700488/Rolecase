import { describe, expect, it } from 'vitest'

import {
  createRun,
  createTask,
  createInlineArtifactContent,
  MAX_INLINE_ARTIFACT_SIZE_BYTES,
  transitionRun,
  transitionTask,
  type Run,
  type Task,
} from './index.js'

describe('Domain 状态机', () => {
  const now = new Date('2026-10-14T10:00:00.000Z')

  it('创建单 Agent Run 和 Task 时使用初始状态', () => {
    const run = createRun({
      id: 'run-001',
      workspaceId: 'workspace-001',
      sessionId: 'session-001',
      now,
    })
    const task = createTask({
      id: 'task-001',
      workspaceId: 'workspace-001',
      sessionId: 'session-001',
      runId: run.id,
      slotId: 'slot-001',
      title: '处理用户消息',
      now,
    })

    expect(run.status).toBe('queued')
    expect(run.attempt).toBe(1)
    expect(task.status).toBe('queued')
    expect(task.runId).toBe(run.id)
  })

  it('允许 Run 从 running 等待权限后恢复或中断', () => {
    const queued = createRun({
      id: 'run-001',
      workspaceId: 'workspace-001',
      sessionId: 'session-001',
      now,
    })
    const running = transitionRun(queued, 'running', now)
    const waiting = transitionRun(running, 'waiting_user', now)
    const resumed = transitionRun(waiting, 'running', new Date(now.getTime() + 1_000))
    const interrupted = transitionRun(waiting, 'interrupted', new Date(now.getTime() + 2_000))

    expect(running.status).toBe('running')
    expect(resumed.status).toBe('running')
    expect(interrupted.status).toBe('interrupted')
    expect(queued.status).toBe('queued')
  })

  it('拒绝终态回退和不允许的 Task 状态转换', () => {
    const run: Run = {
      id: 'run-001',
      workspaceId: 'workspace-001',
      sessionId: 'session-001',
      status: 'completed',
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    }
    const task: Task = {
      id: 'task-001',
      workspaceId: 'workspace-001',
      sessionId: 'session-001',
      runId: run.id,
      slotId: 'slot-001',
      title: '任务',
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    }

    expect(() => transitionRun(run, 'running', now)).toThrowError('Run 状态不可转换')
    expect(() => transitionTask(task, 'running', now)).toThrowError('Task 状态不可转换')
  })

  it('创建 inline Artifact 内容时复制来源 bytes 并接受上限', () => {
    const source = new Uint8Array([1, 2, 3])
    const artifactContent = createInlineArtifactContent({
      artifactId: 'artifact-001',
      bytes: source,
    })

    source[0] = 9
    expect(MAX_INLINE_ARTIFACT_SIZE_BYTES).toBe(65_536)
    expect(artifactContent.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(artifactContent.bytes).not.toBe(source)
  })

  it('拒绝超过 inline Artifact 字节上限的内容', () => {
    expect(() => createInlineArtifactContent({
      artifactId: 'artifact-001',
      bytes: new Uint8Array(MAX_INLINE_ARTIFACT_SIZE_BYTES + 1),
    })).toThrowError('Artifact inline 内容超过 65,536 字节')
  })
})
