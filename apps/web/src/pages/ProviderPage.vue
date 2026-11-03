<script setup lang="ts">
import { computed, getCurrentInstance, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import type {
  CodexConfigImportPreview,
  CreateProviderConnectionRequest,
  ModelCatalogEntryDto,
  ProviderConnectionDto,
  RoleBindingDto,
  RoleDto,
} from '@rolecast/contract'

import { providerEndpoints, sessionEndpoints } from '@/api/endpoints.js'
import { ApiClientError } from '@/api/httpClient.js'
import CredentialRefField from '@/components/CredentialRefField.vue'
import RoleBindingSessionCreator from './RoleBindingSessionCreator.vue'
import SessionList from '@/components/SessionList.vue'
import { canRunProvider, resolveProviderReadiness, showsCodexImportPanel } from './provider-readiness.js'

type ProviderKind = 'claude' | 'codex'
type ConnectionKind = 'local' | 'api_key' | 'custom_endpoint'
type EnvironmentMode = 'inherited' | 'isolated'

const route = useRoute()
const router = useRouter()
const instance = getCurrentInstance()
// 测试环境未提供 useRoute 时，读取实例当前注入的 $route，避免捕获旧路由参数。
const workspaceId = computed(() => String(
  (route as unknown as { params?: Record<string, string> } | undefined)?.params?.workspaceId
    ?? (instance?.proxy?.$route as unknown as { params?: Record<string, string> } | undefined)?.params?.workspaceId
    ?? '',
))
const sessionWorkspaceId = workspaceId

const providers = ref<ProviderConnectionDto[]>([])
const models = ref<ModelCatalogEntryDto[]>([])
const sessionCreationMode = ref<'provider' | 'role-binding'>('provider')
/** 模型请求代际；每次目录失效或重新加载时递增。 */
let modelsGeneration = 0
let providersGeneration = 0
const providerKind = ref<ProviderKind>('claude')
const connectionKind = ref<ConnectionKind>('local')
const environmentMode = ref<EnvironmentMode>('inherited')
const baseUrl = ref('')
const credentialRef = ref('')

const selectedModel = ref('')
const statusMessage = ref('等待连接')
const errorMessage = ref<string | null>(null)
const busy = ref(false)
const connectionId = ref<string | null>(null)

const importSourcePath = ref('')
const importCredentialRef = ref('')
const importPreview = ref<CodexConfigImportPreview | null>(null)
const importError = ref<string | null>(null)
const importBusy = ref(false)

// 修正当前连接的非秘密字段：不接收 Secret，只接受既有 credential_ref。
const editing = ref(false)
const editConnectionKind = ref<ConnectionKind>('local')
const editEnvironmentMode = ref<EnvironmentMode>('inherited')
const editBaseUrl = ref('')
const editCredentialRef = ref('')
const editError = ref<string | null>(null)
const editBusy = ref(false)

const activeProvider = computed(() => providers.value.find((provider) => provider.id === connectionId.value) ?? null)
/** 引用状态从当前连接派生，切换 Provider 时不会残留上一条的状态。 */
const credentialRefSet = computed(() => activeProvider.value?.credential_ref ?? null)
const readiness = computed(() => (activeProvider.value === null ? null : resolveProviderReadiness(activeProvider.value)))
const isRunnable = computed(() => activeProvider.value !== null && canRunProvider(activeProvider.value))
const showsImport = computed(() => activeProvider.value !== null && showsCodexImportPanel(activeProvider.value))
const needsCredentialRef = computed(() => environmentMode.value === 'isolated' && connectionKind.value !== 'local')
/** 切换连接类型时清掉隐藏字段，避免把用户已看不到的值提交上去。 */
watch(connectionKind, () => {
  if (connectionKind.value !== 'custom_endpoint') {
    baseUrl.value = ''
  }
})
const canStartProviderSession = computed(() => isRunnable.value
  && selectedModel.value.length > 0
  && !busy.value)
const editNeedsCredentialRef = computed(() => editEnvironmentMode.value === 'isolated'
  && editConnectionKind.value !== 'local')

onMounted(() => {
  void loadProviders()
})

watch(workspaceId, (currentWorkspaceId, previousWorkspaceId) => {
  if (currentWorkspaceId === previousWorkspaceId) {
    return
  }
  errorMessage.value = null
  void loadProviders()
})

async function loadProviders(): Promise<void> {
  const requestedWorkspaceId = workspaceId.value
  const generation = ++providersGeneration
  providers.value = []
  connectionId.value = null
  invalidateModels()
  statusMessage.value = '等待连接'
  try {
    const loadedProviders = await providerEndpoints.list(requestedWorkspaceId)
    if (generation !== providersGeneration || requestedWorkspaceId !== workspaceId.value) {
      return
    }
    providers.value = loadedProviders
    const first = loadedProviders[0]
    if (first !== undefined) {
      connectionId.value = first.id
      await loadModels(first.id)
    }
  } catch (error: unknown) {
    if (generation === providersGeneration && requestedWorkspaceId === workspaceId.value) {
      errorMessage.value = toMessage(error, 'Provider 列表加载失败')
    }
  }
}

async function createConnection(): Promise<void> {
  const requestedWorkspaceId = workspaceId.value
  busy.value = true
  errorMessage.value = null
  try {
    // 只提交非秘密字段；credential_ref 是不透明引用，不是 Secret。
    const input: CreateProviderConnectionRequest = {
      provider_kind: providerKind.value,
      connection_kind: connectionKind.value,
      environment_mode: environmentMode.value,
      // 隐藏字段不提交：只有 custom_endpoint 才携带 URL，避免切换类型后残留值。
      ...(connectionKind.value === 'custom_endpoint' && baseUrl.value.trim().length > 0
        ? { base_url: baseUrl.value.trim() }
        : {}),
      ...(needsCredentialRef.value && credentialRef.value.trim().length > 0
        ? { credential_ref: credentialRef.value.trim() }
        : {}),
    }
    const created = await providerEndpoints.create(requestedWorkspaceId, input)
    if (requestedWorkspaceId !== workspaceId.value) {
      return
    }
    providers.value = [...providers.value, created]
    connectionId.value = created.id
    credentialRef.value = ''
    statusMessage.value = '连接已保存'
    if (canRunProvider(created)) {
      await testAndDiscover(created.id)
    }
  } catch (error: unknown) {
    if (requestedWorkspaceId === workspaceId.value) {
      errorMessage.value = toMessage(error, 'Provider 创建失败')
    }
  } finally {
    busy.value = false
  }
}

async function testAndDiscover(providerId: string): Promise<void> {
  const provider = providers.value.find((item) => item.id === providerId)
  if (provider !== undefined && !canRunProvider(provider)) {
    return
  }
  try {
    busy.value = true
    const snapshot = await providerEndpoints.test(providerId)
    await providerEndpoints.discover(providerId)
    await loadModels(providerId)
    statusMessage.value = `${snapshot.provider_kind} ACP 握手完成 · ${snapshot.adapter_version}`
  } catch (error: unknown) {
    statusMessage.value = '连接未通过'
    errorMessage.value = toMessage(error, '连接测试失败')
  } finally {
    busy.value = false
  }
}

/**
 * 加载指定连接的模型目录。
 *
 * 只接受仍属于当前连接的响应：用户可能在请求返回前就切走了，
 * 迟到的旧响应不能覆盖新连接的目录与选中模型。
 */
async function loadModels(providerId: string): Promise<void> {
  // 切换连接时先清空，避免旧模型继续满足 canStart。
  models.value = []
  selectedModel.value = ''
  // 仅凭 connectionId 无法识别「同一连接配置已变」：apply 成功后 id 不变，
  // 但此前发出的请求返回时目录已失效。用自增 generation 作废在途请求。
  const generation = ++modelsGeneration
  try {
    const loaded = await providerEndpoints.models(providerId)
    if (!isCurrentModelRequest(providerId, generation)) {
      return
    }
    models.value = loaded
    const first = loaded[0]
    if (selectedModel.value.length === 0 && first !== undefined) {
      selectedModel.value = first.model_id
    }
  } catch (error: unknown) {
    if (!isCurrentModelRequest(providerId, generation)) {
      return
    }
    models.value = []
    selectedModel.value = ''
    errorMessage.value = toMessage(error, '模型目录加载失败')
  }
}

/** 响应提交前同时校验连接与 generation，任一不匹配即丢弃。 */
function isCurrentModelRequest(providerId: string, generation: number): boolean {
  return connectionId.value === providerId && modelsGeneration === generation
}

/** 使在途模型请求全部失效并清空目录；用于配置变更后强制重新发现。 */
function invalidateModels(): void {
  modelsGeneration += 1
  models.value = []
  selectedModel.value = ''
}

async function startSession(): Promise<void> {
  if (!canStartProviderSession.value || connectionId.value === null) {
    return
  }
  const requestedWorkspaceId = workspaceId.value
  busy.value = true
  errorMessage.value = null
  try {
    const result = await sessionEndpoints.create(requestedWorkspaceId, {
      name: `${activeProvider.value?.provider_kind ?? 'Agent'} 对话`,
      provider_connection_id: connectionId.value,
      model_id: selectedModel.value,
    })
    if (requestedWorkspaceId === workspaceId.value) {
      await router.push(`/sessions/${result.session.id}`)
    }
  } catch (error: unknown) {
    if (requestedWorkspaceId === workspaceId.value) {
      errorMessage.value = toMessage(error, 'Session 创建失败')
    }
  } finally {
    busy.value = false
  }
}

async function startRoleBoundSession(binding: RoleBindingDto, role: RoleDto): Promise<void> {
  const requestedWorkspaceId = workspaceId.value
  if (binding.workspace_id !== requestedWorkspaceId || role.workspace_id !== requestedWorkspaceId || busy.value) {
    return
  }
  busy.value = true
  errorMessage.value = null
  try {
    const result = await sessionEndpoints.create(requestedWorkspaceId, {
      name: `${role.name} 对话`,
      role_binding_id: binding.id,
    })
    if (requestedWorkspaceId === workspaceId.value) {
      await router.push(`/sessions/${result.session.id}`)
    }
  } catch (error: unknown) {
    if (requestedWorkspaceId === workspaceId.value) {
      errorMessage.value = toMessage(error, 'Session 创建失败')
    }
  } finally {
    busy.value = false
  }
}

/** 打开修正区，以当前连接的值预填（不回显 Secret，只显示引用是否存在）。 */
function startEditing(): void {
  const provider = activeProvider.value
  if (provider === null) {
    return
  }
  editing.value = true
  editError.value = null
  editConnectionKind.value = provider.connection_kind
  editEnvironmentMode.value = provider.environment_mode
  editBaseUrl.value = provider.base_url ?? ''
  editCredentialRef.value = ''
}

/** 保存非秘密字段；成功后使模型目录与在途请求失效。 */
async function saveConnection(): Promise<void> {
  const provider = activeProvider.value
  if (provider === null) {
    return
  }
  editBusy.value = true
  editError.value = null
  try {
    const updated = await providerEndpoints.update(provider.id, {
      connection_kind: editConnectionKind.value,
      environment_mode: editEnvironmentMode.value,
      // 目标组合不适用时必须显式发 null（清空）；省略会被服务端解释为「保留旧值」，
      // 导致切换类型后被旧字段卡住而无法恢复。
      base_url: editConnectionKind.value === 'custom_endpoint' && editBaseUrl.value.trim().length > 0
        ? editBaseUrl.value.trim()
        : null,
      // 目标组合仍需要引用且输入留空时：省略字段以保留已有引用；只有目标
      // 组合不再使用引用（inherited / local）时才显式 null 清除。
      ...(editNeedsCredentialRef.value
        ? (editCredentialRef.value.trim().length > 0
            ? { credential_ref: editCredentialRef.value.trim() }
            : {})
        : { credential_ref: null }),
      // Claude 上的遗留 codex_config 只能通过显式 null 清除，这是唯一恢复路径。
      ...(provider.provider_kind === 'claude' && provider.codex_config !== undefined
        ? { codex_config: null }
        : {}),
      config_revision: provider.config_revision,
    })
    providers.value = providers.value.map((item) => (item.id === updated.id ? updated : item))
    invalidateModels()
    editCredentialRef.value = ''
    editing.value = false
    statusMessage.value = '连接配置已更新，请重新发现模型'
  } catch (error: unknown) {
    // 失败保留表单选择，便于修正后重试；不静默回退 inherited。
    editError.value = toMessage(error, '连接配置更新失败')
  } finally {
    editBusy.value = false
  }
}

async function previewImport(): Promise<void> {
  if (activeProvider.value === null) {
    return
  }
  importBusy.value = true
  importError.value = null
  try {
    importPreview.value = await providerEndpoints.previewConfigImport(activeProvider.value.id, {
      source_path: importSourcePath.value.trim(),
    })
  } catch (error: unknown) {
    importPreview.value = null
    importError.value = toMessage(error, 'Codex 配置预览失败')
  } finally {
    importBusy.value = false
  }
}

async function applyImport(): Promise<void> {
  if (activeProvider.value === null || importPreview.value === null) {
    return
  }
  importBusy.value = true
  importError.value = null
  try {
    const updated = await providerEndpoints.applyConfigImport(activeProvider.value.id, {
      preview_id: importPreview.value.preview_id,
      confirmed: true,
      target_config_revision: importPreview.value.target_config_revision,
      ...(importCredentialRef.value.trim().length === 0
        ? {}
        : { credential_ref: importCredentialRef.value.trim() }),
    })
    providers.value = providers.value.map((item) => (item.id === updated.id ? updated : item))
    // 导入可能改变连接的运行配置：旧模型目录不再可信，必须重新发现后选择，
    // 否则 canStart 会继续允许用旧 model 创建 Session。同时作废在途请求。
    invalidateModels()
    importCredentialRef.value = ''
    importPreview.value = null
    statusMessage.value = 'Codex 配置已应用，请重新发现模型'
  } catch (error: unknown) {
    importError.value = toMessage(error, 'Codex 配置应用失败')
  } finally {
    importBusy.value = false
  }
}

function selectProvider(provider: ProviderConnectionDto): void {
  connectionId.value = provider.id
  void loadModels(provider.id)
}

/** 优先使用服务端返回的错误文案；ApiClientError 也按形状识别，避免模块实例差异。 */
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
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <router-link class="brand" to="/"><span class="brand-mark" aria-hidden="true" /> Rolecast</router-link>
      <span class="kicker">workspace / provider</span>
    </header>
    <main class="page-grid">
      <section class="surface panel">
        <div class="eyebrow">02 · Provider 环境</div>
        <h1 class="panel-title">先确认谁在运行，再把模型交给角色。</h1>
        <p class="panel-subtitle">
          Rolecast 只保存连接配置与凭据引用。API key 只在提交时写入系统凭据存储，
          页面不会回显 Secret；创建后会得到不透明的 <code>credential_ref</code>。
        </p>
        <hr class="rule" />

        <form id="provider-settings" class="stack" @submit.prevent="createConnection">
          <div class="field-row">
            <div class="field">
              <label for="provider-kind">Provider</label>
              <select id="provider-kind" v-model="providerKind" class="select">
                <option value="claude">Claude ACP</option>
                <option value="codex">Codex ACP</option>
              </select>
            </div>
            <div class="field">
              <label for="connection-kind">连接类型</label>
              <select id="connection-kind" v-model="connectionKind" class="select">
                <option value="local">local</option>
                <option value="api_key">api_key</option>
                <option value="custom_endpoint">custom_endpoint</option>
              </select>
            </div>
            <div class="field">
              <label for="environment-mode">环境模式</label>
              <select id="environment-mode" v-model="environmentMode" class="select">
                <option value="inherited">inherited</option>
                <option value="isolated">isolated</option>
              </select>
            </div>
          </div>

          <div v-if="connectionKind === 'custom_endpoint'" class="field">
            <label for="base-url">自定义 endpoint（非秘密 URL）</label>
            <input id="base-url" v-model="baseUrl" type="url" placeholder="https://gateway.example.test/v1" />
          </div>

          <div v-if="needsCredentialRef" class="field">
            <CredentialRefField
              v-model:credential-ref="credentialRef"
              operation-scope="create"
              input-id="credential-ref"
              :disabled="busy"
            />
          </div>

          <p v-if="environmentMode === 'isolated' && connectionKind === 'local'" class="hint warn-text">
            isolated local 可以保存，但暂时无法运行。
          </p>
          <p v-if="providerKind === 'codex' && environmentMode === 'isolated'" class="hint warn-text">
            Codex isolated 只能通过配置导入建立：先创建 inherited 连接，再预览并应用 config.toml。
          </p>

          <div class="row">
            <button class="button primary" type="submit" :disabled="busy">
              {{ busy ? '保存中…' : '保存连接' }}
            </button>
            <span class="muted">{{ statusMessage }}</span>
          </div>
          <span v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</span>
        </form>

        <div class="workspace-list">
          <div v-if="providers.length === 0" class="empty">还没有连接。选择 Provider 与连接类型开始。</div>
          <button
            v-for="provider in providers"
            :key="provider.id"
            class="workspace-item"
            :class="{ 'is-active': provider.id === connectionId }"
            type="button"
            @click="selectProvider(provider)"
          >
            <span>
              <span class="workspace-name">{{ provider.provider_kind }} / {{ provider.connection_kind }}</span>
              <span class="workspace-meta">{{ provider.environment_mode }} · {{ resolveProviderReadiness(provider).label }}</span>
              <span v-if="provider.credential_ref" class="hint">引用已设置，待连接验证</span>
            </span>
            <span class="kicker">{{ provider.id === connectionId ? '当前' : '选择' }}</span>
          </button>
        </div>

        <section class="stack" aria-labelledby="session-creation-heading">
          <div class="row" style="justify-content: space-between">
            <div><div class="eyebrow">Session</div><strong id="session-creation-heading">创建新的 Session</strong></div>
          </div>
          <div class="field">
            <label for="session-creation-mode">创建方式</label>
            <select id="session-creation-mode" v-model="sessionCreationMode" class="select" data-testid="session-creation-mode">
              <option value="provider">Provider 与模型</option>
              <option value="role-binding">RoleBinding</option>
            </select>
          </div>
          <template v-if="sessionCreationMode === 'provider'">
            <div v-if="activeProvider" class="stack">
              <div class="row" style="justify-content: space-between">
                <div><div class="eyebrow">Model catalog</div><strong>可用模型</strong></div>
                <button
                  class="button"
                  type="button"
                  data-testid="test-connection"
                  :disabled="busy || !isRunnable"
                  @click="testAndDiscover(activeProvider.id)"
                >
                  测试连接并发现模型
                </button>
              </div>
              <select v-if="models.length > 0" v-model="selectedModel" class="select" aria-label="选择模型">
                <option v-for="model in models" :key="model.id" :value="model.model_id">{{ model.display_name }}</option>
              </select>
              <input v-else v-model="selectedModel" placeholder="输入 ACP 暴露的模型 ID" aria-label="模型 ID" />
              <button
                class="button primary"
                type="button"
                data-testid="start-session"
                :disabled="!canStartProviderSession"
                @click="startSession"
              >
                开启单 Agent Session →
              </button>
            </div>
            <p v-else class="hint">先选择一个 Provider 连接，再选择模型。</p>
          </template>
          <RoleBindingSessionCreator
            v-else
            :workspace-id="workspaceId"
            :busy="busy"
            @create="startRoleBoundSession"
          />
          <router-link class="button" :to="`/workspaces/${workspaceId}/roles`">配置 Role 与绑定 →</router-link>
        </section>

        <div v-if="activeProvider" class="stack" style="margin-top: 28px">
          <div class="readiness" :class="`is-${readiness?.status}`" data-testid="readiness">
            <strong>{{ readiness?.label }}</strong>
            <span v-if="readiness && 'detail' in readiness">{{ readiness.detail }}</span>
          </div>

          <div class="edit-panel">
            <div class="row" style="justify-content: space-between">
              <div><div class="eyebrow">Connection</div><strong>修正非秘密配置</strong></div>
              <button
                v-if="!editing"
                class="button"
                type="button"
                data-testid="edit-connection"
                @click="startEditing"
              >
                编辑连接
              </button>
            </div>
            <div v-if="editing" class="stack">
              <div class="field-row">
                <div class="field">
                  <label for="edit-connection-kind">连接类型</label>
                  <select id="edit-connection-kind" v-model="editConnectionKind" class="select">
                    <option value="local">local</option>
                    <option value="api_key">api_key</option>
                    <option value="custom_endpoint">custom_endpoint</option>
                  </select>
                </div>
                <div class="field">
                  <label for="edit-environment-mode">环境模式</label>
                  <select id="edit-environment-mode" v-model="editEnvironmentMode" class="select">
                    <option value="inherited">inherited</option>
                    <option value="isolated">isolated</option>
                  </select>
                </div>
              </div>
              <div v-if="editConnectionKind === 'custom_endpoint'" class="field">
                <label for="edit-base-url">自定义 endpoint（非秘密 URL）</label>
                <input id="edit-base-url" v-model="editBaseUrl" type="url" />
              </div>
              <div v-if="editNeedsCredentialRef" class="field">
                <CredentialRefField
                  v-model:credential-ref="editCredentialRef"
                  :operation-scope="`edit-${activeProvider.id}`"
                  input-id="edit-credential-ref"
                  :disabled="editBusy"
                />
                <span v-if="activeProvider.credential_ref" class="hint">
                  留空表示保持已有引用；本页不读取也不显示 Secret。
                </span>
                <span v-else class="hint">
                  isolated 连接需要凭据引用；可在此直接提交 API key 生成。
                </span>
              </div>
              <p v-if="activeProvider.credential_ref" class="hint">当前连接已设置凭据引用，待连接验证。</p>
              <div class="row">
                <button
                  class="button primary"
                  type="button"
                  data-testid="save-connection"
                  :disabled="editBusy"
                  @click="saveConnection"
                >
                  {{ editBusy ? '保存中…' : '保存配置' }}
                </button>
                <button class="button" type="button" :disabled="editBusy" @click="editing = false">取消</button>
              </div>
              <span v-if="editError" class="error" role="alert">{{ editError }}</span>
            </div>
          </div>

        </div>

        <div v-if="activeProvider && showsImport" class="stack import-panel" style="margin-top: 28px">
          <div class="eyebrow">Codex · config import</div>
          <p class="hint">
            输入服务器上受控的 config.toml 绝对路径。Rolecast 只读取非秘密字段，
            不会复制 auth.json、OAuth 或浏览器文件。
          </p>
          <div class="field">
            <label for="config-source-path">config.toml 路径</label>
            <input id="config-source-path" v-model="importSourcePath" type="text" placeholder="/path/to/config.toml" />
          </div>
          <div class="row">
            <button
              class="button"
              type="button"
              data-testid="preview-import"
              :disabled="importBusy || importSourcePath.trim().length === 0"
              @click="previewImport"
            >
              {{ importBusy ? '预览中…' : '预览配置' }}
            </button>
          </div>

          <div v-if="importPreview" class="preview-card" data-testid="import-preview">
            <div class="kicker">{{ importPreview.source_name }} · revision {{ importPreview.target_config_revision }}</div>
            <ul class="preview-list">
              <li v-for="model in importPreview.models" :key="model.model_id">
                {{ model.display_name }} <span class="muted">{{ model.model_id }}</span>
              </li>
            </ul>
            <div v-if="importPreview.base_url" class="hint">endpoint: {{ importPreview.base_url }}</div>
            <div v-for="warning in importPreview.warnings" :key="warning" class="hint warn-text">{{ warning }}</div>
            <div class="field">
              <CredentialRefField
                v-model:credential-ref="importCredentialRef"
                :operation-scope="`import-${activeProvider.id}`"
                input-id="import-credential-ref"
                :disabled="importBusy"
              />
            </div>
            <button
              class="button primary"
              type="button"
              data-testid="apply-import"
              :disabled="importBusy"
              @click="applyImport"
            >
              确认并应用
            </button>
          </div>
          <span v-if="importError" class="error" role="alert">{{ importError }}</span>
        </div>

        <SessionList :workspace-id="sessionWorkspaceId" />
      </section>

      <aside class="surface status-rail" aria-label="配置步骤">
        <h2>当前路径</h2>
        <div class="status-line"><span class="status-dot live" /><span><span class="status-label">Workspace</span><span class="status-value">已选定</span></span></div>
        <div class="status-line">
          <span class="status-dot" :class="isRunnable ? 'live' : 'warn'" />
          <span>
            <span class="status-label">Provider</span>
            <span class="status-value">{{ readiness?.label ?? '未选择' }}</span>
          </span>
        </div>
        <div class="status-line">
          <span class="status-dot" :class="sessionCreationMode === 'provider' && canStartProviderSession ? 'live' : ''" />
          <span>
            <span class="status-label">Session</span>
            <span class="status-value">{{ sessionCreationMode === 'provider' ? (canStartProviderSession ? '可开启' : '选模型后开启') : '请选择 RoleBinding' }}</span>
          </span>
        </div>
        <div v-if="credentialRefSet" class="status-line">
          <span class="status-dot live" />
          <span><span class="status-label">凭据引用</span><span class="status-value">已设置，待连接验证</span></span>
        </div>
      </aside>
    </main>
  </div>
</template>
