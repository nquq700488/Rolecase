import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import UnoCSS from '@unocss/vite'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [vue(), UnoCSS()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: true,
        ws: true,
      },
      '/healthz': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: true,
      },
    },
  },
})
