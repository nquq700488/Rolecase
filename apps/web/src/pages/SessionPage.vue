<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import type { AgentSlotDto, RoleBindingDto, RoleDto } from '@rolecast/contract'

import { bindingEndpoints, roleEndpoints } from '@/api/endpoints.js'
import type { MessageDto } from '@rolecast/contract'

import PermissionCard from '@/components/PermissionCard.vue'
import { useSessionStore } from '@/stores/session.js'

const route = useRoute()
const instance = getCurrentInstance()
// 无 router 的测试环境里 useRoute() 返回 undefined，回退到注入的 $route。
const routeParams = ((route as unknown as { params?: Record<string, string> } | undefined)?.params
  ?? (instance?.proxy?.$route as unknown as { params?: Record<string, string> } | undefined)?.params
  ?? {}) as Record<string, string>
const sessionId = String(routeParams.sessionId ?? '')
const sessionStore = useSessionStore()
const draft = ref('')
const streamElement = ref<HTMLElement | null>(null)
const selectedSlotId = ref('')
const roles = ref<RoleDto[]>([])
const bindings = ref<RoleBindingDto[]>([])
const roleConfigError = ref('')
const roleConfigLoading = ref(false)
const addSlotOpen = ref(false)
const selectedRoleBindingId = ref('')
// 已加载过角色配置的 Workspace；首屏快照加载失败时用它触发补加载。
let roleOptionsWorkspaceId: string | undefined

const session = computed(() => sessionStore.snapshot?.session ?? null)
const slots = computed(() => sessionStore.snapshot?.agent_slots ?? [])
const defaultSlotId = computed(() =>
  slots.value.find((slot) => slot.role_binding_id === undefined)?.id ?? slots.value[0]?.id ?? '',
)
watch(() => slots.value.map((slot) => slot.id).join(','), () => {
  if (selectedSlotId.value.length > 0 && !slots.value.some((slot) => slot.id === selectedSlotId.value)) {
    selectedSlotId.value = defaultSlotId.value
  }
  if (selectedSlotId.value.length === 0) {
    selectedSlotId.value = defaultSlotId.value
  }
}, { immediate: true })
const messages = computed(() => sessionStore.snapshot?.messages ?? [])
const runs = computed(() => sessionStore.snapshot?.runs ?? [])
const tasks = computed(() => sessionStore.snapshot?.tasks ?? [])
const handoffTargets = ref<Record<string, string>>({})
// handoff 只投影到匹配的接收 Slot；普通消息不受 Slot 过滤。
const visibleMessages = computed(() => messages.value.filter(
  (message) => message.kind !== 'handoff' || message.to_slot_id === selectedSlotId.value,
))
const pendingPermissions = computed(() => sessionStore.pendingPermissions)
const eligibleBindings = computed(() => bindings.value.filter((binding) => {
  const role = roles.value.find((candidate) => candidate.id === binding.role_id)
  return binding.workspace_id === session.value?.workspace_id
    && binding.enabled
    && role?.selectable === true
    && role.dispatchable === true
}))
const availableBindings = computed(() => eligibleBindings.value.filter(
  (binding) => Object.keys(binding.runtime_options).length === 0,
))
const unsupportedRuntimeBindings = computed(() => eligibleBindings.value.filter(
  (binding) => Object.keys(binding.runtime_options).length > 0,
))
// 有 Binding 但被启用状态/角色可派发性排除：提示要说明原因，不能让用户以为没有配置。
const ineligibleBindingCount = computed(() => bindings.value.filter((binding) => {
  if (binding.workspace_id !== session.value?.workspace_id) {
    return false
  }
  const role = roles.value.find((candidate) => candidate.id === binding.role_id)
  return !binding.enabled || role?.selectable !== true || role.dispatchable !== true
}).length)

async function loadRoleOptions(): Promise<void> {
  const workspaceId = session.value?.workspace_id
  if (workspaceId === undefined) {
    return
  }
  roleOptionsWorkspaceId = workspaceId
  roleConfigLoading.value = true
  roleConfigError.value = ''
  try {
    const [nextRoles, nextBindings] = await Promise.all([
      roleEndpoints.list(workspaceId),
      bindingEndpoints.list(workspaceId),
    ])
    roles.value = nextRoles
    bindings.value = nextBindings
    selectedRoleBindingId.value = availableBindings.value[0]?.id ?? ''
  } catch {
    roleConfigError.value = '角色绑定加载失败，刷新后重试。'
  } finally {
    roleConfigLoading.value = false
  }
}

function roleBindingLabel(binding: RoleBindingDto): string {
  const role = roles.value.find((candidate) => candidate.id === binding.role_id)
  return `${role?.name ?? 'Agent'} (${binding.model_id})`
}

function agentSlotLabel(slot: AgentSlotDto): string {
  if (slot.role_binding_id === undefined) {
    return `默认 Agent (${slot.model_id})`
  }
  const binding = bindings.value.find((candidate) => candidate.id === slot.role_binding_id)
  const role = roles.value.find((candidate) => candidate.id === binding?.role_id)
  return `${role?.name ?? 'Agent'} (${slot.model_id})`
}

async function addAgentSlot(): Promise<void> {
  if (selectedRoleBindingId.value.length === 0 || sessionStore.addingAgentSlot) {
    return
  }
  const added = await sessionStore.addAgentSlot(sessionId, selectedRoleBindingId.value)
  if (added !== null) {
    selectedSlotId.value = added.id
    addSlotOpen.value = false
  }
}

async function deleteSelectedAgentSlot(): Promise<void> {
  const slotId = selectedSlotId.value || defaultSlotId.value
  if (
    slotId.length === 0
    || slotId === defaultSlotId.value
    || sessionStore.deletingAgentSlotId !== null
    || sessionStore.sending
  ) {
    return
  }
  if (
    typeof window === 'undefined'
    || !window.confirm('删除后该 Agent 从列表隐藏，历史记录保留。重新添加同一角色会创建新的上下文。确认删除？')
  ) {
    return
  }
  const deleted = await sessionStore.removeAgentSlot(sessionId, slotId)
  if (deleted) {
    selectedSlotId.value = defaultSlotId.value
    addSlotOpen.value = false
  }
}

onMounted(async () => {
  await sessionStore.load(sessionId)
  selectedSlotId.value = defaultSlotId.value
  sessionStore.connect(sessionId)
  await loadRoleOptions()
})

// 首次快照失败时 workspace 为空，角色配置不会被请求；快照恢复后补加载一次。
watch(() => session.value?.workspace_id, (workspaceId) => {
  if (workspaceId !== undefined && workspaceId !== roleOptionsWorkspaceId && !roleConfigLoading.value) {
    void loadRoleOptions()
  }
})

onUnmounted(() => {
  sessionStore.stop()
})

async function sendMessage(): Promise<void> {
  const content = draft.value.trim()
  const agentSlotId = selectedSlotId.value || defaultSlotId.value
  // 没有 Slot 时不能发送空目标：agent_slot_id 必须是合法标识符。
  if (content.length === 0 || sessionStore.sending || agentSlotId.length === 0) {
    return
  }
  const requiresNewRequestId = sessionStore.requiresNewMessageConfirmation(sessionId, content, agentSlotId)
  if (
    requiresNewRequestId
    && (typeof window === 'undefined'
      || !window.confirm('上次发送结果不确定。再次发送可能重复外部副作用，确定使用新的 request_id 吗？'))
  ) {
    return
  }
  const sent = await sessionStore.send(sessionId, content, requiresNewRequestId, agentSlotId)
  if (!sent) {
    return
  }
  // 发送过程包含一次快照刷新；期间用户可能已经开始输入下一条，不能清掉。
  if (draft.value.trim() === content) {
    draft.value = ''
  }
  await nextTick()
  streamElement.value?.scrollTo({ top: streamElement.value.scrollHeight, behavior: 'smooth' })
}

/**
 * resume / retry 都会重放原用户输入，可能重复已发生的外部副作用。
 * 必须在 dispatch 前二次确认；cancel 不需要。
 */
async function runCommand(runId: string, action: 'cancel' | 'resume' | 'retry'): Promise<void> {
  if (sessionStore.commanding) {
    return
  }
  if (action !== 'cancel') {
    const warning = action === 'resume'
      ? 'Resume 会重新提交该 Run 的原始用户输入，外部副作用可能重复发生。确认继续？'
      : 'Retry 会新建一次 attempt 并重放原始用户输入，外部副作用可能重复发生。确认继续？'
    if (typeof window !== 'undefined' && !window.confirm(warning)) {
      return
    }
  }
  await sessionStore.command(runId, action, sessionId)
}

function canCancel(status: string): boolean {
  return status === 'running' || status === 'waiting_user'
}

function canResume(status: string): boolean {
  return status === 'paused' || status === 'interrupted'
}

function canRetry(status: string): boolean {
  return status === 'failed' || status === 'interrupted' || status === 'cancelled'
}

function slotIdForRun(runId: string): string | undefined {
  return tasks.value.find((task) => task.run_id === runId)?.slot_id
}

function handoffTargetCandidates(runId: string) {
  const sourceSlotId = slotIdForRun(runId)
  return slots.value.filter((slot) => slot.id !== sourceSlotId)
}

async function createHandoff(runId: string): Promise<void> {
  const targetSlotId = handoffTargets.value[runId] ?? ''
  if (targetSlotId.length === 0 || sessionStore.commanding) {
    return
  }
  const message = await sessionStore.handoff(sessionId, runId, targetSlotId)
  if (message === null) {
    return
  }
  // 交接成功后切换到接收 Slot，便于用户看到来源与目标。
  selectedSlotId.value = targetSlotId
}

/** 只填入草稿，不触发发送或 Runtime dispatch。 */
function fillHandoffDraft(message: MessageDto): void {
  draft.value = message.content
  if (message.to_slot_id !== undefined) {
    selectedSlotId.value = message.to_slot_id
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}
</script>

<template>
  <main class="chat-layout">
    <aside class="chat-nav">
      <router-link class="brand" to="/"><span class="brand-mark" aria-hidden="true" /> Rolecast</router-link>
      <h1>{{ session?.name ?? '正在读取 Session…' }}</h1>
      <span class="kicker">session / agents</span>
      <hr class="rule" />
      <router-link class="muted" :to="`/`">← 返回工作区</router-link>
    </aside>

    <section class="chat-main" aria-label="Agent 对话">
      <header class="chat-header">
        <div>
          <div class="eyebrow">Runtime conversation</div>
          <h2>与 Agent 协作</h2>
        </div>
        <span class="kicker" :class="{ 'live-label': sessionStore.wsStatus === 'connected' }">
          {{ sessionStore.wsStatus === 'connected' ? '● live' : sessionStore.wsStatus }}
        </span>
      </header>

      <div ref="streamElement" class="stream" aria-live="polite">
        <div v-if="sessionStore.loading && visibleMessages.length === 0" class="empty">正在打开事件流…</div>
        <div v-else-if="!sessionStore.loading && visibleMessages.length === 0" class="empty">从一个具体问题开始。Agent 的每个输出都会留下事件记录。</div>
        <article v-for="message in visibleMessages" :key="message.id" class="message" :class="message.sender_kind">
          <div class="message-meta">
            <template v-if="message.kind === 'handoff'">handoff · {{ message.sender_id }} → {{ message.to_slot_id }} · </template>
            {{ message.sender_kind }} · {{ formatTime(message.created_at) }}
          </div>
          <div>{{ message.content }}</div>
          <button
            v-if="message.kind === 'handoff'"
            class="button"
            type="button"
            :data-testid="`fill-handoff-${message.id}`"
            @click="fillHandoffDraft(message)"
          >
            填入草稿
          </button>
        </article>
      </div>

      <div v-if="sessionStore.errorMessage" class="error" style="padding: 0 24px 12px" role="alert">{{ sessionStore.errorMessage }}</div>
      <form class="composer" @submit.prevent="sendMessage">
        <div class="composer-target">
          <div class="field target-field">
            <label for="agent-slot-target">发送给</label>
            <select id="agent-slot-target" v-model="selectedSlotId" class="select" data-testid="agent-slot-target" :disabled="sessionStore.sending || slots.length === 0">
              <option v-for="slot in slots" :key="slot.id" :value="slot.id">{{ agentSlotLabel(slot) }}</option>
            </select>
          </div>
          <button
            class="button"
            type="button"
            data-testid="open-add-agent"
            :disabled="roleConfigLoading || availableBindings.length === 0 || sessionStore.addingAgentSlot"
            @click="addSlotOpen = !addSlotOpen"
          >
            添加 Agent
          </button>
          <button
            v-if="selectedSlotId.length > 0 && selectedSlotId !== defaultSlotId"
            class="button warn"
            type="button"
            aria-label="删除所选 Agent Slot"
            data-testid="delete-agent-slot"
            :disabled="sessionStore.deletingAgentSlotId !== null || sessionStore.sending"
            @click="deleteSelectedAgentSlot"
          >
            {{ sessionStore.deletingAgentSlotId === selectedSlotId ? '删除中…' : '移除' }}
          </button>
        </div>
        <p v-if="roleConfigError" class="error slot-feedback" role="alert">{{ roleConfigError }}</p>
        <p v-else-if="!roleConfigLoading && unsupportedRuntimeBindings.length > 0" class="hint slot-feedback">
          含 runtime_options 的角色绑定暂不支持添加；清空这些选项后即可使用。
        </p>
        <p v-else-if="!roleConfigLoading && availableBindings.length === 0" class="hint slot-feedback">
          <template v-if="ineligibleBindingCount > 0">
            有 {{ ineligibleBindingCount }} 个角色绑定未启用或角色不可派发，先在工作区启用后重试。
          </template>
          <template v-else>当前没有可添加的角色绑定；先在工作区配置一个启用且可派发的 RoleBinding。</template>
        </p>
        <div v-if="addSlotOpen" class="slot-add-panel">
          <div class="field target-field">
            <label for="role-binding-select">选择角色与模型</label>
            <select id="role-binding-select" v-model="selectedRoleBindingId" class="select" data-testid="role-binding-select">
              <option v-for="binding in availableBindings" :key="binding.id" :value="binding.id">
                {{ roleBindingLabel(binding) }}
              </option>
            </select>
          </div>
          <button
            class="button primary"
            type="button"
            data-testid="confirm-add-agent"
            :disabled="sessionStore.addingAgentSlot || selectedRoleBindingId.length === 0"
            @click="addAgentSlot"
          >
            {{ sessionStore.addingAgentSlot ? '添加中…' : '添加' }}
          </button>
          <button class="button" type="button" @click="addSlotOpen = false">取消</button>
        </div>
        <textarea v-model="draft" aria-label="发送给所选 Agent 的消息" placeholder="描述你要推进的下一步…" @keydown.meta.enter.prevent="sendMessage" @keydown.ctrl.enter.prevent="sendMessage" />
        <button class="button primary" type="submit" :disabled="sessionStore.sending || slots.length === 0 || draft.trim().length === 0">{{ sessionStore.sending ? '发送中…' : '发送' }}</button>
      </form>
    </section>

    <aside class="chat-context" aria-label="运行上下文">
      <div>
        <h3>需要介入 <span v-if="pendingPermissions.length">· {{ pendingPermissions.length }}</span></h3>
        <div v-if="pendingPermissions.length === 0" class="muted">当前没有等待中的权限决定。</div>
        <PermissionCard
          v-for="request in pendingPermissions"
          :key="request.id"
          :request="request"
          @answer="(optionId) => sessionStore.answerPermission(request.id, optionId, sessionId)"
        />
      </div>
      <div>
        <h3>Runs</h3>
        <div v-if="runs.length === 0" class="muted">首条消息会创建 Run。</div>
        <div v-else class="timeline">
          <div v-for="run in runs" :key="run.id" class="timeline-item">
            <strong>{{ run.status }}</strong>
            <span>{{ run.id }} · attempt {{ run.attempt }}</span>
            <div class="row" style="margin-top: 6px">
              <button
                v-if="canCancel(run.status)"
                class="button"
                type="button"
                :data-testid="`cancel-${run.id}`"
                :disabled="sessionStore.commanding"
                @click="runCommand(run.id, 'cancel')"
              >
                取消
              </button>
              <button
                v-if="canResume(run.status)"
                class="button"
                type="button"
                :data-testid="`resume-${run.id}`"
                :disabled="sessionStore.commanding"
                @click="runCommand(run.id, 'resume')"
              >
                Resume
              </button>
              <button
                v-if="canRetry(run.status)"
                class="button"
                type="button"
                :data-testid="`retry-${run.id}`"
                :disabled="sessionStore.commanding"
                @click="runCommand(run.id, 'retry')"
              >
                Retry
              </button>
            </div>
            <div v-if="run.status === 'completed' && handoffTargetCandidates(run.id).length > 0" class="row" style="margin-top: 6px">
              <select
                v-model="handoffTargets[run.id]"
                class="select"
                :aria-label="`选择 ${run.id} 的交接目标`"
                :data-testid="`handoff-target-${run.id}`"
                :disabled="sessionStore.commanding"
              >
                <option value="">选择目标 Agent</option>
                <option v-for="slot in handoffTargetCandidates(run.id)" :key="slot.id" :value="slot.id">{{ agentSlotLabel(slot) }}</option>
              </select>
              <button
                class="button"
                type="button"
                :data-testid="`handoff-${run.id}`"
                :disabled="sessionStore.commanding || !handoffTargets[run.id]"
                @click="createHandoff(run.id)"
              >
                交接
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  </main>
</template>
