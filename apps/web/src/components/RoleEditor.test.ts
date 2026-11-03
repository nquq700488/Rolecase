// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import RoleEditor from './RoleEditor.vue'

describe('RoleEditor', () => {
  it('创建 Role 时提交结构化字段和列表', async () => {
    const wrapper = mount(RoleEditor, { props: { role: null, busy: false } })
    await wrapper.get('#role-name').setValue('执行者')
    await wrapper.get('#role-guidelines').setValue('先读后写\n给出证据')
    await wrapper.get('form').trigger('submit')

    const emitted = wrapper.emitted('save')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0]?.[0]).toMatchObject({
      name: '执行者',
      required_guidelines: ['先读后写', '给出证据'],
    })
  })
})
