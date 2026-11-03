<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import type {
  CreateRoleBindingRequest,
  CreateRoleRequest,
  ModelCatalogEntryDto,
  ProviderConnectionDto,
  RoleBindingDto,
  UpdateRoleBindingRequest,
  UpdateRoleRequest,
} from '@rolecast/contract'

import { providerEndpoints } from '@/api/endpoints.js'
import RoleBindingEditor from '@/components/RoleBindingEditor.vue'
import RoleEditor from '@/components/RoleEditor.vue'
import { ApiClientError } from '@/api/httpClient.js'
import { useRoleStore } from '@/stores/roles.js'

const route = useRoute()
const router = useRouter()
const roleStore = useRoleStore()
const workspaceId = String(route.params.workspaceId)
const providers = ref<ProviderConnectionDto[]>([])
const models = ref<ModelCatalogEntryDto[]>([])
const selectedProviderId = ref<string | null>(null)
const providerError = ref<string | null>(null)
const editingNewRole = ref(false)
const editingNewBinding = ref(false)
const selectedBindingId = ref<string | null>(null)

const selectedRole = computed(() => roleStore.roles.find((role) => role.id === roleStore.selectedRoleId) ?? null)
const selectedBinding = computed(() => roleStore.bindings.find((binding) => binding.id === selectedBindingId.value) ?? null)
const selectedRoleBindings = computed(() => roleStore.bindings.filter((binding) => binding.role_id === roleStore.selectedRoleId))

onMounted(() => {
  void load()
})

watch(selectedProviderId, (providerId) => {
  models.value = []
  if (providerId !== null) {
    void loadModels(providerId)
  }
})

async function load(): Promise<void> {
  await Promise.all([roleStore.load(workspaceId), loadProviders()])
}

async function loadProviders(): Promise<void> {
  try {
    providers.value = await providerEndpoints.list(workspaceId)
    selectedProviderId.value = providers.value[0]?.id ?? null
  } catch (error: unknown) {
    providerError.value = error instanceof ApiClientError ? error.message : 'Provider 列表加载失败'
  }
}

async function loadModels(providerId: string): Promise<void> {
  try {
    const nextModels = await providerEndpoints.models(providerId)
    if (selectedProviderId.value === providerId) {
      models.value = nextModels
    }
  } catch (error: unknown) {
    if (selectedProviderId.value === providerId) {
      providerError.value = error instanceof ApiClientError ? error.message : '模型目录加载失败'
      models.value = []
    }
  }
}

async function handleRoleSave(input: CreateRoleRequest | UpdateRoleRequest): Promise<void> {
  if (editingNewRole.value || selectedRole.value === null) {
    const role = await roleStore.createRole(workspaceId, input as CreateRoleRequest)
    if (role !== null) {
      editingNewRole.value = false
    }
    return
  }
  if ('version' in input) {
    await roleStore.updateRole(selectedRole.value.id, input)
  }
}

async function handleRoleRemove(): Promise<void> {
  const role = selectedRole.value
  if (role === null || !window.confirm(`确定删除角色“${role.name}”吗？`)) {
    return
  }
  const removed = await roleStore.removeRole(role.id, role.version)
  if (removed) {
    editingNewRole.value = false
  }
}

async function handleBindingSave(input: CreateRoleBindingRequest | UpdateRoleBindingRequest): Promise<void> {
  if (editingNewBinding.value || selectedBinding.value === null) {
    const binding = await roleStore.createBinding(workspaceId, input as CreateRoleBindingRequest)
    if (binding !== null) {
      editingNewBinding.value = false
      selectedBindingId.value = binding.id
    }
    return
  }
  if ('version' in input) {
    await roleStore.updateBinding(selectedBinding.value.id, input)
  }
}

async function handleBindingRemove(): Promise<void> {
  const binding = selectedBinding.value
  if (binding === null || !window.confirm('确定删除这个 RoleBinding 吗？')) {
    return
  }
  const removed = await roleStore.removeBinding(binding.id, binding.version)
  if (removed) {
    editingNewBinding.value = false
    selectedBindingId.value = null
  }
}

function selectRole(roleId: string): void {
  editingNewRole.value = false
  roleStore.selectRole(roleId)
  selectedBindingId.value = roleStore.bindings.find((binding) => binding.role_id === roleId)?.id ?? null
}

function startRole(): void {
  editingNewRole.value = true
  roleStore.selectRole(null)
  selectedBindingId.value = null
}

function startBinding(): void {
  editingNewBinding.value = true
  selectedBindingId.value = null
}

function handleProviderChange(providerId: string): void {
  selectedProviderId.value = providerId
  models.value = []
}

function editBinding(binding: RoleBindingDto): void {
  editingNewBinding.value = false
  selectedBindingId.value = binding.id
  selectedProviderId.value = binding.provider_connection_id
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <router-link class="brand" to="/"><span class="brand-mark" aria-hidden="true" /> Rolecast</router-link>
      <div class="row">
        <span class="kicker">workspace / roles</span>
        <button class="button" type="button" @click="router.push(`/workspaces/${workspaceId}/provider`)">返回 Provider</button>
      </div>
    </header>

    <main class="page-grid role-page-grid">
      <section class="surface panel role-workspace">
        <div class="eyebrow">03 · 角色与绑定</div>
        <h1 class="panel-title">让每个模型，承担清楚的工作。</h1>
        <p class="panel-subtitle">Role 描述协作职责，RoleBinding 只负责把它接到当前 Workspace 已发现的执行模型。</p>
        <hr class="rule" />

        <div class="role-columns">
          <section class="role-list" aria-labelledby="role-list-title">
            <div class="row list-heading">
              <h2 id="role-list-title" class="section-title">Roles</h2>
              <button class="button" type="button" :disabled="roleStore.loading" @click="startRole">＋ 新建</button>
            </div>
            <div v-if="roleStore.loading && roleStore.roles.length === 0" class="empty">正在读取角色配置…</div>
            <div v-else-if="roleStore.roles.length === 0" class="empty">还没有角色。先建立一个角色，再绑定模型。</div>
            <div v-else class="workspace-list">
              <button
                v-for="role in roleStore.roles"
                :key="role.id"
                class="workspace-item"
                :class="{ 'is-active': role.id === roleStore.selectedRoleId && !editingNewRole }"
                type="button"
                @click="selectRole(role.id)"
              >
                <span><span class="workspace-name">{{ role.name }}</span><span class="workspace-meta">{{ role.id }} · v{{ role.version }}</span></span>
                <span class="kicker">{{ role.dispatchable ? '可派发' : '可选择' }}</span>
              </button>
            </div>
          </section>

          <RoleEditor
            :role="editingNewRole ? null : selectedRole"
            :busy="roleStore.loading"
            @save="handleRoleSave"
            @remove="handleRoleRemove"
          />
        </div>

        <section class="binding-section" aria-labelledby="binding-list-title">
          <div class="row list-heading">
            <div>
              <div class="eyebrow">Bindings in current Role</div>
              <h2 id="binding-list-title" class="section-title">执行配置</h2>
            </div>
            <button class="button" type="button" :disabled="selectedRole === null || roleStore.loading" @click="startBinding">＋ 新建绑定</button>
          </div>
          <div v-if="selectedRole === null" class="empty">选择一个 Role 后查看它的执行绑定。</div>
          <div v-else-if="selectedRoleBindings.length === 0" class="empty">这个 Role 还没有绑定模型。</div>
          <div v-else class="binding-list">
            <button
              v-for="binding in selectedRoleBindings"
              :key="binding.id"
              class="binding-item"
              :class="{ 'is-active': binding.id === selectedBindingId && !editingNewBinding }"
              type="button"
              @click="editBinding(binding)"
            >
              <span><strong>{{ binding.model_id }}</strong><span class="workspace-meta">{{ binding.provider_connection_id }} · priority {{ binding.priority }}</span></span>
              <span class="kicker">{{ binding.enabled ? '启用' : '停用' }}</span>
            </button>
          </div>
        </section>

        <RoleBindingEditor
          v-if="selectedRole !== null || editingNewBinding"
          :binding="editingNewBinding ? null : selectedBinding"
          :initial-role-id="roleStore.selectedRoleId"
          :roles="roleStore.roles"
          :providers="providers"
          :models="models"
          :busy="roleStore.loading"
          @save="handleBindingSave"
          @remove="handleBindingRemove"
          @provider-change="handleProviderChange"
        />
        <div v-if="roleStore.errorMessage" class="error role-feedback" role="alert">{{ roleStore.errorMessage }}</div>
        <div v-if="roleStore.conflictMessage" class="warning role-feedback" role="status">{{ roleStore.conflictMessage }}</div>
        <div v-if="providerError" class="error role-feedback" role="alert">{{ providerError }}</div>
      </section>

      <aside class="surface status-rail" aria-label="角色配置路径">
        <h2>当前路径</h2>
        <div class="status-line"><span class="status-dot live" /><span><span class="status-label">Workspace</span><span class="status-value">已选定</span></span></div>
        <div class="status-line"><span class="status-dot live" /><span><span class="status-label">Role</span><span class="status-value">{{ selectedRole?.name ?? '等待建立' }}</span></span></div>
        <div class="status-line"><span class="status-dot" /><span><span class="status-label">Provider / Model</span><span class="status-value">{{ selectedProviderId ? '可选择绑定' : '先配置 Provider' }}</span></span></div>
        <div class="status-line"><span class="status-dot warn" /><span><span class="status-label">配置安全</span><span class="status-value">JSON · CAS · 本地</span></span></div>
      </aside>
    </main>
  </div>
</template>
