import type { AgentSlotRoleSnapshotRecord, ContextSourceRecord } from '../ports/repository-port.js'
import { ApplicationError } from '../errors.js'

/** AgentRuntimePort 接收的结构化上下文；渲染文本不持久化。 */
export interface ContextBundle {
  readonly system_instructions: string
  readonly task_input: string
  readonly referenced_artifacts: readonly string[]
  readonly session_summary: string
  readonly constraints: readonly string[]
  readonly output_contract: string
}

export interface BuildContextBundleInput {
  readonly taskId: string
  readonly messageId: string
  readonly taskInput: string
  readonly roleSnapshot: AgentSlotRoleSnapshotRecord | null
  readonly sources: readonly ContextSourceRecord[]
}

/**
 * @name buildContextBundle
 * @description 验证持久化 ContextSource 后，从 Slot 固定快照与原始消息构造最小 ContextBundle
 * @param {BuildContextBundleInput} input Task、消息、Role snapshot 与来源引用
 * @return {ContextBundle} 可交给通用 AgentRuntimePort 的上下文结构
 * @example buildContextBundle({ taskId, messageId, taskInput, roleSnapshot: null, sources }).task_input
 */
export function buildContextBundle(input: BuildContextBundleInput): ContextBundle {
  const expectedSources: Array<Pick<ContextSourceRecord, 'source_type' | 'source_id' | 'source_version'>> = [
    { source_type: 'message', source_id: input.messageId, source_version: 1 },
  ]
  if (input.roleSnapshot !== null) {
    expectedSources.push(
      {
        source_type: 'role',
        source_id: input.roleSnapshot.role_id,
        source_version: input.roleSnapshot.role_version,
      },
      {
        source_type: 'role_binding',
        source_id: input.roleSnapshot.role_binding_id,
        source_version: input.roleSnapshot.role_binding_version,
      },
    )
  }
  const sourcesMatch = input.sources.length === expectedSources.length
    && expectedSources.every((expected) => input.sources.some((source) =>
      source.task_id === input.taskId
      && source.source_type === expected.source_type
      && source.source_id === expected.source_id
      && source.source_version === expected.source_version))
  if (!sourcesMatch) {
    throw new ApplicationError('Context source 缺失或版本不匹配', 'context_source_missing', 409)
  }

  if (input.roleSnapshot === null) {
    return {
      system_instructions: '',
      task_input: input.taskInput,
      referenced_artifacts: [],
      session_summary: '',
      constraints: [],
      output_contract: '',
    }
  }

  const guidelines = input.roleSnapshot.required_guidelines.length === 0
    ? ''
    : `Guidelines:\n${input.roleSnapshot.required_guidelines.map((guideline) => `- ${guideline}`).join('\n')}`
  const systemInstructions = [input.roleSnapshot.system_prompt, guidelines]
    .filter((section) => section.length > 0)
    .join('\n\n')

  return {
    system_instructions: systemInstructions,
    task_input: input.taskInput,
    referenced_artifacts: [],
    session_summary: '',
    constraints: [],
    output_contract: input.roleSnapshot.output_contract,
  }
}
