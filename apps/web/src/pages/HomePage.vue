<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { useWorkspaceStore } from '@/stores/workspace.js'

const router = useRouter()
const workspaceStore = useWorkspaceStore()
const workspaceName = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

const hasWorkspaces = computed(() => workspaceStore.workspaces.length > 0)

onMounted(() => {
  void workspaceStore.load()
})

async function handleCreate(): Promise<void> {
  if (workspaceName.value.trim().length === 0) {
    createError.value = '先给工作区一个名字。'
    return
  }
  creating.value = true
  createError.value = null
  const workspace = await workspaceStore.create(workspaceName.value)
  creating.value = false
  if (workspace !== null) {
    workspaceName.value = ''
    await router.push(`/workspaces/${workspace.id}/provider`)
  } else {
    createError.value = workspaceStore.errorMessage
  }
}

function openWorkspace(id: string): void {
  workspaceStore.select(id)
  void router.push(`/workspaces/${id}/provider`)
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
        <form class="stack" @submit.prevent="handleCreate">
          <div class="field">
            <label for="workspace-name">新工作区名称</label>
            <input id="workspace-name" v-model="workspaceName" placeholder="例如：Rolecast 本体" autocomplete="off" />
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
          <div v-else-if="!hasWorkspaces" class="empty">还没有工作区。上面的按钮会开启第一条运行线。</div>
          <button
            v-for="workspace in workspaceStore.workspaces"
            :key="workspace.id"
            class="workspace-item"
            type="button"
            @click="openWorkspace(workspace.id)"
          >
            <span>
              <span class="workspace-name">{{ workspace.name }}</span>
              <span class="workspace-meta">{{ workspace.id }}</span>
            </span>
            <span class="kicker">进入 →</span>
          </button>
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
