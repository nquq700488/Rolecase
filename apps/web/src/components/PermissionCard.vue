<script setup lang="ts">
import { computed } from 'vue'

import type { PermissionRequestDto } from '@rolecast/contract'

const props = defineProps<{ request: PermissionRequestDto }>()
const emit = defineEmits<{ answer: [optionId: string] }>()

const isOverdue = computed(() => props.request.overdue_at !== undefined && props.request.status === 'pending')
const label = computed(() => isOverdue.value ? '等待时间较长' : '需要你的决定')
</script>

<template>
  <article class="permission-card" :aria-label="`权限请求：${request.description}`">
    <h4>{{ label }}</h4>
    <p>{{ request.description }}</p>
    <div class="kicker" style="margin-bottom: 10px">{{ request.capability }} · {{ request.status }}</div>
    <div v-if="request.status === 'pending'" class="permission-actions">
      <button
        v-for="option in request.adapter_options"
        :key="option.option_id"
        class="button warn"
        type="button"
        @click="emit('answer', option.option_id)"
      >
        {{ option.name }}
      </button>
    </div>
    <div v-else class="muted">此请求已{{ request.status === 'expired' ? '过期' : '回答' }}，不会自动重跑。</div>
  </article>
</template>
