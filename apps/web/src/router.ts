import { createRouter, createWebHistory } from 'vue-router'

import HomePage from './pages/HomePage.vue'
import ProviderPage from './pages/ProviderPage.vue'
import RolePage from './pages/RolePage.vue'
import SessionPage from './pages/SessionPage.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: HomePage },
    { path: '/workspaces/:workspaceId/provider', component: ProviderPage },
    { path: '/workspaces/:workspaceId/roles', component: RolePage },
    { path: '/sessions/:sessionId', component: SessionPage },
  ],
})
