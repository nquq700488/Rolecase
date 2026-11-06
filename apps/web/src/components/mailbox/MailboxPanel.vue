<script setup lang="ts">
import { nextTick, onUnmounted, watch } from 'vue'

import { useMailboxStore } from '@/stores/mailbox.js'

const props = defineProps<{
  sessionId: string
  slotId: string
}>()

const store = useMailboxStore()
let detailTrigger: HTMLButtonElement | null = null

function reload(): void {
  if (props.sessionId.length > 0 && props.slotId.length > 0) {
    void store.load(props.sessionId, props.slotId)
  }
}

function loadMore(): void {
  void store.loadMore(props.sessionId, props.slotId)
}

function openItem(messageId: string, event: MouseEvent): void {
  const trigger = event.currentTarget
  detailTrigger = trigger instanceof HTMLButtonElement ? trigger : null
  void store.open(props.sessionId, props.slotId, messageId)
}

async function closeDetail(): Promise<void> {
  const trigger = detailTrigger
  store.closeDetail()
  await nextTick()
  if (trigger === null || detailTrigger !== trigger) {
    return
  }
  detailTrigger = null
  if (trigger.isConnected) {
    trigger.focus()
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

watch(
  () => [props.sessionId, props.slotId] as const,
  ([sessionId, slotId]) => {
    // 切换 Session/Slot 必须清空旧摘要，不能用上一目标的收件冒充当前目标。
    detailTrigger = null
    store.reset()
    if (sessionId.length > 0 && slotId.length > 0) {
      void store.load(sessionId, slotId)
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  detailTrigger = null
  store.reset()
})
</script>

<template>
  <section class="mailbox-panel" data-testid="mailbox" aria-labelledby="mailbox-heading">
    <h3 id="mailbox-heading">收件箱</h3>
    <p v-if="slotId.length === 0" class="muted" role="status">选择一个 Agent 查看它的交接收件。</p>
    <template v-else>
      <p class="muted" role="status" data-testid="mailbox-unread">
        已加载未读 {{ store.loadedUnreadCount }} 条<template v-if="store.hasMore"> · 还有更多消息未加载</template>
      </p>
      <p v-if="store.loading" class="muted" role="status">正在载入收件…</p>
      <div v-else-if="store.loadError" class="row">
        <p class="error" role="alert">{{ store.loadError }}</p>
        <button class="button" type="button" data-testid="mailbox-retry" @click="reload">重试</button>
      </div>
      <p v-else-if="store.items.length === 0" class="muted" role="status">这个 Agent 还没有收到交接消息。</p>
      <ul v-else class="timeline">
        <li
          v-for="item in store.items"
          :key="item.id"
          class="timeline-item"
          :data-testid="`mailbox-item-${item.id}`"
        >
          <button class="button" type="button" @click="openItem(item.id, $event)">
            {{ item.status === 'unread' ? '未读' : '已读' }} · {{ item.sender_id }} · {{ formatTime(item.created_at) }}
          </button>
        </li>
      </ul>
      <button
        v-if="store.hasMore"
        class="button"
        type="button"
        data-testid="mailbox-load-more"
        :disabled="store.loadingMore"
        @click="loadMore"
      >
        {{ store.loadingMore ? '加载中…' : '加载更多' }}
      </button>
      <p v-if="store.actionError" class="error" role="alert">{{ store.actionError }}</p>
      <p v-if="store.notice" class="hint" role="status">{{ store.notice }}</p>
      <article v-if="store.detail" class="timeline-item" data-testid="mailbox-detail">
        <p class="muted">{{ store.detail.message.sender_id }} → {{ store.detail.message.to_slot_id }}</p>
        <p v-if="store.detailLoading" class="muted" role="status">正在读取…</p>
        <p>{{ store.detail.message.content }}</p>
        <button class="button" type="button" data-testid="mailbox-close-detail" @click="closeDetail">关闭</button>
      </article>
    </template>
  </section>
</template>
