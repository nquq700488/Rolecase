import { describe, expect, it } from 'vitest'

import type { AgentSlotRoleSnapshotRecord, ContextSourceRecord } from '../ports/repository-port.js'
import { buildContextBundle } from './context-builder.js'

const timestamp = '2026-10-14T10:00:00.000Z'
const roleSnapshot: AgentSlotRoleSnapshotRecord = {
  slot_id: 'slot-002',
  workspace_id: 'workspace-001',
  role_binding_id: 'binding-002',
  role_binding_version: 3,
  role_id: 'role-002',
  role_version: 2,
  role_name: '审查者',
  system_prompt: '找出可复现的问题',
  required_guidelines: ['引用文件', '说明证据'],
  output_contract: '列出文件与行号',
  created_at: timestamp,
}

const roleSources = (taskId: string, messageId: string): ContextSourceRecord[] => [
  { task_id: taskId, source_type: 'role', source_id: roleSnapshot.role_id, source_version: 2, created_at: timestamp },
  { task_id: taskId, source_type: 'role_binding', source_id: roleSnapshot.role_binding_id, source_version: 3, created_at: timestamp },
  { task_id: taskId, source_type: 'message', source_id: messageId, source_version: 1, created_at: timestamp },
]

describe('ContextBundle builder', () => {
  it('以稳定顺序组合 Role 指令与原始 Task input', () => {
    const taskInput = '审查这段实现'
    const bundle = buildContextBundle({
      taskId: 'task-001',
      messageId: 'message-001',
      taskInput,
      roleSnapshot,
      sources: roleSources('task-001', 'message-001'),
    })

    expect(bundle).toEqual({
      system_instructions: '找出可复现的问题\n\nGuidelines:\n- 引用文件\n- 说明证据',
      task_input: taskInput,
      referenced_artifacts: [],
      session_summary: '',
      constraints: [],
      output_contract: '列出文件与行号',
    })
    expect(taskInput).toBe('审查这段实现')
  })

  it('拒绝缺失或版本不匹配的 ContextSource', () => {
    expect(() => buildContextBundle({
      taskId: 'task-001',
      messageId: 'message-001',
      taskInput: '审查',
      roleSnapshot,
      sources: roleSources('task-001', 'message-other'),
    })).toThrowError(expect.objectContaining({ code: 'context_source_missing' }))

    expect(() => buildContextBundle({
      taskId: 'task-001',
      messageId: 'message-001',
      taskInput: '审查',
      roleSnapshot,
      sources: roleSources('task-001', 'message-001').map((source) =>
        source.source_type === 'role' ? { ...source, source_version: 1 } : source),
    })).toThrowError(expect.objectContaining({ code: 'context_source_missing' }))
  })

  it('旧的无 Role Slot 只包含原始消息', () => {
    expect(buildContextBundle({
      taskId: 'task-legacy',
      messageId: 'message-legacy',
      taskInput: '普通用户输入',
      roleSnapshot: null,
      sources: [{
        task_id: 'task-legacy',
        source_type: 'message',
        source_id: 'message-legacy',
        source_version: 1,
        created_at: timestamp,
      }],
    })).toEqual({
      system_instructions: '',
      task_input: '普通用户输入',
      referenced_artifacts: [],
      session_summary: '',
      constraints: [],
      output_contract: '',
    })
  })
})
