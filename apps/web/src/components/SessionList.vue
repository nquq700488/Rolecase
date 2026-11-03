<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import type { SessionDto } from '@rolecast/contract'

import { sessionEndpoints } from '@/api/endpoints.js'

const props = defineProps<{ workspaceId: string }>()

const statusLabels: Record<SessionDto['status'], string> = {
  active: '运行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档',
}
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const sessions = ref<SessionDto[]>([])
const state = ref<'loading' | 'ready' | 'error'>('loading')
let requestGeneration = 0

onBeforeUnmount(() => {
  requestGeneration += 1
})

watch(() => props.workspaceId, (workspaceId) => {
  void loadSessions(workspaceId)
}, { immediate: true })

async function loadSessions(workspaceId: string): Promise<void> {
  const generation = ++requestGeneration
  sessions.value = []
  state.value = 'loading'

  try {
    const loaded = await sessionEndpoints.list(workspaceId)
    if (generation !== requestGeneration) {
      return
    }
    sessions.value = loaded
    state.value = 'ready'
  } catch {
    if (generation !== requestGeneration) {
      return
    }
    state.value = 'error'
  }
}

function retry(): void {
  void loadSessions(props.workspaceId)
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : dateFormatter.format(date)
}
</script>

<template>
  <section class="session-list" aria-labelledby="session-list-title">
    <div class="session-list-heading">
      <h2 id="session-list-title">已有 Session</h2>
      <span v-if="state === 'ready'" class="session-count">{{ sessions.length }} 个</span>
    </div>

    <p v-if="state === 'loading'" class="session-feedback" role="status">正在加载 Session…</p>
    <div v-else-if="state === 'error'" class="session-error" role="alert">
      <span>Session 列表加载失败，请重试。</span>
      <button class="button" type="button" data-testid="retry-sessions" @click="retry">重试</button>
    </div>
    <div v-else-if="sessions.length === 0" class="empty session-empty" data-testid="sessions-empty">
      <p>还没有 Session。</p>
      <a class="session-create-link" href="#provider-settings">前往 Provider 配置</a>
    </div>
    <ul v-else class="session-items" aria-label="已有 Session">
      <li v-for="session in sessions" :key="session.id" class="session-item">
        <router-link class="session-link" :to="`/sessions/${session.id}`">
          <span class="session-item-main">
            <span class="session-name">{{ session.name }}</span>
            <span class="session-status" :data-status="session.status">{{ statusLabels[session.status] }}</span>
          </span>
          <time class="session-updated" :datetime="session.updated_at">
            更新于 {{ formatUpdatedAt(session.updated_at) }}
          </time>
        </router-link>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.session-list {
  margin-top: 28px;
  padding-top: 22px;
  border-top: 1px solid var(--line);
}

.session-list-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.session-list-heading h2 {
  margin: 0;
  font-family: 'DM Sans', 'Avenir Next', system-ui, sans-serif;
  font-size: 20px;
  letter-spacing: -.03em;
}

.session-count,
.session-updated {
  color: var(--muted);
  font-size: 12px;
}

.session-items {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.session-link {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 16px;
  border: 1px solid var(--line);
  background: var(--navy);
  transition: border-color 160ms ease;
}

.session-link:hover {
  border-color: var(--cyan);
}

.session-item-main {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}

.session-name {
  overflow-wrap: anywhere;
  font-weight: 700;
}

.session-status {
  flex: 0 0 auto;
  padding-left: 8px;
  border-left: 2px solid var(--line);
  color: var(--muted);
  font-size: 12px;
}

.session-status[data-status='active'] {
  border-color: var(--cyan);
  color: var(--text);
}

.session-status[data-status='paused'] {
  border-color: var(--amber);
}

.session-status[data-status='completed'] {
  border-color: var(--ice);
}

.session-feedback,
.session-error {
  margin: 0;
  padding: 14px 16px;
  border-left: 2px solid var(--line);
  color: var(--muted);
  background: rgb(13 23 39 / 60%);
}

.session-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-left-color: var(--coral);
  color: var(--text);
}

.session-empty p {
  margin: 0 0 8px;
}

.session-create-link {
  color: var(--ice);
  text-decoration: underline;
  text-underline-offset: 3px;
}

@media (max-width: 480px) {
  .session-link,
  .session-item-main,
  .session-error {
    align-items: flex-start;
    flex-direction: column;
  }

  .session-updated {
    white-space: normal;
  }
}
</style>
