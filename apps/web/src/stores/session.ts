import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { AgentSlotDto, MessageDto, SessionSnapshotDto } from '@rolecast/contract'

import { permissionEndpoints, runEndpoints, sessionEndpoints } from '@/api/endpoints.js'
import { ApiClientError } from '@/api/httpClient.js'
import { WsClient, type WsStatus } from '@/api/wsClient.js'

/** Session Chat 的服务器快照和实时连接状态。 */
export const useSessionStore = defineStore('session', () => {
  const snapshot = ref<SessionSnapshotDto | null>(null)
  const loading = ref(false)
  const sending = ref(false)
  const addingAgentSlot = ref(false)
  const deletingAgentSlotId = ref<string | null>(null)
  const commanding = ref(false)
  // 命令/消息等用户操作错误与快照加载错误分开保存：后台 WS 触发的 load()
  // 只能清除加载错误，不能清掉尚未解除的操作错误。
  const actionError = ref<string | null>(null)
  // 操作错误只属于产生它的 Session；切换 Session 时不能继续显示。
  const actionErrorSessionId = ref<string | null>(null)
  const loadError = ref<string | null>(null)
  const errorMessage = computed(() => actionError.value ?? loadError.value)
  const wsStatus = ref<WsStatus>('idle')
  // 当前页面 Session。只有它的请求可以更新 snapshot / loadError / actionError。
  const activeSessionId = ref<string | null>(null)
  let loadGeneration = 0
  let connectionGeneration = 0
  let wsClient: WsClient | null = null
  // 待处理消息键按 Session + Slot + 内容分别保留：只存一个会让跨 Slot/Session 的
  // 失败互相覆盖，退回新 request_id 后重复投递同一条不确定命令。
  const pendingMessageRequests = new Map<string, {
    requestId: string
    ambiguous: boolean
  }>()
  const pendingAgentSlotRequests = new Map<string, string>()
  const pendingCommandRequests = new Map<string, { requestId: string; ambiguous: boolean }>()

  const pendingPermissions = computed(() => snapshot.value?.permissions.filter((item) => item.status === 'pending') ?? [])

  function clearActionError(): void {
    actionError.value = null
    actionErrorSessionId.value = null
  }

  function setActionError(sessionId: string, message: string): void {
    actionError.value = message
    actionErrorSessionId.value = sessionId
  }

  /** 只有当前 Session 的最新一次 load 才能写共享状态。 */
  function isCurrentLoad(sessionId: string, generation: number): boolean {
    return generation === loadGeneration && activeSessionId.value === sessionId
  }

  /** 让当前 WS 连接及其回调立即失效（切换 Session / 卸载页面）。 */
  function invalidateConnection(): void {
    connectionGeneration += 1
    wsClient?.stop()
    wsClient = null
    // 旧连接的 connected/error 状态不再代表当前页面。
    wsStatus.value = 'idle'
  }

  async function load(sessionId: string): Promise<void> {
    const generation = ++loadGeneration
    if (activeSessionId.value !== sessionId) {
      // 切换 Session：旧连接立即失效，且旧快照不再属于当前页面
      //（即便新加载失败也不能回落到旧数据）。
      invalidateConnection()
      snapshot.value = null
    }
    activeSessionId.value = sessionId
    // 快照刷新可能来自另一个 Session（页面切换 / WS）；旧操作错误随旧 Session 失效。
    if (actionErrorSessionId.value !== null && actionErrorSessionId.value !== sessionId) {
      clearActionError()
    }
    loading.value = true
    loadError.value = null
    try {
      const next = await sessionEndpoints.snapshot(sessionId)
      // 迟到的旧 Session 响应不得覆盖当前 Session 的快照。
      if (!isCurrentLoad(sessionId, generation)) {
        return
      }
      snapshot.value = next
    } catch (error: unknown) {
      if (!isCurrentLoad(sessionId, generation)) {
        return
      }
      loadError.value = error instanceof ApiClientError ? error.message : 'Session 加载失败'
    } finally {
      if (isCurrentLoad(sessionId, generation)) {
        loading.value = false
      }
    }
  }

  function connect(sessionId: string): void {
    // 复用同一失效路径：重建连接前清除旧连接及其状态。
    invalidateConnection()
    const generation = connectionGeneration
    // 旧连接的回调必须同时满足「连接代际仍是当前」与「Session 仍是 active」，
    // 否则迟到事件会重新激活旧 Session。
    const isCurrentConnection = (): boolean =>
      generation === connectionGeneration && activeSessionId.value === sessionId
    wsClient = new WsClient(
      () => {
        if (isCurrentConnection()) {
          void load(sessionId)
        }
      },
      (control) => {
        if (!isCurrentConnection()) {
          return
        }
        if (control.type === 'authenticated') {
          void load(sessionId)
        }
        // 控制帧的目标必须是本连接所属 Session。
        if (control.type === 'snapshot_required' && control.session_id === sessionId) {
          void load(control.session_id)
        }
      },
      (status) => {
        if (isCurrentConnection()) {
          wsStatus.value = status
        }
      },
    )
    const currentSnapshot = snapshot.value
    // 只允许订阅目标 Session 自己的快照，避免用旧 Session 的 Workspace 启动连接。
    if (currentSnapshot === null || currentSnapshot.session.id !== sessionId) {
      wsStatus.value = 'error'
      return
    }
    const runs = currentSnapshot.runs.map((run) => ({
      run_id: run.id,
      last_sequence: currentSnapshot.latest_sequences[run.id] ?? 0,
    }))
    wsClient.start(currentSnapshot.session.workspace_id, runs)
  }

  /** 待处理消息键：同 Session、同目标 Slot、同文本才算同一次操作。 */
  function messageKey(sessionId: string, content: string, agentSlotId?: string): string {
    return JSON.stringify([sessionId, agentSlotId ?? '', content])
  }

  function requiresNewMessageConfirmation(sessionId: string, content: string, agentSlotId?: string): boolean {
    return pendingMessageRequests.get(messageKey(sessionId, content, agentSlotId))?.ambiguous === true
  }

  async function send(
    sessionId: string,
    content: string,
    useNewRequestId = false,
    agentSlotId?: string,
  ): Promise<boolean> {
    if (sending.value) {
      return false
    }
    const key = messageKey(sessionId, content, agentSlotId)
    const previous = pendingMessageRequests.get(key)
    if (previous?.ambiguous === true && !useNewRequestId) {
      setActionError(sessionId, '该命令结果不确定，请确认后使用新的 request_id 再发送')
      return false
    }
    const request = {
      key,
      requestId: previous !== undefined && !useNewRequestId ? previous.requestId : crypto.randomUUID(),
      ambiguous: false,
    }
    pendingMessageRequests.set(key, request)
    sending.value = true
    if (activeSessionId.value === sessionId) {
      clearActionError()
    }
    try {
      await sessionEndpoints.sendMessage(sessionId, {
        content,
        request_id: request.requestId,
        ...(agentSlotId === undefined ? {} : { agent_slot_id: agentSlotId }),
      })
      if (pendingMessageRequests.get(key) === request) {
        pendingMessageRequests.delete(key)
      }
      // 页面已切到其他 Session：不刷新、不覆盖其快照。
      if (activeSessionId.value === sessionId) {
        await load(sessionId)
        wsClient?.updateRuns(snapshot.value?.runs.map((run) => ({
          run_id: run.id,
          last_sequence: snapshot.value?.latest_sequences[run.id] ?? 0,
        })) ?? [])
      }
      return true
    } catch (error: unknown) {
      if (pendingMessageRequests.get(key) === request) {
        pendingMessageRequests.set(key, {
          ...request,
          ambiguous: error instanceof ApiClientError && error.code === 'command_outcome_ambiguous',
        })
      }
      if (activeSessionId.value === sessionId) {
        setActionError(sessionId, error instanceof ApiClientError ? error.message : '消息发送失败')
      }
      return false
    } finally {
      sending.value = false
    }
  }

  async function addAgentSlot(sessionId: string, roleBindingId: string): Promise<AgentSlotDto | null> {
    if (addingAgentSlot.value) {
      return null
    }
    const key = JSON.stringify([sessionId, roleBindingId])
    const requestId = pendingAgentSlotRequests.get(key) ?? crypto.randomUUID()
    pendingAgentSlotRequests.set(key, requestId)
    addingAgentSlot.value = true
    if (activeSessionId.value === sessionId) {
      clearActionError()
    }
    try {
      const slot = await sessionEndpoints.addAgentSlot(sessionId, {
        role_binding_id: roleBindingId,
        request_id: requestId,
      })
      if (pendingAgentSlotRequests.get(key) === requestId) {
        pendingAgentSlotRequests.delete(key)
      }
      if (activeSessionId.value === sessionId) {
        await load(sessionId)
      }
      return slot
    } catch (error: unknown) {
      if (activeSessionId.value === sessionId) {
        setActionError(sessionId, error instanceof ApiClientError ? error.message : 'Agent Slot 创建失败')
        await load(sessionId).catch(() => undefined)
      }
      return null
    } finally {
      addingAgentSlot.value = false
    }
  }

  async function removeAgentSlot(sessionId: string, slotId: string): Promise<boolean> {
    if (deletingAgentSlotId.value !== null) {
      return false
    }
    deletingAgentSlotId.value = slotId
    if (activeSessionId.value === sessionId) {
      clearActionError()
    }
    try {
      await sessionEndpoints.removeAgentSlot(sessionId, slotId)
      if (activeSessionId.value === sessionId) {
        await load(sessionId)
      }
      return true
    } catch (error: unknown) {
      if (activeSessionId.value === sessionId) {
        setActionError(sessionId, error instanceof ApiClientError ? error.message : 'Agent Slot 删除失败')
        await load(sessionId).catch(() => undefined)
      }
      return false
    } finally {
      deletingAgentSlotId.value = null
    }
  }

  /**
   * 执行 Run 命令。resume / retry 会重放原用户输入，可能重复外部副作用，
   * 调用方必须先做二次确认。
   */
  async function command(runId: string, action: 'cancel' | 'resume' | 'retry', sessionId: string): Promise<void> {
    if (commanding.value) {
      return
    }
    const key = JSON.stringify([sessionId, runId, action])
    const previous = pendingCommandRequests.get(key)
    const requestId = previous === undefined || previous.ambiguous ? crypto.randomUUID() : previous.requestId
    pendingCommandRequests.set(key, { requestId, ambiguous: false })
    commanding.value = true
    if (activeSessionId.value === sessionId) {
      clearActionError()
    }
    try {
      const request = { request_id: requestId }
      if (action === 'cancel') {
        await runEndpoints.cancel(runId, request)
      } else if (action === 'resume') {
        await runEndpoints.resume(runId, request)
      } else {
        await runEndpoints.retry(runId, request)
      }
      pendingCommandRequests.delete(key)
      if (activeSessionId.value === sessionId) {
        await load(sessionId)
      }
    } catch (error: unknown) {
      const commandError = error instanceof ApiClientError ? error.message : 'Run 命令失败'
      pendingCommandRequests.set(key, {
        requestId,
        ambiguous: error instanceof ApiClientError && error.code === 'command_outcome_ambiguous',
      })
      // 迟到的跨 Session 结果：不刷新、不写错误。
      if (activeSessionId.value !== sessionId) {
        return
      }
      // 冲突或状态变化后以服务器快照为准。
      await load(sessionId)
      // 刷新期间页面可能已切走：写错误前再确认一次。
      if (activeSessionId.value === sessionId) {
        setActionError(sessionId, commandError)
      }
    } finally {
      commanding.value = false
    }
  }

  /** 从已完成 Run 创建定向 handoff；失败复用 pending key，成功后刷新快照。 */
  async function handoff(
    sessionId: string,
    sourceRunId: string,
    targetSlotId: string,
  ): Promise<MessageDto | null> {
    if (commanding.value) {
      return null
    }
    const key = JSON.stringify([sessionId, sourceRunId, 'handoff', targetSlotId])
    const previous = pendingCommandRequests.get(key)
    const requestId = previous === undefined || previous.ambiguous ? crypto.randomUUID() : previous.requestId
    pendingCommandRequests.set(key, { requestId, ambiguous: false })
    commanding.value = true
    if (activeSessionId.value === sessionId) {
      clearActionError()
    }
    try {
      const message = await sessionEndpoints.handoff(sessionId, {
        source_run_id: sourceRunId,
        target_slot_id: targetSlotId,
        request_id: requestId,
      })
      pendingCommandRequests.delete(key)
      if (activeSessionId.value === sessionId) {
        await load(sessionId)
      }
      return message
    } catch (error: unknown) {
      pendingCommandRequests.set(key, {
        requestId,
        ambiguous: error instanceof ApiClientError && error.code === 'command_outcome_ambiguous',
      })
      if (activeSessionId.value === sessionId) {
        await load(sessionId)
        if (activeSessionId.value === sessionId) {
          setActionError(sessionId, error instanceof ApiClientError ? error.message : '交接失败')
        }
      }
      return null
    } finally {
      commanding.value = false
    }
  }

  async function answerPermission(requestId: string, optionId: string, sessionId: string): Promise<void> {
    if (activeSessionId.value === sessionId) {
      clearActionError()
    }
    try {
      await permissionEndpoints.answer(requestId, optionId)
      if (activeSessionId.value === sessionId) {
        await load(sessionId)
      }
    } catch (error: unknown) {
      if (activeSessionId.value === sessionId) {
        setActionError(sessionId, error instanceof ApiClientError ? error.message : '权限回答失败')
      }
    }
  }

  function stop(): void {
    invalidateConnection()
  }

  return {
    snapshot,
    loading,
    sending,
    addingAgentSlot,
    deletingAgentSlotId,
    commanding,
    errorMessage,
    wsStatus,
    pendingPermissions,
    load,
    connect,
    send,
    addAgentSlot,
    removeAgentSlot,
    requiresNewMessageConfirmation,
    answerPermission,
    command,
    handoff,
    stop,
  }
})
