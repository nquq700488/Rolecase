<script setup lang="ts">
import { nextTick, onUnmounted, watch } from 'vue'

import { useArtifactStore } from '@/stores/artifact.js'

const props = defineProps<{ sessionId: string }>()
const store = useArtifactStore()
let previewTrigger: HTMLButtonElement | null = null

function reload(): void {
  if (props.sessionId.length > 0) {
    void store.load(props.sessionId)
  }
}

function openPreview(artifactId: string, event: MouseEvent): void {
  const trigger = event.currentTarget
  previewTrigger = trigger instanceof HTMLButtonElement ? trigger : null
  void store.open(props.sessionId, artifactId)
}

function retryPreview(): void {
  if (store.previewArtifactId !== null) {
    void store.open(props.sessionId, store.previewArtifactId)
  }
}

async function closePreview(): Promise<void> {
  const trigger = previewTrigger
  store.closePreview()
  await nextTick()
  if (trigger === null || previewTrigger !== trigger) {
    return
  }
  previewTrigger = null
  if (trigger.isConnected) {
    trigger.focus()
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

watch(() => props.sessionId, (sessionId) => {
  previewTrigger = null
  store.reset()
  if (sessionId.length > 0) {
    void store.load(sessionId)
  }
}, { immediate: true })

onUnmounted(() => {
  previewTrigger = null
  store.reset()
})
</script>

<template>
  <section class="artifact-panel" data-testid="artifact-panel" aria-labelledby="artifact-heading">
    <h3 id="artifact-heading">Artifacts</h3>
    <p v-if="store.loading" class="muted" role="status">正在载入 Artifact 列表…</p>
    <div v-else-if="store.loadError" class="row">
      <p class="error" role="alert">{{ store.loadError }}</p>
      <button class="button" type="button" data-testid="artifact-retry" @click="reload">重试</button>
    </div>
    <p v-else-if="store.items.length === 0" class="muted" role="status">还没有 Artifact。</p>
    <template v-else>
      <ul class="artifact-list">
        <li
          v-for="item in store.items"
          :key="item.id"
          class="artifact-item"
          :class="{ 'is-active': store.previewArtifactId === item.id }"
        >
          <button
            class="artifact-open"
            type="button"
            :data-testid="`artifact-item-${item.id}`"
            :aria-label="`打开 Artifact ${item.id} 的纯文本预览`"
            :aria-pressed="store.previewArtifactId === item.id"
            @click="openPreview(item.id, $event)"
          >
            <span class="artifact-id">{{ item.id }}</span>
            <span class="artifact-meta">{{ formatTime(item.created_at) }} · {{ item.size_bytes }} bytes</span>
          </button>
        </li>
      </ul>
      <button
        v-if="store.hasMore"
        class="button artifact-more"
        type="button"
        data-testid="artifact-load-more"
        :disabled="store.loadingMore"
        @click="store.loadMore(sessionId)"
      >
        {{ store.loadingMore ? '加载中…' : '加载更多' }}
      </button>
      <p v-if="store.actionError" class="error" role="alert">{{ store.actionError }}</p>
    </template>

    <article v-if="store.previewArtifactId !== null" class="artifact-preview" data-testid="artifact-preview">
      <header class="artifact-preview-heading">
        <h4>{{ store.previewArtifactId }}</h4>
        <button class="button" type="button" data-testid="artifact-close-preview" @click="closePreview">关闭预览</button>
      </header>
      <p v-if="store.previewLoading" class="muted" role="status">正在读取纯文本正文…</p>
      <div v-else-if="store.previewError" class="row">
        <p class="error" role="alert">{{ store.previewError }}</p>
        <button class="button" type="button" data-testid="artifact-retry-preview" @click="retryPreview">重试</button>
      </div>
      <pre v-else-if="store.previewContent !== null" class="artifact-content">{{ store.previewContent }}</pre>
    </article>
  </section>
</template>
