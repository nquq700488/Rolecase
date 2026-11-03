import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  RoleConfigConflictError,
  RoleConfigResourceInUseError,
  RoleConfigResourceMissingError,
} from '../../application/ports/role-config-repository-port.js'
import { JsonWorkspaceConfig } from './json-workspace-config.js'
import { JsonRoleConfigRepository } from './json-role-config-repository.js'

const now = '2026-10-14T10:00:00.000Z'

const role = (workspaceId: string, id: string, name: string): Parameters<JsonRoleConfigRepository['createRole']>[0] => ({
  id,
  workspace_id: workspaceId,
  name,
  description: '',
  system_prompt: '',
  required_guidelines: [],
  gates: [],
  output_contract: '',
  blocking_conditions: [],
  selectable: true,
  dispatchable: false,
  version: 1,
  created_at: now,
  updated_at: now,
})

const binding = (workspaceId: string, id: string, roleId: string): Parameters<JsonRoleConfigRepository['createBinding']>[0] => ({
  id,
  workspace_id: workspaceId,
  role_id: roleId,
  provider_connection_id: 'provider-001',
  model_id: 'model-001',
  runtime_options: { effort: 'high' },
  priority: 0,
  enabled: true,
  version: 1,
  created_at: now,
  updated_at: now,
})

describe('JsonRoleConfigRepository', () => {
  it('按 Workspace 隔离 Role 并支持 version 更新', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rolecast-role-config-'))
    const repository = new JsonRoleConfigRepository(new JsonWorkspaceConfig(root))
    const created = await repository.createRole(role('workspace-001', 'role-001', '执行者'))

    expect(await repository.listRoles('workspace-001')).toEqual([created])
    expect(await repository.listRoles('workspace-002')).toEqual([])
    const updated = await repository.updateRole({ ...created, name: '审查者', version: 2, updated_at: now }, 1)
    expect(updated?.name).toBe('审查者')
    await expect(repository.updateRole({ ...created, name: '覆盖', version: 2, updated_at: now }, 1))
      .rejects.toBeInstanceOf(RoleConfigConflictError)
  })

  it('getBindingWithRole 用一次配置读取返回配套的 Role 与 Binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rolecast-role-config-snapshot-'))
    class CountingConfig extends JsonWorkspaceConfig {
      reads = 0
      override async read(workspaceId: string) {
        this.reads += 1
        return super.read(workspaceId)
      }
    }
    const config = new CountingConfig(root)
    const repository = new JsonRoleConfigRepository(config)
    const createdRole = await repository.createRole(role('workspace-001', 'role-001', '执行者'))
    const createdBinding = await repository.createBinding(
      binding('workspace-001', 'binding-001', createdRole.id),
      async () => undefined,
    )
    config.reads = 0

    await expect(repository.getBindingWithRole('workspace-001', createdBinding.id)).resolves.toEqual({
      binding: createdBinding,
      role: createdRole,
    })
    expect(config.reads).toBe(1)
    // 跨 Workspace 读取不能看到该配置。
    await expect(repository.getBindingWithRole('workspace-002', createdBinding.id)).resolves.toBeNull()
  })

  it('Role 被 Binding 引用时拒绝删除', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rolecast-role-config-'))
    const repository = new JsonRoleConfigRepository(new JsonWorkspaceConfig(root))
    const created = await repository.createRole(role('workspace-001', 'role-001', '执行者'))
    await repository.createBinding(binding('workspace-001', 'binding-001', created.id), async () => undefined)

    await expect(repository.deleteRole(created.id, 1)).rejects.toBeInstanceOf(RoleConfigResourceInUseError)
    await expect(repository.getBinding('binding-001')).resolves.toMatchObject({ role_id: created.id })
  })

  it('在同一 mutation 临界区执行 Binding 引用校验', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rolecast-role-config-'))
    const repository = new JsonRoleConfigRepository(new JsonWorkspaceConfig(root))
    const created = await repository.createRole(role('workspace-001', 'role-001', '执行者'))

    await expect(repository.createBinding(
      binding('workspace-001', 'binding-001', created.id),
      async (context) => {
        expect(context.roles.some((item) => item.id === created.id)).toBe(true)
        throw new RoleConfigResourceMissingError('测试引用校验失败')
      },
    )).rejects.toBeInstanceOf(RoleConfigResourceMissingError)
    await expect(repository.listBindings('workspace-001')).resolves.toEqual([])
  })

  it('并发删除 Role 与创建 Binding 不会留下悬空引用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rolecast-role-config-'))
    const repository = new JsonRoleConfigRepository(new JsonWorkspaceConfig(root))
    const created = await repository.createRole(role('workspace-001', 'role-001', '执行者'))
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const validatorEntered = new Promise<void>((resolve) => { entered = resolve })
    const createPromise = repository.createBinding(
      binding('workspace-001', 'binding-001', created.id),
      async () => {
        entered()
        await gate
      },
    )
    await validatorEntered
    const deletePromise = repository.deleteRole(created.id, 1)
    release()
    await createPromise
    await expect(deletePromise).rejects.toBeInstanceOf(RoleConfigConflictError)
    await expect(repository.getBinding('binding-001')).resolves.toMatchObject({ role_id: created.id })
  })
})
