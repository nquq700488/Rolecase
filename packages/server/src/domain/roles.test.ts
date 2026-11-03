import { describe, expect, it } from 'vitest'

import {
  assertBindingWorkspaceConsistency,
  createRole,
  createRoleBinding,
  updateRole,
} from './index.js'

describe('Role Domain', () => {
  const now = new Date('2026-10-14T10:00:00.000Z')

  it('创建 Role 时应用默认值并复制时间和集合', () => {
    const role = createRole({
      id: 'role-001',
      workspaceId: 'workspace-001',
      name: ' 执行者 ',
      now,
    })

    expect(role).toMatchObject({
      id: 'role-001',
      workspaceId: 'workspace-001',
      name: '执行者',
      description: '',
      systemPrompt: '',
      requiredGuidelines: [],
      gates: [],
      outputContract: '',
      blockingConditions: [],
      selectable: true,
      dispatchable: false,
      version: 1,
    })
    expect(role.createdAt).not.toBe(now)
    expect(role.updatedAt).not.toBe(now)
  })

  it('更新 Role 返回新对象并递增 version', () => {
    const role = createRole({
      id: 'role-001',
      workspaceId: 'workspace-001',
      name: '执行者',
      now,
    })
    const updated = updateRole(role, { name: '审查者', dispatchable: true }, new Date(now.getTime() + 1_000))

    expect(updated.name).toBe('审查者')
    expect(updated.dispatchable).toBe(true)
    expect(updated.version).toBe(2)
    expect(role.name).toBe('执行者')
    expect(role.version).toBe(1)
  })

  it('创建 Binding 并拒绝跨 Workspace 引用', () => {
    const binding = createRoleBinding({
      id: 'binding-001',
      workspaceId: 'workspace-001',
      roleId: 'role-001',
      providerConnectionId: 'provider-001',
      modelId: 'model-001',
      now,
    })

    expect(binding).toMatchObject({
      workspaceId: 'workspace-001',
      priority: 0,
      enabled: true,
      runtimeOptions: {},
      version: 1,
    })
    expect(() => assertBindingWorkspaceConsistency(binding, 'workspace-002', 'workspace-001')).toThrowError(
      'RoleBinding 必须引用同一 Workspace',
    )
  })
})
