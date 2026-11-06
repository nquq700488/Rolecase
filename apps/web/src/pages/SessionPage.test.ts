// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

import { ApiClientError } from '@/api/httpClient.js'

vi.mock('vue-router', () => ({ useRoute: () => ({ params: { sessionId: 'session-001' } }) }))
import { useSessionStore } from '@/stores/session.js'

const snapshot = vi.fn()
const addAgentSlot = vi.fn()
const removeAgentSlot = vi.fn()
const sendMessage = vi.fn()
const handoff = vi.fn()
const listRoles = vi.fn()
const listBindings = vi.fn()
const artifactList = vi.fn()
const artifactContent = vi.fn()
const cancel = vi.fn()
const resume = vi.fn()
const retry = vi.fn()

vi.mock('@/api/endpoints.js', () => ({
  sessionEndpoints: {
    snapshot: (...args: unknown[]) => snapshot(...args),
    addAgentSlot: (...args: unknown[]) => addAgentSlot(...args),
    removeAgentSlot: (...args: unknown[]) => removeAgentSlot(...args),
    sendMessage: (...args: unknown[]) => sendMessage(...args),
    handoff: (...args: unknown[]) => handoff(...args),
  },
  artifactEndpoints: {
    list: (...args: unknown[]) => artifactList(...args),
    content: (...args: unknown[]) => artifactContent(...args),
  },
  roleEndpoints: { list: (...args: unknown[]) => listRoles(...args) },
  bindingEndpoints: { list: (...args: unknown[]) => listBindings(...args) },
  runEndpoints: {
    cancel: (...args: unknown[]) => cancel(...args),
    resume: (...args: unknown[]) => resume(...args),
    retry: (...args: unknown[]) => retry(...args),
  },
  permissionEndpoints: { answer: async () => undefined },
}))

vi.mock('@/api/wsClient.js', () => ({
  WsClient: class {
    start(): void {}
    stop(): void {}
    updateRuns(): void {}
  },
}))

const RouterLinkStub = defineComponent({
  name: 'RouterLink',
  props: { to: { type: [String, Object], required: false } },
  setup: (_props, { slots }) => () => h('a', slots.default?.()),
})

const baseSnapshot = (runStatus: string) => ({
  session: {
    id: 'session-001',
    workspace_id: 'workspace-001',
    name: '会话',
    status: 'active',
    created_at: '2026-10-14T10:00:00.000Z',
    updated_at: '2026-10-14T10:00:00.000Z',
  },
  agent_slots: [{
    id: 'slot-001',
    session_id: 'session-001',
    model_id: 'model-001',
    status: 'idle',
    created_at: '2026-10-14T10:00:00.000Z',
  }],
  messages: [],
  runs: [{
    id: 'run-001',
    workspace_id: 'workspace-001',
    session_id: 'session-001',
    status: runStatus,
    attempt: 1,
  }],
  tasks: [],
  permissions: [],
  latest_sequences: {},
})

const mountPage = async (pinia = createPinia()) => {
  const SessionPage = (await import('./SessionPage.vue')).default
  const wrapper = mount(SessionPage, {
    global: {
      plugins: [pinia],
      stubs: { RouterLink: RouterLinkStub },
      mocks: { $route: { params: { sessionId: 'session-001' } } },
    },
  })
  await flushPromises()
  return wrapper
}

describe('SessionPage 只读 TaskBoard', () => {
  const statuses = ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted'] as const
  const statusLabels = ['排队中', '运行中', '已暂停', '已完成', '失败', '已取消', '已中断']

  const taskFixture = (
    id: string,
    runId: string,
    status: typeof statuses[number],
    slotId = 'slot-001',
    updatedAt = '2026-10-14T10:12:00.000Z',
  ) => ({
    id,
    workspace_id: 'workspace-001',
    session_id: 'session-001',
    run_id: runId,
    slot_id: slotId,
    title: `任务 ${id}`,
    status,
    created_at: '2026-10-14T10:00:00.000Z',
    updated_at: updatedAt,
  })

  const runFixture = (id: string, attempt: number) => ({
    id,
    workspace_id: 'workspace-001',
    session_id: 'session-001',
    status: 'completed',
    attempt,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    listRoles.mockResolvedValue([])
    listBindings.mockResolvedValue([])
    artifactList.mockResolvedValue({ items: [], next_cursor: null })
    artifactContent.mockResolvedValue({ artifact_id: 'artifact-001', media_type: 'text/plain; charset=utf-8', content: '' })
    snapshot.mockResolvedValue(baseSnapshot('running'))
  })

  it('按快照顺序逐条显示七种 Task 状态、Slot、Run attempt 与更新时间', async () => {
    const updatedAt = '2026-10-14T10:12:00.000Z'
    const secondSlot = {
      id: 'slot-002',
      session_id: 'session-001',
      role_binding_id: 'binding-001',
      model_id: 'model-002',
      status: 'idle',
      created_at: '2026-10-14T10:01:00.000Z',
    }
    // 两个 Slot 的 owner 展示不同，避免实现错误地总取第一个 Slot 仍能通过。
    const tasks = statuses.map((status, index) => taskFixture(
      `task-${index}`,
      'run-001',
      status,
      index % 2 === 0 ? 'slot-001' : 'slot-002',
      updatedAt,
    ))
    snapshot.mockResolvedValue({
      ...baseSnapshot('running'),
      agent_slots: [...baseSnapshot('running').agent_slots, secondSlot],
      runs: [runFixture('run-001', 7)],
      tasks,
    })
    const wrapper = await mountPage()
    const board = wrapper.get('[data-testid="task-board"]')
    const rows = board.findAll('[data-testid^="task-row-"]')

    expect(rows.map((row) => row.attributes('data-task-id'))).toEqual(tasks.map((task) => task.id))
    rows.forEach((row, index) => {
      expect(row.text()).toContain(tasks[index]?.title)
      expect(row.text()).toContain(statusLabels[index])
      expect(row.text()).toContain(index % 2 === 0 ? '默认 Agent (model-001)' : 'Agent (model-002)')
      expect(row.text()).toContain('所属 Run：run-001')
      expect(row.text()).toContain('Run attempt 7')
      expect(row.find('time').attributes('datetime')).toBe(updatedAt)
    })
    expect(board.findAll('button, a, input, select, textarea')).toHaveLength(0)
  })

  it('按每个 Task 的 run_id 显示对应 Run 与 attempt', async () => {
    const tasks = [
      taskFixture('task-b', 'run-002', 'running'),
      taskFixture('task-a', 'run-001', 'completed'),
      taskFixture('task-c', 'run-002', 'queued'),
    ]
    snapshot.mockResolvedValue({
      ...baseSnapshot('running'),
      runs: [runFixture('run-001', 2), runFixture('run-002', 9)],
      tasks,
    })
    const wrapper = await mountPage()
    const board = wrapper.get('[data-testid="task-board"]')

    expect(board.findAll('[data-testid^="task-row-"]').map((row) => row.attributes('data-task-id')))
      .toEqual(['task-b', 'task-a', 'task-c'])
    expect(board.get('[data-testid="task-row-task-b"]').text()).toContain('所属 Run：run-002')
    expect(board.get('[data-testid="task-row-task-b"]').text()).toContain('Run attempt 9')
    expect(board.get('[data-testid="task-row-task-a"]').text()).toContain('所属 Run：run-001')
    expect(board.get('[data-testid="task-row-task-a"]').text()).toContain('Run attempt 2')
    expect(board.get('[data-testid="task-row-task-c"]').text()).toContain('Run attempt 9')
  })

  it('owner Slot 或所属 Run 缺失时显示明确 fallback', async () => {
    snapshot.mockResolvedValue({
      ...baseSnapshot('running'),
      agent_slots: [],
      runs: [],
      tasks: [taskFixture('task-orphan', 'run-missing', 'queued', 'slot-missing')],
    })
    const wrapper = await mountPage()
    const row = wrapper.get('[data-testid="task-row-task-orphan"]')

    expect(row.text()).toContain('Agent Slot 不可用（slot-missing）')
    expect(row.text()).toContain('所属 Run 不可用（run-missing）')
    expect(row.text()).not.toContain('Run attempt')
  })

  it('已加载的空列表显示 Session 级空态', async () => {
    const wrapper = await mountPage()

    expect(wrapper.get('[data-testid="task-board"]').text()).toContain('当前 Session 没有任务。')
    expect(wrapper.get('[data-testid="task-board"] [role="status"]').text()).toContain('当前 Session 没有任务。')
    expect(wrapper.text()).not.toContain('任务快照暂不可用')
  })

  it('快照加载中显示加载状态', async () => {
    snapshot.mockReturnValue(new Promise(() => undefined))
    const wrapper = await mountPage()

    expect(wrapper.get('[data-testid="task-board"]').text()).toContain('正在载入任务快照…')
  })

  it('初次快照加载失败不伪装成空态', async () => {
    snapshot.mockRejectedValue(new ApiClientError('首次快照失败', 'internal_error', 500, null))
    const wrapper = await mountPage()
    const board = wrapper.get('[data-testid="task-board"]')

    expect(board.text()).not.toContain('当前 Session 没有任务')
    expect(board.text()).toContain('任务快照暂不可用。')
    expect(wrapper.get('[role="alert"]').text()).toContain('首次快照失败')
  })

  it('同一 Session 刷新失败时保留最后可用 Task 并显示错误', async () => {
    const pinia = createPinia()
    snapshot
      .mockResolvedValueOnce({
        ...baseSnapshot('running'),
        tasks: [taskFixture('task-kept', 'run-001', 'running')],
      })
      .mockRejectedValueOnce(new ApiClientError('刷新失败', 'internal_error', 500, null))
    const wrapper = await mountPage(pinia)

    await useSessionStore(pinia).load('session-001')
    await flushPromises()

    expect(wrapper.get('[data-testid="task-row-task-kept"]').text()).toContain('任务 task-kept')
    expect(wrapper.get('[role="alert"]').text()).toContain('刷新失败')
  })

  it('切换 Session 后加载失败不残留旧 Session Task', async () => {
    const pinia = createPinia()
    snapshot.mockResolvedValueOnce({
      ...baseSnapshot('running'),
      tasks: [taskFixture('task-old-session', 'run-001', 'running')],
    })
    const wrapper = await mountPage(pinia)

    snapshot.mockRejectedValueOnce(new ApiClientError('新 Session 加载失败', 'internal_error', 500, null))
    await useSessionStore(pinia).load('session-002')
    await flushPromises()

    expect(wrapper.text()).not.toContain('task-old-session')
    expect(wrapper.get('[data-testid="task-board"]').text()).not.toContain('当前 Session 没有任务')
    expect(wrapper.get('[role="alert"]').text()).toContain('新 Session 加载失败')
  })

  it('只读 TaskBoard 挂载时不渲染操作入口或调用写接口', async () => {
    const wrapper = await mountPage()
    const board = wrapper.get('[data-testid="task-board"]')

    expect(board.findAll('button, a, input, select, textarea')).toHaveLength(0)
    expect(addAgentSlot).not.toHaveBeenCalled()
    expect(removeAgentSlot).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(handoff).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })
})

describe('SessionPage ArtifactPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listRoles.mockResolvedValue([])
    listBindings.mockResolvedValue([])
    artifactList.mockResolvedValue({ items: [], next_cursor: null })
    artifactContent.mockResolvedValue({ artifact_id: 'artifact-001', media_type: 'text/plain; charset=utf-8', content: '' })
    snapshot.mockResolvedValue(baseSnapshot('running'))
  })

  it('将 metadata-only ArtifactPanel 放在 TaskBoard 之后、Mailbox 之前', async () => {
    const wrapper = await mountPage()
    const aside = wrapper.get('.chat-context')
    const sectionOrder = Array.from(aside.element.querySelectorAll('section'))
      .map((section) => section.dataset.testid)

    expect(sectionOrder.indexOf('task-board')).toBeLessThan(sectionOrder.indexOf('artifact-panel'))
    expect(sectionOrder.indexOf('artifact-panel')).toBeLessThan(sectionOrder.indexOf('mailbox'))
    expect(artifactList).toHaveBeenCalledWith('session-001', { limit: 50 })
    expect(artifactContent).not.toHaveBeenCalled()
  })
})

describe('SessionPage Run 命令', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listRoles.mockResolvedValue([])
    listBindings.mockResolvedValue([])
    artifactList.mockResolvedValue({ items: [], next_cursor: null })
    artifactContent.mockResolvedValue({ artifact_id: 'artifact-001', media_type: 'text/plain; charset=utf-8', content: '' })
    addAgentSlot.mockResolvedValue(null)
    cancel.mockResolvedValue({ request_id: 'r', status: 'completed', run_id: 'run-001' })
    resume.mockResolvedValue({ request_id: 'r', status: 'completed', run_id: 'run-001' })
    retry.mockResolvedValue({ request_id: 'r', status: 'completed', run_id: 'run-002' })
  })

  it('running Run 只显示取消按钮', async () => {
    snapshot.mockResolvedValue(baseSnapshot('running'))
    const wrapper = await mountPage()

    expect(wrapper.find('[data-testid="cancel-run-001"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="resume-run-001"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="retry-run-001"]').exists()).toBe(false)
  })

  it('paused Run 显示 resume 与 retry 前的二次确认', async () => {
    snapshot.mockResolvedValue(baseSnapshot('paused'))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="resume-run-001"]').trigger('click')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain('外部副作用可能重复')
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume.mock.calls[0]?.[0]).toBe('run-001')
    expect(resume.mock.calls[0]?.[1]).toMatchObject({ request_id: expect.any(String) })
  })

  it('取消确认时不发送 resume 命令', async () => {
    snapshot.mockResolvedValue(baseSnapshot('interrupted'))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="resume-run-001"]').trigger('click')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
  })

  it('retry 也需要独立确认，并传入 run id', async () => {
    snapshot.mockResolvedValue(baseSnapshot('failed'))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="retry-run-001"]').trigger('click')
    await flushPromises()

    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain('Retry')
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('消息发送失败时保留草稿，重试复用键，成功后清空草稿', async () => {
    snapshot.mockResolvedValue(baseSnapshot('running'))
    sendMessage
      .mockRejectedValueOnce(new ApiClientError('消息发送失败', 'adapter_start_failed', 502, null))
      .mockResolvedValue({ run: {}, task: {} })
    const wrapper = await mountPage()
    const composer = wrapper.get('textarea')
    await composer.setValue('继续工作')

    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect((composer.element as HTMLTextAreaElement).value).toBe('继续工作')

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const firstRequest = sendMessage.mock.calls[0]?.[1] as { request_id: string }
    const retryRequest = sendMessage.mock.calls[1]?.[1] as { request_id: string }
    expect(retryRequest.request_id).toBe(firstRequest.request_id)
    expect((composer.element as HTMLTextAreaElement).value).toBe('')
  })

  it('无显式选择时把原始 Slot 设为默认目标，而非排序首项', async () => {
    const defaultSlot = baseSnapshot('running').agent_slots[0]
    const roleSlot = {
      id: 'slot-002',
      session_id: 'session-001',
      role_binding_id: 'binding-001',
      model_id: 'model-002',
      status: 'idle',
      created_at: '2026-10-13T10:00:00.000Z',
    }
    snapshot.mockResolvedValue({ ...baseSnapshot('running'), agent_slots: [roleSlot, defaultSlot] })
    const wrapper = await mountPage()

    expect((wrapper.get('[data-testid="agent-slot-target"]').element as HTMLSelectElement).value).toBe('slot-001')
  })

  it('按选择的 AgentSlot 定向发送消息', async () => {
    const secondSlot = {
      id: 'slot-002',
      session_id: 'session-001',
      role_binding_id: 'binding-001',
      model_id: 'model-002',
      status: 'idle',
      created_at: '2026-10-14T10:01:00.000Z',
    }
    snapshot.mockResolvedValue({ ...baseSnapshot('running'), agent_slots: [...baseSnapshot('running').agent_slots, secondSlot] })
    listRoles.mockResolvedValue([{ id: 'role-001', workspace_id: 'workspace-001', name: '审查者', selectable: true, dispatchable: true }])
    listBindings.mockResolvedValue([{
      id: 'binding-001',
      workspace_id: 'workspace-001',
      role_id: 'role-001',
      provider_connection_id: 'provider-001',
      model_id: 'model-002',
      runtime_options: {},
      enabled: true,
    }])
    sendMessage.mockResolvedValue({ run: {}, task: {} })
    const wrapper = await mountPage()
    await wrapper.get('[data-testid="agent-slot-target"]').setValue('slot-002')
    await wrapper.get('textarea').setValue('审查这段实现')

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(sendMessage).toHaveBeenCalledWith('session-001', expect.objectContaining({ agent_slot_id: 'slot-002' }))
  })

  it('使用现有 RoleBinding 新增 Slot 并选中它', async () => {
    const firstSnapshot = baseSnapshot('running')
    const secondSlot = {
      id: 'slot-002',
      session_id: 'session-001',
      role_binding_id: 'binding-001',
      model_id: 'model-002',
      status: 'idle',
      created_at: '2026-10-14T10:01:00.000Z',
    }
    snapshot
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce({ ...firstSnapshot, agent_slots: [...firstSnapshot.agent_slots, secondSlot] })
    listRoles.mockResolvedValue([{ id: 'role-001', workspace_id: 'workspace-001', name: '审查者', selectable: true, dispatchable: true }])
    listBindings.mockResolvedValue([{
      id: 'binding-001',
      workspace_id: 'workspace-001',
      role_id: 'role-001',
      provider_connection_id: 'provider-001',
      model_id: 'model-002',
      runtime_options: {},
      enabled: true,
    }])
    addAgentSlot.mockResolvedValue(secondSlot)
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="open-add-agent"]').trigger('click')
    await wrapper.get('[data-testid="role-binding-select"]').setValue('binding-001')
    await wrapper.get('[data-testid="confirm-add-agent"]').trigger('click')
    await flushPromises()

    expect(addAgentSlot).toHaveBeenCalledWith('session-001', {
      role_binding_id: 'binding-001',
      request_id: expect.any(String),
    })
    expect((wrapper.get('[data-testid="agent-slot-target"]').element as HTMLSelectElement).value).toBe('slot-002')
  })

  it('确认删除当前非默认 Slot 后回落到默认目标', async () => {
    const initial = baseSnapshot('completed')
    const roleSlot = {
      id: 'slot-002', session_id: 'session-001', role_binding_id: 'binding-001',
      model_id: 'model-002', status: 'idle', created_at: '2026-10-14T10:01:00.000Z',
    }
    const withRoleSlot = { ...initial, agent_slots: [...initial.agent_slots, roleSlot] }
    snapshot
      .mockResolvedValueOnce(withRoleSlot)
      .mockResolvedValueOnce({ ...withRoleSlot, agent_slots: [withRoleSlot.agent_slots[0]] })
    removeAgentSlot.mockResolvedValue(null)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="agent-slot-target"]').setValue('slot-002')
    await wrapper.get('[data-testid="delete-agent-slot"]').trigger('click')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(removeAgentSlot).toHaveBeenCalledWith('session-001', 'slot-002')
    expect((wrapper.get('[data-testid="agent-slot-target"]').element as HTMLSelectElement).value).toBe('slot-001')
  })

  it('删除请求超时但快照已移除 Slot 时仍回落到默认目标', async () => {
    const base = baseSnapshot('completed')
    const roleSlot = {
      id: 'slot-002', session_id: 'session-001', role_binding_id: 'binding-001',
      model_id: 'model-002', status: 'idle', created_at: '2026-10-14T10:01:00.000Z',
    }
    const withRoleSlot = { ...base, agent_slots: [...base.agent_slots, roleSlot] }
    snapshot
      .mockResolvedValueOnce(withRoleSlot)
      .mockResolvedValueOnce({ ...withRoleSlot, agent_slots: [withRoleSlot.agent_slots[0]] })
    removeAgentSlot.mockRejectedValue(new ApiClientError('响应超时', 'adapter_start_failed', 502, null))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = await mountPage()
    await wrapper.get('[data-testid="agent-slot-target"]').setValue('slot-002')

    await wrapper.get('[data-testid="delete-agent-slot"]').trigger('click')
    await flushPromises()

    expect((wrapper.get('[data-testid="agent-slot-target"]').element as HTMLSelectElement).value).toBe('slot-001')
  })

  it('提示 runtime_options 非空的 RoleBinding 暂不可添加', async () => {
    snapshot.mockResolvedValue(baseSnapshot('running'))
    listRoles.mockResolvedValue([{ id: 'role-001', workspace_id: 'workspace-001', name: '审查者', selectable: true, dispatchable: true }])
    listBindings.mockResolvedValue([{
      id: 'binding-001',
      workspace_id: 'workspace-001',
      role_id: 'role-001',
      provider_connection_id: 'provider-001',
      model_id: 'model-002',
      runtime_options: { effort: 'high' },
      enabled: true,
    }])
    const wrapper = await mountPage()

    expect(wrapper.get('[data-testid="open-add-agent"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('runtime_options')
  })

  it('ambiguous 消息取消确认不重发，确认后才使用新 request_id', async () => {
    snapshot.mockResolvedValue(baseSnapshot('running'))
    sendMessage
      .mockRejectedValueOnce(new ApiClientError('结果不确定', 'command_outcome_ambiguous', 409, null))
      .mockResolvedValue({ run: {}, task: {} })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const wrapper = await mountPage()
    const composer = wrapper.get('textarea')
    await composer.setValue('继续工作')

    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect((composer.element as HTMLTextAreaElement).value).toBe('继续工作')

    confirmSpy.mockReturnValue(true)
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain('结果不确定')
    const firstRequest = sendMessage.mock.calls[0]?.[1] as { request_id: string }
    const newRequest = sendMessage.mock.calls[1]?.[1] as { request_id: string }
    expect(newRequest.request_id).not.toBe(firstRequest.request_id)
  })

  it('ambiguous Run 命令在现有确认后使用新键并保留错误', async () => {
    snapshot.mockResolvedValue(baseSnapshot('interrupted'))
    resume
      .mockRejectedValueOnce(new ApiClientError('结果不确定', 'command_outcome_ambiguous', 409, null))
      .mockResolvedValue({ request_id: 'receipt', status: 'completed', run_id: 'run-001' })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="resume-run-001"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('结果不确定')
    await wrapper.get('[data-testid="resume-run-001"]').trigger('click')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalledTimes(2)
    const firstRequest = resume.mock.calls[0]?.[1] as { request_id: string }
    const newRequest = resume.mock.calls[1]?.[1] as { request_id: string }
    expect(newRequest.request_id).not.toBe(firstRequest.request_id)
  })

  it('ambiguous 命令后的快照刷新仍显示错误提示', async () => {
    snapshot.mockResolvedValue(baseSnapshot('interrupted'))
    resume.mockRejectedValueOnce(new ApiClientError('结果不确定', 'command_outcome_ambiguous', 409, null))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pinia = createPinia()
    const wrapper = await mountPage(pinia)

    await wrapper.get('[data-testid="resume-run-001"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('结果不确定')

    // 模拟 WebSocket 事件触发的同一 Session 快照刷新。
    const pageSessionId = String(snapshot.mock.calls[0]?.[0] ?? '')
    await useSessionStore(pinia).load(pageSessionId)
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('结果不确定')
  })

  it('切换到新 Session 加载失败时不显示旧 Session 数据', async () => {
    const snapshotA = {
      ...baseSnapshot('running'),
      messages: [{
        id: 'message-a',
        session_id: 'session-001',
        run_id: 'run-001',
        sender_kind: 'agent',
        sender_id: null,
        content: 'Session A 的旧输出',
        created_at: '2026-10-14T10:00:00.000Z',
      }],
    }
    snapshot.mockResolvedValueOnce(snapshotA)
    const pinia = createPinia()
    const wrapper = await mountPage(pinia)
    expect(wrapper.text()).toContain('Session A 的旧输出')
    expect(wrapper.text()).toContain('run-001')

    snapshot.mockRejectedValueOnce(new ApiClientError('B 加载失败', 'internal_error', 500, null))
    await useSessionStore(pinia).load('session-002')
    await flushPromises()

    // 新 Session 加载失败：旧 Session 的消息与 Run 都不得继续显示。
    expect(wrapper.text()).not.toContain('Session A 的旧输出')
    expect(wrapper.text()).not.toContain('run-001')
    expect(wrapper.get('[role="alert"]').text()).toContain('B 加载失败')
  })

  it('handoff 只投影到目标 Slot，填入草稿不发送', async () => {
    const timestamp = '2026-10-14T10:00:00.000Z'
    const handoffMessage = {
      id: 'm-handoff', session_id: 'session-001', run_id: 'run-001', sender_kind: 'agent',
      sender_id: 'slot-001', content: '交接正文', created_at: timestamp,
      kind: 'handoff', to_slot_id: 'slot-002',
    }
    snapshot.mockResolvedValue({
      ...baseSnapshot('completed'),
      agent_slots: [
        { id: 'slot-001', session_id: 'session-001', model_id: 'm-a', status: 'idle', created_at: timestamp },
        { id: 'slot-002', session_id: 'session-001', model_id: 'm-b', status: 'idle', created_at: timestamp },
      ],
      tasks: [{
        id: 'task-001', workspace_id: 'workspace-001', session_id: 'session-001', run_id: 'run-001',
        slot_id: 'slot-001', title: 't', status: 'completed', created_at: timestamp, updated_at: timestamp,
      }],
      messages: [
        {
          id: 'm-normal', session_id: 'session-001', run_id: 'run-001', sender_kind: 'agent',
          sender_id: 'slot-001', content: '普通回复', created_at: timestamp,
        },
        handoffMessage,
      ],
    })
    handoff.mockResolvedValue(handoffMessage)
    const wrapper = await mountPage()

    // 当前 Slot（slot-001）看不到发给 slot-002 的 handoff。
    expect(wrapper.text()).toContain('普通回复')
    expect(wrapper.text()).not.toContain('交接正文')

    await wrapper.get('[data-testid="agent-slot-target"]').setValue('slot-002')
    expect(wrapper.text()).toContain('交接正文')

    await wrapper.get('[data-testid="fill-handoff-m-handoff"]').trigger('click')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('交接正文')
    expect(sendMessage).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="handoff-target-run-001"]').setValue('slot-002')
    await wrapper.get('[data-testid="handoff-run-001"]').trigger('click')
    await flushPromises()

    expect(handoff).toHaveBeenCalledWith('session-001', {
      source_run_id: 'run-001',
      target_slot_id: 'slot-002',
      request_id: expect.any(String),
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('cancel 不需要确认', async () => {
    snapshot.mockResolvedValue(baseSnapshot('running'))
    const confirmSpy = vi.spyOn(window, 'confirm')
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="cancel-run-001"]').trigger('click')
    await flushPromises()

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
