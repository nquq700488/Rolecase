import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiClientError } from '@/api/httpClient.js'

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  addAgentSlot: vi.fn(),
  removeAgentSlot: vi.fn(),
  sendMessage: vi.fn(),
  handoff: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  retry: vi.fn(),
  answer: vi.fn(),
}))

vi.mock('@/api/endpoints.js', () => ({
  sessionEndpoints: {
    snapshot: (...args: unknown[]) => mocks.snapshot(...args),
    addAgentSlot: (...args: unknown[]) => mocks.addAgentSlot(...args),
    removeAgentSlot: (...args: unknown[]) => mocks.removeAgentSlot(...args),
    sendMessage: (...args: unknown[]) => mocks.sendMessage(...args),
    handoff: (...args: unknown[]) => mocks.handoff(...args),
  },
  runEndpoints: {
    cancel: (...args: unknown[]) => mocks.cancel(...args),
    resume: (...args: unknown[]) => mocks.resume(...args),
    retry: (...args: unknown[]) => mocks.retry(...args),
  },
  permissionEndpoints: { answer: (...args: unknown[]) => mocks.answer(...args) },
}))

const wsMocks = vi.hoisted(() => ({
  starts: [] as unknown[][],
  clients: [] as Array<{
    onEvent: () => void
    onControl: (control: { type: string; session_id?: string }) => void
    onStatus: (status: string) => void
  }>,
}))

vi.mock('@/api/wsClient.js', () => ({
  WsClient: class {
    constructor(
      onEvent: () => void,
      onControl: (control: { type: string; session_id?: string }) => void,
      onStatus: (status: string) => void,
    ) {
      wsMocks.clients.push({ onEvent, onControl, onStatus })
    }
    start(...args: unknown[]): void {
      wsMocks.starts.push(args)
    }
    stop(): void {}
    updateRuns(): void {}
  },
}))

/** 可手动放行的 Promise，用于模拟迟到的跨 Session 请求。 */
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const snapshot = {
  session: {
    id: 'session-001',
    workspace_id: 'workspace-001',
    name: '会话',
    status: 'active',
    created_at: '2026-10-14T10:00:00.000Z',
    updated_at: '2026-10-14T10:00:00.000Z',
  },
  agent_slots: [],
  messages: [],
  runs: [],
  tasks: [],
  permissions: [],
  latest_sequences: {},
}

describe('Session Store 命令幂等键', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wsMocks.starts.length = 0
    wsMocks.clients.length = 0
    setActivePinia(createPinia())
    mocks.snapshot.mockResolvedValue(snapshot)
  })

  it('消息失败重试复用 request_id，成功后释放待处理键', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    mocks.sendMessage
      .mockRejectedValueOnce(new ApiClientError('未能发送', 'adapter_start_failed', 502, null))
      .mockResolvedValue({})

    await store.send('session-001', '继续工作')
    await store.send('session-001', '继续工作')
    await store.send('session-001', '继续工作')

    const requestIds = mocks.sendMessage.mock.calls.map((call) => (call[1] as { request_id: string }).request_id)
    expect(requestIds[0]).toBe(requestIds[1])
    expect(requestIds[2]).not.toBe(requestIds[1])
  })

  it('Slot 目标参与消息幂等身份并随请求发送', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    mocks.sendMessage
      .mockRejectedValueOnce(new ApiClientError('结果不确定', 'command_outcome_ambiguous', 409, null))
      .mockResolvedValue({})

    await store.send('session-001', '继续工作', false, 'slot-001')
    expect(store.requiresNewMessageConfirmation('session-001', '继续工作', 'slot-001')).toBe(true)
    expect(store.requiresNewMessageConfirmation('session-001', '继续工作', 'slot-002')).toBe(false)
    await expect(store.send('session-001', '继续工作', false, 'slot-002')).resolves.toBe(true)

    const first = mocks.sendMessage.mock.calls[0]?.[1] as { request_id: string; agent_slot_id?: string }
    const second = mocks.sendMessage.mock.calls[1]?.[1] as { request_id: string; agent_slot_id?: string }
    expect(first.agent_slot_id).toBe('slot-001')
    expect(second.agent_slot_id).toBe('slot-002')
    expect(second.request_id).not.toBe(first.request_id)
  })

  it('不同 Slot 与 Session 的待处理消息键互不覆盖', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    mocks.sendMessage.mockRejectedValue(new ApiClientError('未能发送', 'adapter_start_failed', 502, null))

    await store.send('session-001', '共用文本', false, 'slot-001')
    await store.send('session-001', '共用文本', false, 'slot-002')
    await store.send('session-001', '共用文本', false, 'slot-001')
    await store.send('session-002', '共用文本', false, 'slot-001')

    const requestIds = mocks.sendMessage.mock.calls.map((call) => (call[1] as { request_id: string }).request_id)
    expect(requestIds[2]).toBe(requestIds[0])
    expect(requestIds[1]).not.toBe(requestIds[0])
    expect(requestIds[3]).not.toBe(requestIds[0])
  })

  it('消息内容或 Session 改变时使用新 request_id', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    mocks.sendMessage
      .mockRejectedValueOnce(new ApiClientError('未能发送', 'adapter_start_failed', 502, null))
      .mockResolvedValue({})

    await store.send('session-001', '第一条消息')
    await store.send('session-001', '修改后的消息')
    await store.send('session-002', '修改后的消息')

    const requestIds = mocks.sendMessage.mock.calls.map((call) => (call[1] as { request_id: string }).request_id)
    expect(new Set(requestIds).size).toBe(3)
  })

  it('添加 AgentSlot 时只发送 RoleBinding ID 并刷新快照', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    const addedSlot = {
      id: 'slot-002',
      session_id: 'session-001',
      role_binding_id: 'binding-001',
      model_id: 'model-002',
      status: 'idle' as const,
      created_at: '2026-10-14T10:00:00.000Z',
    }
    mocks.addAgentSlot.mockResolvedValue(addedSlot)
    await store.load('session-001')

    await expect(store.addAgentSlot('session-001', 'binding-001')).resolves.toEqual(addedSlot)

    expect(mocks.addAgentSlot).toHaveBeenCalledWith('session-001', {
      role_binding_id: 'binding-001',
      request_id: expect.any(String),
    })
    expect(mocks.snapshot).toHaveBeenCalledTimes(2)
  })

  it('AgentSlot 创建失败重试复用业务 request_id，成功后释放待处理键', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    const addedSlot = {
      id: 'slot-002', session_id: 'session-001', role_binding_id: 'binding-001',
      model_id: 'model-002', status: 'idle' as const, created_at: '2026-10-14T10:00:00.000Z',
    }
    mocks.addAgentSlot
      .mockRejectedValueOnce(new ApiClientError('连接中断', 'adapter_start_failed', 502, null))
      .mockResolvedValue(addedSlot)
    await store.load('session-001')

    await store.addAgentSlot('session-001', 'binding-001')
    await expect(store.addAgentSlot('session-001', 'binding-001')).resolves.toEqual(addedSlot)
    await store.addAgentSlot('session-001', 'binding-001')

    const requestIds = mocks.addAgentSlot.mock.calls.map((call) =>
      (call[1] as { request_id: string }).request_id,
    )
    expect(requestIds[0]).toBe(requestIds[1])
    expect(requestIds[2]).not.toBe(requestIds[1])
  })

  it('删除 Slot 成功后刷新 Session 快照', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    mocks.removeAgentSlot.mockResolvedValue(null)
    await store.load('session-001')

    await expect(store.removeAgentSlot('session-001', 'slot-002')).resolves.toBe(true)

    expect(mocks.removeAgentSlot).toHaveBeenCalledWith('session-001', 'slot-002')
    expect(mocks.snapshot).toHaveBeenCalledTimes(2)
  })

  it('Run 命令失败重试复用键，且不同命令不串键', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    mocks.resume
      .mockRejectedValueOnce(new ApiClientError('未能恢复', 'adapter_start_failed', 502, null))
      .mockResolvedValue({ request_id: 'receipt', status: 'completed', run_id: 'run-001' })
    mocks.resume.mockResolvedValue({ request_id: 'receipt', status: 'completed', run_id: 'run-001' })
    mocks.retry.mockResolvedValue({ request_id: 'receipt-2', status: 'completed', run_id: 'run-002' })

    await store.command('run-001', 'resume', 'session-001')
    await store.command('run-001', 'resume', 'session-001')
    await store.command('run-001', 'retry', 'session-001')
    await store.command('run-002', 'resume', 'session-001')

    const resumeId = (mocks.resume.mock.calls[0]?.[1] as { request_id: string }).request_id
    const resumeRetryId = (mocks.resume.mock.calls[1]?.[1] as { request_id: string }).request_id
    const otherRunId = (mocks.resume.mock.calls[2]?.[1] as { request_id: string }).request_id
    const retryId = (mocks.retry.mock.calls[0]?.[1] as { request_id: string }).request_id
    expect(resumeRetryId).toBe(resumeId)
    expect(retryId).not.toBe(resumeId)
    expect(otherRunId).not.toBe(resumeId)
  })

  it('命令失败后 WebSocket 触发的快照刷新不清除错误提示', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    await store.load('session-001')
    mocks.resume.mockRejectedValueOnce(new ApiClientError('结果不确定', 'command_outcome_ambiguous', 409, null))

    await store.command('run-001', 'resume', 'session-001')
    expect(store.errorMessage).toBe('结果不确定')

    // WS 事件 / 重连触发的同一 Session 快照刷新仍更新快照，且不清空命令错误。
    const refreshed = {
      ...snapshot,
      messages: [{
        id: 'message-001',
        session_id: 'session-001',
        run_id: 'run-001',
        sender_kind: 'agent',
        sender_id: null,
        content: '新的输出',
        created_at: '2026-10-14T10:00:00.000Z',
      }],
    }
    mocks.snapshot.mockResolvedValueOnce(refreshed)
    await store.load('session-001')

    expect(store.snapshot?.messages).toHaveLength(1)
    expect(store.errorMessage).toBe('结果不确定')
  })

  it('迟到 Session 的命令失败不覆盖当前 Session 的快照与错误', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    await store.load('session-001')

    const lateResume = deferred<unknown>()
    mocks.resume.mockReturnValueOnce(lateResume.promise)
    const pending = store.command('run-001', 'resume', 'session-001')

    // 切换到 Session B 并完成加载。
    const snapshotB = {
      ...snapshot,
      session: { ...snapshot.session, id: 'session-002', name: '会话 B' },
    }
    mocks.snapshot.mockResolvedValueOnce(snapshotB)
    await store.load('session-002')
    expect(store.snapshot?.session.id).toBe('session-002')

    // Session A 的迟到失败不得覆盖 B 的快照或错误提示。
    lateResume.reject(new ApiClientError('迟到失败', 'adapter_start_failed', 502, null))
    await pending

    expect(store.snapshot?.session.id).toBe('session-002')
    expect(store.errorMessage).toBeNull()
  })

  it('迟到 Session 的命令成功不覆盖当前 Session 的快照', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    await store.load('session-001')

    const lateResume = deferred<unknown>()
    mocks.resume.mockReturnValueOnce(lateResume.promise)
    const pending = store.command('run-001', 'resume', 'session-001')

    const snapshotB = {
      ...snapshot,
      session: { ...snapshot.session, id: 'session-002', name: '会话 B' },
    }
    mocks.snapshot.mockResolvedValueOnce(snapshotB)
    await store.load('session-002')

    lateResume.resolve({ request_id: 'receipt', status: 'completed', run_id: 'run-001' })
    await pending

    expect(store.snapshot?.session.id).toBe('session-002')
    expect(store.errorMessage).toBeNull()
  })

  it('操作错误按 Session 隔离：同 Session 刷新保留，切换 Session 后清除', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    await store.load('session-001')
    mocks.resume.mockRejectedValueOnce(new ApiClientError('结果不确定', 'command_outcome_ambiguous', 409, null))

    await store.command('run-001', 'resume', 'session-001')
    expect(store.errorMessage).toBe('结果不确定')

    // 同一 Session 的 WS 快照刷新必须保留错误。
    await store.load('session-001')
    expect(store.errorMessage).toBe('结果不确定')

    // 切换到另一个 Session 后，旧 Session 的操作错误不得继续显示。
    await store.load('session-002')
    expect(store.errorMessage).toBeNull()
  })

  it('切换 Session 加载失败时清空旧快照，且不以旧快照建立连接', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    await store.load('session-001')
    expect(store.snapshot?.session.id).toBe('session-001')

    // B 的加载失败：不得继续保留 A 的快照。
    mocks.snapshot.mockRejectedValueOnce(new ApiClientError('B 加载失败', 'internal_error', 500, null))
    await store.load('session-002')

    expect(store.snapshot).toBeNull()
    expect(store.errorMessage).toBe('B 加载失败')

    // 没有 B 的快照时不得用 A 的 Workspace/Run 启动 WebSocket。
    store.connect('session-002')
    expect(wsMocks.starts).toHaveLength(0)
    expect(store.wsStatus).toBe('error')
  })

  it('旧连接的迟到事件与控制帧不得重新激活旧 Session', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    await store.load('session-001')
    store.connect('session-001')
    const sessionA = wsMocks.clients[0]
    expect(sessionA).toBeDefined()

    // B 的快照请求保持 pending。
    const loadB = deferred<unknown>()
    mocks.snapshot.mockReturnValueOnce(loadB.promise)
    const pendingB = store.load('session-002')

    // A 的旧连接在切换期间仍在：迟到回调不得再发起 load(A)。
    sessionA?.onEvent()
    sessionA?.onControl({ type: 'snapshot_required', session_id: 'session-001' })
    sessionA?.onStatus('connected')

    expect(mocks.snapshot).toHaveBeenCalledTimes(2)
    expect(store.wsStatus).toBe('idle')

    const snapshotB = {
      ...snapshot,
      session: { ...snapshot.session, id: 'session-002', workspace_id: 'workspace-002' },
    }
    loadB.resolve(snapshotB)
    await pendingB
    expect(store.snapshot?.session.id).toBe('session-002')

    // 连接 B 时使用 B 自己的 Workspace。
    store.connect('session-002')
    expect(wsMocks.starts.at(-1)?.[0]).toBe('workspace-002')
  })

  it('切换 Session 时旧连接状态重置为 idle，迟到的状态回调不覆盖', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    await store.load('session-001')
    store.connect('session-001')
    const sessionA = wsMocks.clients[0]
    sessionA?.onStatus('connected')
    expect(store.wsStatus).toBe('connected')

    // B 的加载保持 pending：期间不得继续显示 A 的连接状态。
    const loadB = deferred<unknown>()
    mocks.snapshot.mockReturnValueOnce(loadB.promise)
    const pendingB = store.load('session-002')

    expect(store.wsStatus).toBe('idle')
    sessionA?.onStatus('connected')
    expect(store.wsStatus).toBe('idle')

    loadB.resolve({ ...snapshot, session: { ...snapshot.session, id: 'session-002' } })
    await pendingB
    expect(store.snapshot?.session.id).toBe('session-002')
  })

  it('handoff 失败复用 pending key，成功后清除错误并刷新快照', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    await store.load('session-001')
    mocks.handoff
      .mockRejectedValueOnce(new ApiClientError('交接失败', 'state_conflict', 409, null))
      .mockResolvedValue({
        id: 'handoff-1', session_id: 'session-001', run_id: 'run-001', sender_kind: 'agent',
        sender_id: 'slot-1', content: '交接正文', created_at: '2026-10-14T10:00:00.000Z',
        kind: 'handoff', to_slot_id: 'slot-002',
      })

    await expect(store.handoff('session-001', 'run-001', 'slot-002')).resolves.toBeNull()
    expect(store.errorMessage).toBe('交接失败')
    const message = await store.handoff('session-001', 'run-001', 'slot-002')

    expect(message).toMatchObject({ kind: 'handoff', to_slot_id: 'slot-002' })
    const requestIds = mocks.handoff.mock.calls.map(
      (call) => (call[1] as { request_id: string }).request_id,
    )
    expect(requestIds[1]).toBe(requestIds[0])
    expect(store.errorMessage).toBeNull()
  })

  it('ambiguous 后新命令使用新键，刷新快照不覆盖错误提示', async () => {
    const { useSessionStore } = await import('./session.js')
    const store = useSessionStore()
    await store.load('session-001')
    mocks.resume
      .mockRejectedValueOnce(new ApiClientError('结果不确定', 'command_outcome_ambiguous', 409, null))
      .mockResolvedValue({ request_id: 'receipt', status: 'completed', run_id: 'run-001' })

    await store.command('run-001', 'resume', 'session-001')
    expect(store.errorMessage).toBe('结果不确定')
    await store.command('run-001', 'resume', 'session-001')

    const ambiguousId = (mocks.resume.mock.calls[0]?.[1] as { request_id: string }).request_id
    const newOperationId = (mocks.resume.mock.calls[1]?.[1] as { request_id: string }).request_id
    expect(newOperationId).not.toBe(ambiguousId)
    expect(store.errorMessage).toBeNull()
  })
})
