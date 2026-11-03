<script setup lang="ts">
import { ref, watch } from 'vue'

import {
  isSensitiveRuntimeOptionKey,
  type CreateRoleBindingRequest,
  type ModelCatalogEntryDto,
  type ProviderConnectionDto,
  type RoleBindingDto,
  type RoleDto,
  type UpdateRoleBindingRequest,
} from '@rolecast/contract'

interface Props {
  readonly binding: RoleBindingDto | null
  readonly initialRoleId: string | null
  readonly roles: readonly RoleDto[]
  readonly providers: readonly ProviderConnectionDto[]
  readonly models: readonly ModelCatalogEntryDto[]
  readonly busy: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  save: [input: CreateRoleBindingRequest | UpdateRoleBindingRequest]
  remove: []
  providerChange: [providerId: string]
}>()

const roleId = ref('')
const providerId = ref('')
const modelId = ref('')
const runtimeOptions = ref('')
const priority = ref(0)
const enabled = ref(true)
const localError = ref<string | null>(null)

watch(() => props.binding, () => syncForm(props.binding), { immediate: true })
watch(() => props.initialRoleId, (roleIdValue) => {
  if (props.binding === null && roleIdValue !== null) {
    roleId.value = roleIdValue
  }
})
watch(() => props.roles.length, () => {
  if (props.binding === null && roleId.value.length === 0) {
    roleId.value = props.roles[0]?.id ?? ''
  }
})
watch(() => props.providers.length, () => {
  if (props.binding === null && providerId.value.length === 0) {
    providerId.value = props.providers[0]?.id ?? ''
  }
})
watch(() => props.models, () => {
  if (props.binding === null && modelId.value.length === 0) {
    modelId.value = props.models[0]?.model_id ?? ''
  }
}, { deep: true })

function handleProviderChange(): void {
  modelId.value = ''
  emit('providerChange', providerId.value)
}

function syncForm(binding: RoleBindingDto | null): void {
  roleId.value = binding?.role_id ?? props.initialRoleId ?? props.roles[0]?.id ?? ''
  providerId.value = binding?.provider_connection_id ?? props.providers[0]?.id ?? ''
  modelId.value = binding?.model_id ?? props.models[0]?.model_id ?? ''
  runtimeOptions.value = binding === null
    ? ''
    : Object.entries(binding.runtime_options).map(([key, value]) => `${key}=${formatRuntimeOptionValue(value)}`).join('\n')
  priority.value = binding?.priority ?? 0
  enabled.value = binding?.enabled ?? true
  localError.value = null
}

function submit(): void {
  localError.value = null
  const parsedOptions = parseRuntimeOptions(runtimeOptions.value)
  if (parsedOptions === null) {
    return
  }
  const fields = {
    role_id: roleId.value,
    provider_connection_id: providerId.value,
    model_id: modelId.value,
    runtime_options: parsedOptions,
    priority: priority.value,
    enabled: enabled.value,
  }
  if (props.binding === null) {
    emit('save', fields)
    return
  }
  emit('save', { ...fields, version: props.binding.version })
}

function formatRuntimeOptionValue(value: string | number | boolean): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function parseRuntimeOptions(value: string): Record<string, string | number | boolean> | null {
  const entries = value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const result: Record<string, string | number | boolean> = {}
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator <= 0) {
      localError.value = 'runtime_options 每行使用 key=value 格式。'
      return null
    }
    const key = entry.slice(0, separator).trim()
    const rawValue = entry.slice(separator + 1).trim()
    const optionValue = parseRuntimeOptionValue(rawValue)
    if (optionValue === null) {
      return null
    }
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(key) || isSensitiveRuntimeOptionKey(key)) {
      localError.value = 'runtime_options 不能包含凭据字段。'
      return null
    }
    result[key] = optionValue
  }
  return result
}

function parseRuntimeOptionValue(value: string): string | number | boolean | null {
  if (value.startsWith('"') || value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (typeof parsed === 'string') {
        return parsed
      }
    } catch {
      localError.value = 'runtime_options 的字符串值不是有效 JSON。'
      return null
    }
    localError.value = 'runtime_options 的字符串值格式无效。'
    return null
  }
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return value
}
</script>

<template>
  <section class="surface panel binding-editor" aria-labelledby="binding-editor-title">
    <div class="eyebrow">RoleBinding</div>
    <div class="row role-editor-heading">
      <div>
        <h2 id="binding-editor-title" class="section-title">{{ binding ? '编辑绑定' : '绑定运行模型' }}</h2>
        <p class="panel-subtitle">Role 描述工作方式，Binding 决定这次由哪个 Provider 和模型执行。</p>
      </div>
      <span v-if="binding" class="kicker">v{{ binding.version }}</span>
    </div>

    <form class="stack" @submit.prevent="submit">
      <div class="field-grid">
        <div class="field">
          <label for="binding-role">Role</label>
          <select id="binding-role" v-model="roleId" class="select" required>
            <option value="" disabled>选择 Role</option>
            <option v-for="role in roles" :key="role.id" :value="role.id">{{ role.name }}</option>
          </select>
        </div>
        <div class="field">
          <label for="binding-provider">ProviderConnection</label>
          <select id="binding-provider" v-model="providerId" class="select" required @change="handleProviderChange">
            <option value="" disabled>选择连接</option>
            <option v-for="provider in providers" :key="provider.id" :value="provider.id">
              {{ provider.provider_kind }} / {{ provider.connection_kind }}
            </option>
          </select>
        </div>
      </div>
      <div class="field">
        <label for="binding-model">Model</label>
        <select id="binding-model" v-model="modelId" class="select" required :disabled="models.length === 0">
          <option value="" disabled>{{ models.length === 0 ? '先发现模型' : '选择模型' }}</option>
          <option v-for="model in models" :key="model.id" :value="model.model_id">{{ model.display_name }}</option>
        </select>
        <span v-if="models.length === 0" class="muted">当前连接没有已发现模型，请先回到 Provider 页面执行发现。</span>
      </div>
      <div class="field-grid">
        <div class="field">
          <label for="binding-options">Runtime options（每行 key=value）</label>
          <textarea id="binding-options" v-model="runtimeOptions" placeholder="effort=high" />
        </div>
        <div class="field">
          <label for="binding-priority">优先级</label>
          <input id="binding-priority" v-model.number="priority" type="number" min="0" max="1000000" />
        </div>
      </div>
      <label class="checkbox-line"><input v-model="enabled" type="checkbox" /> 启用这个绑定</label>
      <span v-if="localError" class="error" role="alert">{{ localError }}</span>
      <div class="row">
        <button class="button primary" type="submit" :disabled="busy || roleId.length === 0 || providerId.length === 0 || modelId.length === 0">
          {{ busy ? '保存中…' : binding ? '保存绑定' : '建立绑定' }}
        </button>
        <button v-if="binding" class="button warn" type="button" :disabled="busy" @click="emit('remove')">删除绑定</button>
      </div>
    </form>
  </section>
</template>
