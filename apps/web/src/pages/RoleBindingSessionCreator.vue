<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import type { RoleBindingDto, RoleDto } from '@rolecast/contract'

import { bindingEndpoints, roleEndpoints } from '@/api/endpoints.js'
import { ApiClientError } from '@/api/httpClient.js'

const props = defineProps<{
  workspaceId: string
  busy: boolean
}>()

const emit = defineEmits<{
  create: [binding: RoleBindingDto, role: RoleDto]
}>()

const roles = ref<RoleDto[]>([])
const bindings = ref<RoleBindingDto[]>([])
const selectedBindingId = ref('')
const loading = ref(false)
const errorMessage = ref<string | null>(null)
let requestGeneration = 0

const availableBindings = computed(() => bindings.value.filter((binding) => {
  const role = roles.value.find((item) => item.id === binding.role_id)
  return binding.workspace_id === props.workspaceId
    && binding.enabled
    && Object.keys(binding.runtime_options).length === 0
    && role?.workspace_id === props.workspaceId
    && role.selectable
    && role.dispatchable
}))
const selectedBinding = computed(() => availableBindings.value.find(
  (binding) => binding.id === selectedBindingId.value,
) ?? null)
const canCreate = computed(() => selectedBinding.value !== null && !props.busy && !loading.value)

watch(() => props.workspaceId, () => {
  void loadBindings()
}, { immediate: true, flush: 'sync' })

onBeforeUnmount(() => {
  requestGeneration += 1
})

async function loadBindings(): Promise<void> {
  const requestedWorkspaceId = props.workspaceId
  const generation = ++requestGeneration
  selectedBindingId.value = ''
  roles.value = []
  bindings.value = []
  errorMessage.value = null
  loading.value = requestedWorkspaceId.length > 0
  if (requestedWorkspaceId.length === 0) {
    return
  }
  try {
    const [loadedRoles, loadedBindings] = await Promise.all([
      roleEndpoints.list(requestedWorkspaceId),
      bindingEndpoints.list(requestedWorkspaceId),
    ])
    if (!isCurrentRequest(requestedWorkspaceId, generation)) {
      return
    }
    roles.value = loadedRoles
    bindings.value = loadedBindings
  } catch (error: unknown) {
    if (isCurrentRequest(requestedWorkspaceId, generation)) {
      errorMessage.value = toMessage(error, 'Role 与绑定候选加载失败')
    }
  } finally {
    if (isCurrentRequest(requestedWorkspaceId, generation)) {
      loading.value = false
    }
  }
}

function isCurrentRequest(requestedWorkspaceId: string, generation: number): boolean {
  return generation === requestGeneration && requestedWorkspaceId === props.workspaceId
}

function roleBindingLabel(binding: RoleBindingDto): string {
  const role = roles.value.find((item) => item.id === binding.role_id)
  return `${role?.name ?? binding.role_id} · ${binding.provider_connection_id} / ${binding.model_id}`
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    return error.message
  }
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' && message.length > 0 ? message : fallback
  }
  return fallback
}

function createSession(): void {
  const binding = selectedBinding.value
  const role = binding === null ? undefined : roles.value.find((item) => item.id === binding.role_id)
  if (binding !== null && role !== undefined && canCreate.value) {
    emit('create', binding, role)
  }
}
</script>

<template>
  <div class="stack">
    <p class="hint">
      将使用所选 RoleBinding 中配置的 Provider 与模型，不会沿用当前选择的 Provider 或模型。
    </p>
    <p v-if="loading" class="hint" role="status" data-testid="role-binding-loading">
      正在读取当前 Workspace 的 Role 与绑定…
    </p>
    <div v-else-if="errorMessage" class="row">
      <span class="error" role="alert" data-testid="role-binding-error">{{ errorMessage }}</span>
      <button
        class="button"
        type="button"
        data-testid="retry-role-bindings"
        :disabled="loading"
        @click="loadBindings"
      >
        重试
      </button>
    </div>
    <p v-else-if="availableBindings.length === 0" class="hint" role="status" data-testid="role-binding-empty">
      当前 Workspace 没有可直接运行的 RoleBinding。请先配置已启用且不含运行时选项的绑定。
    </p>
    <div v-else class="field">
      <label for="role-binding-select">Role 与绑定的 Provider / 模型</label>
      <select
        id="role-binding-select"
        v-model="selectedBindingId"
        class="select"
        data-testid="role-binding-select"
      >
        <option value="">选择一个可用的 RoleBinding</option>
        <option v-for="binding in availableBindings" :key="binding.id" :value="binding.id">
          {{ roleBindingLabel(binding) }}
        </option>
      </select>
    </div>
    <button
      class="button primary"
      type="button"
      data-testid="start-role-session"
      :disabled="!canCreate"
      @click="createSession"
    >
      {{ props.busy ? '创建中…' : '用此 RoleBinding 开启 Session' }}
    </button>
  </div>
</template>
