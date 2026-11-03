<script setup lang="ts">
import { ref, watch } from 'vue'

import type { CreateRoleRequest, RoleDto, UpdateRoleRequest } from '@rolecast/contract'

interface Props {
  readonly role: RoleDto | null
  readonly busy: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  save: [input: CreateRoleRequest | UpdateRoleRequest]
  remove: []
}>()

const name = ref('')
const description = ref('')
const systemPrompt = ref('')
const requiredGuidelines = ref('')
const gates = ref('')
const outputContract = ref('')
const blockingConditions = ref('')
const selectable = ref(true)
const dispatchable = ref(false)

watch(() => props.role, syncForm, { immediate: true })

function syncForm(role: RoleDto | null): void {
  name.value = role?.name ?? ''
  description.value = role?.description ?? ''
  systemPrompt.value = role?.system_prompt ?? ''
  requiredGuidelines.value = role?.required_guidelines.join('\n') ?? ''
  gates.value = role?.gates.join('\n') ?? ''
  outputContract.value = role?.output_contract ?? ''
  blockingConditions.value = role?.blocking_conditions.join('\n') ?? ''
  selectable.value = role?.selectable ?? true
  dispatchable.value = role?.dispatchable ?? false
}

function submit(): void {
  const fields = {
    name: name.value,
    description: description.value,
    system_prompt: systemPrompt.value,
    required_guidelines: parseLines(requiredGuidelines.value),
    gates: parseLines(gates.value),
    output_contract: outputContract.value,
    blocking_conditions: parseLines(blockingConditions.value),
    selectable: selectable.value,
    dispatchable: dispatchable.value,
  }
  if (props.role === null) {
    emit('save', fields)
    return
  }
  emit('save', { ...fields, version: props.role.version })
}

function parseLines(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter((item) => item.length > 0)
}
</script>

<template>
  <section class="surface panel role-editor" aria-labelledby="role-editor-title">
    <div class="eyebrow">Role definition</div>
    <div class="row role-editor-heading">
      <div>
        <h2 id="role-editor-title" class="section-title">{{ role ? '编辑角色' : '建立角色' }}</h2>
        <p class="panel-subtitle">把工作方式写成可复用的约束，不在这里绑定具体 Provider。</p>
      </div>
      <span v-if="role" class="kicker">v{{ role.version }}</span>
    </div>

    <form class="stack" @submit.prevent="submit">
      <div class="field">
        <label for="role-name">角色名称</label>
        <input id="role-name" v-model="name" required maxlength="120" placeholder="例如：执行者" />
      </div>
      <div class="field">
        <label for="role-description">说明</label>
        <textarea id="role-description" v-model="description" maxlength="2000" placeholder="这个角色负责什么？" />
      </div>
      <div class="field">
        <label for="role-system-prompt">系统提示</label>
        <textarea id="role-system-prompt" v-model="systemPrompt" maxlength="20000" placeholder="只写角色行为，不写凭据。" />
      </div>
      <div class="field-grid">
        <div class="field">
          <label for="role-guidelines">必要准则（每行一条）</label>
          <textarea id="role-guidelines" v-model="requiredGuidelines" placeholder="先读后写&#10;给出验证证据" />
        </div>
        <div class="field">
          <label for="role-gates">门禁标识（每行一条）</label>
          <textarea id="role-gates" v-model="gates" placeholder="tests_passed" />
        </div>
      </div>
      <div class="field-grid">
        <div class="field">
          <label for="role-output">输出契约</label>
          <textarea id="role-output" v-model="outputContract" placeholder="说明交付格式。" />
        </div>
        <div class="field">
          <label for="role-blocking">阻断条件（每行一条）</label>
          <textarea id="role-blocking" v-model="blockingConditions" placeholder="没有测试证据" />
        </div>
      </div>
      <div class="toggle-row">
        <label><input v-model="selectable" type="checkbox" /> 可被选择</label>
        <label><input v-model="dispatchable" type="checkbox" /> 可被派发</label>
      </div>
      <div class="row">
        <button class="button primary" type="submit" :disabled="busy || name.trim().length === 0">
          {{ busy ? '保存中…' : role ? '保存角色' : '建立角色' }}
        </button>
        <button v-if="role" class="button warn" type="button" :disabled="busy" @click="emit('remove')">删除角色</button>
      </div>
    </form>
  </section>
</template>
