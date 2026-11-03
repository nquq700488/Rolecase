// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { ModelCatalogEntryDto, ProviderConnectionDto, RoleDto } from '@rolecast/contract'

import RoleBindingEditor from './RoleBindingEditor.vue'

const roles: RoleDto[] = [{
  id: 'role-001',
  workspace_id: 'workspace-001',
  name: '执行者',
  description: '',
  system_prompt: '',
  required_guidelines: [],
  gates: [],
  output_contract: '',
  blocking_conditions: [],
  selectable: true,
  dispatchable: false,
  version: 1,
  created_at: '2026-10-14T10:00:00.000Z',
  updated_at: '2026-10-14T10:00:00.000Z',
}, {
  id: 'role-002',
  workspace_id: 'workspace-001',
  name: '审查者',
  description: '',
  system_prompt: '',
  required_guidelines: [],
  gates: [],
  output_contract: '',
  blocking_conditions: [],
  selectable: true,
  dispatchable: false,
  version: 1,
  created_at: '2026-10-14T10:00:00.000Z',
  updated_at: '2026-10-14T10:00:00.000Z',
}]

const providers: ProviderConnectionDto[] = [
  { id: 'provider-a', workspace_id: 'workspace-001', provider_kind: 'claude', connection_kind: 'local', environment_mode: 'inherited', config_revision: 1 },
  { id: 'provider-b', workspace_id: 'workspace-001', provider_kind: 'codex', connection_kind: 'local', environment_mode: 'inherited', config_revision: 1 },
]

const models: ModelCatalogEntryDto[] = [{
  id: 'model-a',
  workspace_id: 'workspace-001',
  provider_connection_id: 'provider-a',
  provider_kind: 'claude',
  model_id: 'model-a',
  display_name: 'Model A',
  capabilities: {},
  observed_at: '2026-10-14T10:00:00.000Z',
}]

describe('RoleBindingEditor', () => {
  it('切换 Provider 时通知页面重新加载模型并清空旧选择', async () => {
    const wrapper = mount(RoleBindingEditor, {
      props: { binding: null, initialRoleId: 'role-001', roles, providers, models, busy: false },
    })

    await wrapper.get('#binding-provider').setValue('provider-b')

    expect(wrapper.emitted('providerChange')).toEqual([['provider-b']])
    expect((wrapper.get('#binding-model').element as HTMLSelectElement).value).toBe('')
  })

  it('新建 Binding 使用当前选中的 Role', async () => {
    const wrapper = mount(RoleBindingEditor, {
      props: { binding: null, initialRoleId: 'role-002', roles, providers, models, busy: false },
    })

    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ role_id: 'role-002' })
  })
})
