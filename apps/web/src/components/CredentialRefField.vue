<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { credentialEndpoints } from '@/api/endpoints.js'
import { ApiClientError } from '@/api/httpClient.js'

const props = withDefaults(defineProps<{
  /** 当前连接的凭据引用；由父级持有并随提交回填。 */
  credentialRef: string
  /** 区分同类表单实例，用于隔离 sessionStorage 中的待确认幂等键。 */
  operationScope: string
  /** 引用输入框的 DOM id；父级用它保持既有可访问性与测试锚点。 */
  inputId?: string
  /** 父级忙碌时禁用输入与按钮。 */
  disabled?: boolean
}>(), { disabled: false })
const emit = defineEmits<{ 'update:credentialRef': [value: string] }>()

const apiKey = ref('')
const errorMessage = ref<string | null>(null)
const notice = ref<string | null>(null)
const saving = ref(false)
const hasPendingOperation = ref(false)
/** 409 时服务端回传的既有引用；它不是 Secret，可用于继续配置。 */
const conflictRef = ref<string | null>(null)
/** 只保存非秘密的幂等键；Secret 永远不进入任何持久化状态。 */
let idempotencyKey: string | null = null

const idPrefix = computed(() => props.inputId
  ?? `credential-${props.operationScope.replace(/[^a-zA-Z0-9-]/g, '-')}`)
const storageKey = computed(() => `rolecast.credential.pending:${props.operationScope}`)

onMounted(() => {
  const stored = readPendingKey(storageKey.value)
  if (stored !== null) {
    idempotencyKey = stored
    hasPendingOperation.value = true
  }
})

function onRefInput(event: Event): void {
  const target = event.target
  emit('update:credentialRef', target instanceof HTMLInputElement ? target.value : '')
}

async function createCredential(): Promise<void> {
  // 提交前先取快照：成功后立即清空输入，闭包里不再引用响应式状态。
  const secret = apiKey.value
  if (secret.length === 0) {
    errorMessage.value = '请输入 API key'
    return
  }
  saving.value = true
  errorMessage.value = null
  notice.value = null
  conflictRef.value = null
  try {
    if (idempotencyKey === null) {
      idempotencyKey = crypto.randomUUID()
      writePendingKey(storageKey.value, idempotencyKey)
      hasPendingOperation.value = true
    }
    const result = await credentialEndpoints.create({
      idempotency_key: idempotencyKey,
      secret,
    })
    apiKey.value = ''
    idempotencyKey = null
    hasPendingOperation.value = false
    removePendingKey(storageKey.value)
    emit('update:credentialRef', result.credential_ref)
    notice.value = '引用已创建'
  } catch (error: unknown) {
    if (error instanceof ApiClientError && error.code === 'credential_idempotency_conflict') {
      const existing = error.details['credential_ref']
      conflictRef.value = typeof existing === 'string' && existing.length > 0 ? existing : null
      errorMessage.value = conflictRef.value === null
        ? '该次提交已用不同的 API key 创建过。请用原来的 API key 重试；清除待确认只会丢弃重试状态。'
        : '该次提交已用不同的 API key 创建过。可以继续使用已保存的引用；当前没有轮换入口，清除待确认不会删除已保存的凭据。'
    } else {
      errorMessage.value = toMessage(error)
    }
  } finally {
    saving.value = false
  }
}

/** 采用冲突时返回的既有引用，结束这次待确认操作。 */
function useExistingReference(): void {
  const reference = conflictRef.value
  if (reference === null) {
    return
  }
  apiKey.value = ''
  idempotencyKey = null
  hasPendingOperation.value = false
  conflictRef.value = null
  errorMessage.value = null
  removePendingKey(storageKey.value)
  emit('update:credentialRef', reference)
  notice.value = '已使用已保存的引用'
}

/** 放弃未确认的创建操作：只清除幂等键与输入，不动父级已有引用。 */
function clearPending(): void {
  apiKey.value = ''
  idempotencyKey = null
  hasPendingOperation.value = false
  conflictRef.value = null
  removePendingKey(storageKey.value)
  errorMessage.value = null
  notice.value = null
}

function readPendingKey(key: string): string | null {
  try {
    const value = window.sessionStorage.getItem(key)
    return value === null || value.length === 0 ? null : value
  } catch {
    return null
  }
}

function writePendingKey(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value)
  } catch {
    // 隐私模式等场景不可写；退化成本次会话内重试，不阻断创建。
  }
}

function removePendingKey(key: string): void {
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    // 忽略不可用存储；键本身不是秘密。
  }
}

function toMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'credential_invalid') {
      return 'API key 无效：不能为空、不能包含换行，且不能超过 64 KiB。'
    }
    if (error.code === 'credential_denied') {
      return '系统凭据存储拒绝了访问，请检查 Keychain 权限后重试。'
    }
    if (error.code === 'credentials_unavailable') {
      return '系统凭据存储暂时不可用，请稍后重试。'
    }
    return error.message
  }
  return '凭据保存失败'
}
</script>

<template>
  <div class="credential-field">
    <label :for="idPrefix">凭据引用 ID（非 Secret）</label>
    <input
      :id="idPrefix"
      :value="credentialRef"
      type="text"
      autocomplete="off"
      placeholder="credential-…"
      :disabled="disabled ?? false"
      @input="onRefInput"
    />

    <div class="credential-create">
      <label :for="`${idPrefix}-secret`">API key</label>
      <input
        :id="`${idPrefix}-secret`"
        v-model="apiKey"
        type="password"
        autocomplete="new-password"
        spellcheck="false"
        placeholder="仅在提交时读取，不写入页面状态"
        :disabled="disabled || saving"
      />
      <div class="row">
        <button
          class="button"
          type="button"
          :data-testid="`${idPrefix}-create`"
          :disabled="disabled || saving"
          @click="createCredential"
        >
          {{ saving ? '写入中…' : '保存到 Keychain 并生成引用' }}
        </button>
        <button
          v-if="conflictRef !== null"
          class="button"
          type="button"
          :data-testid="`${idPrefix}-use-existing`"
          @click="useExistingReference"
        >
          使用已保存的引用
        </button>
        <button
          v-if="hasPendingOperation"
          class="button"
          type="button"
          :data-testid="`${idPrefix}-clear`"
          :disabled="saving"
          @click="clearPending"
        >
          清除待确认
        </button>
      </div>
      <span v-if="hasPendingOperation" class="hint warn-text">
        上次创建结果未确认。可用同一 API key 重试；成功或清除后该记录才会消失。
      </span>
      <span v-if="notice" class="hint">{{ notice }}</span>
      <span v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</span>
    </div>
  </div>
</template>

<style scoped>
.credential-field {
  display: grid;
  gap: 8px;
}

.credential-create {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px dashed var(--border-subtle, rgba(127, 127, 127, 0.35));
  border-radius: 10px;
}

.credential-create label {
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--text-secondary, #666);
}
</style>
