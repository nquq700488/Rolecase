<script setup lang="ts">
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import { ref } from 'vue'

import { getLocalToken } from '@/api/httpClient.js'

const tokenAvailable = ref(getLocalToken() !== null)
</script>

<template>
  <n-config-provider>
    <n-message-provider>
      <main v-if="!tokenAvailable" class="shell">
        <section class="surface panel" style="max-width: 720px; margin: 10vh auto">
          <div class="eyebrow">local token</div>
          <h1 class="panel-title">需要从本地入口进入</h1>
          <p class="panel-subtitle">URL 中的 Token 已被清除，不能从查询参数恢复。请重新运行 Server，并打开启动输出中的 Web 入口。</p>
        </section>
      </main>
      <router-view v-else />
    </n-message-provider>
  </n-config-provider>
</template>
