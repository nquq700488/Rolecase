<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { useWorkspaceStore } from '@/stores/workspace.js'

const router = useRouter()
const workspaceStore = useWorkspaceStore()
const workspaceName = ref('')
const workspaceRootPath = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)
const editingRootPathWorkspaceId = ref<string | null>(null)
const rootPathInput = ref('')
const rootPathFormError = ref<string | null>(null)
const savingRootPathWorkspaceId = ref<string | null>(null)

const hasWorkspaces = computed(() => workspaceStore.workspaces.length > 0)

onMounted(() => {
  void workspaceStore.load()
})

async function handleCreate(): Promise<void> {
  if (workspaceName.value.trim().length === 0) {
    createError.value = '先给工作区一个名字。'
    return
  }
  if (workspaceRootPath.value.trim().length === 0) {
    createError.value = '请输入现存目录的绝对路径。'
    return
  }
  creating.value = true
  createError.value = null
  const workspace = await workspaceStore.create(workspaceName.value, workspaceRootPath.value)
  creating.value = false
  if (workspace !== null) {
    workspaceName.value = ''
    workspaceRootPath.value = ''
    await router.push(`/workspaces/${workspace.id}/provider`)
  } else {
    createError.value = workspaceStore.errorMessage
  }
}

function openWorkspace(id: string): void {
  workspaceStore.select(id)
  void router.push(`/workspaces/${id}/provider`)
}

function getConfiguredRootPath(workspaceId: string): string | null {
  const state = workspaceStore.rootPathStates[workspaceId]
  return state?.status === 'configured' ? state.rootPath : null
}

function beginRootPathSetup(workspaceId: string): void {
  editingRootPathWorkspaceId.value = workspaceId
  rootPathInput.value = ''
  rootPathFormError.value = null
}

function cancelRootPathSetup(): void {
  editingRootPathWorkspaceId.value = null
  rootPathInput.value = ''
  rootPathFormError.value = null
}

async function handleSetRootPath(workspaceId: string): Promise<void> {
  if (rootPathInput.value.trim().length === 0) {
    rootPathFormError.value = '请输入现存目录的绝对路径。'
    return
  }
  const confirmed = window.confirm(
    '根目录设置后不能修改或清除。Rolecast 只会保存服务端解析出的规范路径；本次操作不会创建目录或读取目录内容。确认设置？',
  )
  if (!confirmed) {
    return
  }

  savingRootPathWorkspaceId.value = workspaceId
  rootPathFormError.value = null
  try {
    const saved = await workspaceStore.setRootPath(workspaceId, rootPathInput.value)
    if (saved) {
      cancelRootPathSetup()
    }
  } finally {
    savingRootPathWorkspaceId.value = null
  }
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark" aria-hidden="true" /> Rolecast</div>
      <span class="kicker">local / phase 01A</span>
    </header>

    <main class="page-grid">
      <section class="surface panel">
        <div class="eyebrow">01 · 工作区</div>
        <h1 class="panel-title">把一次协作，安放在它自己的现场。</h1>
        <p class="panel-subtitle">
          Workspace 是 Provider、模型和会话的边界。先建立一个现场，再让 Agent 在里面留下可追溯的运行记录。
        </p>
        <hr class="rule" />
        <form class="stack" aria-label="新建工作区" @submit.prevent="handleCreate">
          <div class="field">
            <label for="workspace-name">新工作区名称</label>
            <input id="workspace-name" v-model="workspaceName" placeholder="例如：Rolecast 本体" autocomplete="off" required />
          </div>
          <div class="field">
            <label for="workspace-root-path">服务端访问的根目录绝对路径</label>
            <input
              id="workspace-root-path"
              v-model="workspaceRootPath"
              aria-describedby="workspace-root-path-help"
              placeholder="例如：/Users/me/Projects/rolecast"
              autocomplete="off"
              spellcheck="false"
              required
            />
            <p id="workspace-root-path-help" class="hint">
              输入一个已存在且可访问的目录。本机 Rolecast Server 会校验并保存规范路径；不会创建目录或读取其中的文件。
            </p>
          </div>
          <div class="row">
            <button class="button primary" type="submit" :disabled="creating">
              {{ creating ? '正在建立…' : '建立工作区' }}
            </button>
            <span v-if="createError" class="error" role="alert">{{ createError }}</span>
          </div>
        </form>

        <div class="workspace-list" aria-live="polite">
          <div v-if="workspaceStore.loading && !hasWorkspaces" class="empty">正在读取本地工作区…</div>
          <div v-else-if="workspaceStore.errorMessage && !hasWorkspaces" class="empty error" role="alert">
            {{ workspaceStore.errorMessage }}
          </div>
          <div v-else-if="!hasWorkspaces" class="empty">还没有工作区。上面的表单会开启第一条运行线。</div>
          <div
            v-for="workspace in workspaceStore.workspaces"
            :key="workspace.id"
            class="workspace-item"
            :class="{ 'is-active': workspace.id === workspaceStore.selectedId }"
          >
            <button class="workspace-open" type="button" @click="openWorkspace(workspace.id)">
              <span class="workspace-identity">
                <span class="workspace-name">{{ workspace.name }}</span>
                <span class="workspace-meta">{{ workspace.id }}</span>
              </span>
              <span class="kicker">进入 →</span>
            </button>

            <div class="root-path-panel">
              <div v-if="workspaceStore.rootPathStates[workspace.id]?.status === 'configured'" class="root-path-status">
                <span class="status-label">根目录已配置</span>
                <code class="root-path-value">{{ getConfiguredRootPath(workspace.id) }}</code>
              </div>
              <div v-else-if="workspaceStore.rootPathStates[workspace.id]?.status === 'unconfigured'" class="root-path-actions">
                <span class="status-value">尚未设置根目录</span>
                <button
                  class="button root-path-configure"
                  type="button"
                  :disabled="savingRootPathWorkspaceId === workspace.id"
                  @click="beginRootPathSetup(workspace.id)"
                >
                  一次性设置根目录
                </button>
              </div>
              <div v-else-if="workspaceStore.rootPathStates[workspace.id]?.status === 'error'" class="root-path-actions">
                <span class="error" role="alert">根目录状态读取失败；为避免错误设置，请重新读取。</span>
                <button class="button root-path-retry" type="button" @click="workspaceStore.loadRootPath(workspace.id)">
                  重试读取
                </button>
              </div>
              <p v-else class="status-value" role="status">正在读取根目录状态…</p>
              <p v-if="workspaceStore.rootPathActionErrors[workspace.id]" class="error" role="alert">
                {{ workspaceStore.rootPathActionErrors[workspace.id] }}
              </p>

              <form
                v-if="editingRootPathWorkspaceId === workspace.id && workspaceStore.rootPathStates[workspace.id]?.status === 'unconfigured'"
                class="root-path-editor stack"
                aria-label="一次性设置根目录"
                @submit.prevent="handleSetRootPath(workspace.id)"
              >
                <p class="warning">
                  此设置不可修改或清除。确认前不会发送请求；服务端只校验现存目录并保存规范路径。
                </p>
                <div class="field">
                  <label for="root-path-input">服务端可访问的绝对路径</label>
                  <input
                    id="root-path-input"
                    v-model="rootPathInput"
                    placeholder="例如：/Users/me/Projects/rolecast"
                    autocomplete="off"
                    spellcheck="false"
                    required
                  />
                </div>
                <p v-if="rootPathFormError" class="error" role="alert">{{ rootPathFormError }}</p>
                <div class="row root-path-editor-actions">
                  <button
                    class="button warn"
                    type="submit"
                    :disabled="savingRootPathWorkspaceId === workspace.id"
                  >
                    {{ savingRootPathWorkspaceId === workspace.id ? '正在保存…' : '确认设置' }}
                  </button>
                  <button class="button" type="button" @click="cancelRootPathSetup">取消</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </section>

      <aside class="surface status-rail" aria-label="运行状态">
        <h2>本地运行台</h2>
        <div class="status-line"><span class="status-dot live" /><span><span class="status-label">数据留在本机</span><span class="status-value">SQLite / event history</span></span></div>
        <div class="status-line"><span class="status-dot" /><span><span class="status-label">Provider 尚未连接</span><span class="status-value">下一步配置 inherited 环境</span></span></div>
        <div class="status-line"><span class="status-dot warn" /><span><span class="status-label">权限由你决定</span><span class="status-value">5 min 提醒 / 30 min 过期</span></span></div>
      </aside>
    </main>
  </div>
</template>
