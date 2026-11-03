// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { PermissionRequestDto } from '@rolecast/contract'

import PermissionCard from './PermissionCard.vue'

const request: PermissionRequestDto = {
  id: 'permission-001',
  run_id: 'run-001',
  task_id: 'task-001',
  slot_id: 'slot-001',
  capability: 'execute',
  description: '执行一个命令',
  adapter_options: [{ option_id: 'allow_once', name: '允许一次', kind: 'allow_once' }],
  status: 'pending',
  requested_at: '2026-10-14T10:00:00.000Z',
  soft_timeout_at: '2026-10-14T10:05:00.000Z',
  expires_at: '2026-10-14T10:30:00.000Z',
}

describe('PermissionCard', () => {
  it('只渲染 Adapter 提供的选项并回传 option ID', async () => {
    const wrapper = mount(PermissionCard, { props: { request } })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('answer')).toEqual([['allow_once']])
  })

  it('过期请求不提供回答按钮', () => {
    const wrapper = mount(PermissionCard, {
      props: { request: { ...request, status: 'expired', expired_at: '2026-10-14T10:30:00.000Z' } },
    })
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.text()).toContain('过期')
  })
})
