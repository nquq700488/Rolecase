import { describe, expect, it } from 'vitest'

import {
  addAgentSlotRequestSchema,
  apiErrorSchema,
  capabilitySnapshotSchema,
  codexConfigImportApplyRequestSchema,
  codexConfigImportPreviewSchema,
  codexConfigImportPreviewRequestSchema,
  createCredentialRequestSchema,
  credentialReferenceDtoSchema,
  createRoleBindingRequestSchema,
  createRoleRequestSchema,
  createSessionRequestSchema,
  createWorkspaceRequestSchema,
  eventEnvelopeSchema,
  ERROR_CODES,
  handoffRequestSchema,
  messageDtoSchema,
  permissionAnswerRequestSchema,
  permissionRequestDtoSchema,
  providerConnectionDtoSchema,
  roleBindingDtoSchema,
  roleDtoSchema,
  runCommandSchema,
  runtimeEventSchema,
  sendMessageRequestSchema,
  sessionSnapshotDtoSchema,
  updateRoleBindingRequestSchema,
  updateProviderConnectionRequestSchema,
  updateRoleRequestSchema,
  wsClientMessageSchema,
  setWorkspaceRootPathRequestSchema,
  workspaceRootPathDtoSchema,
  artifactContentDtoSchema,
  artifactDtoSchema,
  artifactPageDtoSchema,
  artifactPageQuerySchema,
  artifactParamsSchema,
  artifactSessionParamsSchema,
  createArtifactRequestSchema,
  mailboxMessageSummaryDtoSchema,
  mailboxPageDtoSchema,
  mailboxPageQuerySchema,
  mailboxMessageDetailDtoSchema,
  mailboxMarkReadRequestSchema,
  mailboxMarkReadDtoSchema,
  mailboxMessageReadEventPayloadSchema,
  mailboxParamsSchema,
  mailboxMessageParamsSchema,
  MAILBOX_ERROR_CODES,
} from './index.js'

describe('Contract Schema', () => {
  it('接受 ProviderConnection 的环境模式和非敏感字段', () => {
    const result = providerConnectionDtoSchema.safeParse({
      id: 'provider-001',
      workspace_id: 'workspace-001',
      provider_kind: 'codex',
      connection_kind: 'custom_endpoint',
      base_url: 'https://example.test/v1',
      credential_ref: 'credential-001',
      environment_mode: 'isolated',
    })

    expect(result.success).toBe(true)
  })

  it('拒绝未知的环境模式', () => {
    const result = providerConnectionDtoSchema.safeParse({
      id: 'provider-001',
      workspace_id: 'workspace-001',
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'global',
    })

    expect(result.success).toBe(false)
  })

  it('保留 adapter_request_id 的 JSON-RPC number / string 类型身份', () => {
    const base = {
      id: 'permission-001',
      run_id: 'run-001',
      task_id: 'task-001',
      slot_id: 'slot-001',
      capability: 'execute',
      description: 'Run a command',
      adapter_options: [{ option_id: 'allow_once', name: 'Yes', kind: 'allow_once' }],
      status: 'pending',
      requested_at: '2026-10-14T10:00:00.000Z',
      soft_timeout_at: '2026-10-14T10:05:00.000Z',
    }

    const numeric = permissionRequestDtoSchema.parse({ ...base, adapter_request_id: 1 })
    const textual = permissionRequestDtoSchema.parse({ ...base, adapter_request_id: '1' })

    expect(numeric.adapter_request_id).toBe(1)
    expect(typeof numeric.adapter_request_id).toBe('number')
    expect(textual.adapter_request_id).toBe('1')
    expect(typeof textual.adapter_request_id).toBe('string')
  })

  it('拒绝空字符串、小数、非有限值和超出安全整数的 adapter_request_id', () => {
    const base = {
      id: 'permission-001',
      run_id: 'run-001',
      task_id: 'task-001',
      slot_id: 'slot-001',
      capability: 'execute',
      description: 'Run a command',
      adapter_options: [{ option_id: 'allow_once', name: 'Yes', kind: 'allow_once' }],
      status: 'pending',
      requested_at: '2026-10-14T10:00:00.000Z',
      soft_timeout_at: '2026-10-14T10:05:00.000Z',
    }

    expect(permissionRequestDtoSchema.safeParse({ ...base, adapter_request_id: '' }).success).toBe(false)
    expect(permissionRequestDtoSchema.safeParse({ ...base, adapter_request_id: 1.5 }).success).toBe(false)
    expect(permissionRequestDtoSchema.safeParse({ ...base, adapter_request_id: Number.NaN }).success).toBe(false)
    expect(permissionRequestDtoSchema.safeParse({ ...base, adapter_request_id: Number.POSITIVE_INFINITY }).success)
      .toBe(false)
    // 超出 MAX_SAFE_INTEGER 的整数无法在 JS 中保真往返，必须拒绝。
    expect(permissionRequestDtoSchema.safeParse({
      ...base,
      adapter_request_id: Number.MAX_SAFE_INTEGER + 1,
    }).success).toBe(false)
  })

  it('接受负 safe integer 与最大 safe integer', () => {
    const base = {
      id: 'permission-001',
      run_id: 'run-001',
      task_id: 'task-001',
      slot_id: 'slot-001',
      capability: 'execute',
      description: 'Run a command',
      adapter_options: [{ option_id: 'allow_once', name: 'Yes', kind: 'allow_once' }],
      status: 'pending',
      requested_at: '2026-10-14T10:00:00.000Z',
      soft_timeout_at: '2026-10-14T10:05:00.000Z',
    }

    for (const value of [-1, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0]) {
      expect(permissionRequestDtoSchema.safeParse({ ...base, adapter_request_id: value }).success).toBe(true)
    }
  })

  it('保留 Adapter 提供的权限选项和超时状态', () => {
    const result = permissionRequestDtoSchema.safeParse({
      id: 'permission-001',
      run_id: 'run-001',
      task_id: 'task-001',
      slot_id: 'slot-001',
      capability: 'execute',
      description: 'Run a command',
      adapter_options: [
        {
          option_id: 'allow_once',
          name: 'Yes, proceed',
          kind: 'allow_once',
        },
      ],
      status: 'pending',
      requested_at: '2026-10-14T10:00:00.000Z',
      soft_timeout_at: '2026-10-14T10:05:00.000Z',
      expires_at: '2026-10-14T10:30:00.000Z',
    })

    expect(result.success).toBe(true)
  })

  it('只接受 pending、answered 和 expired 权限状态', () => {
    const result = permissionRequestDtoSchema.safeParse({
      id: 'permission-001',
      run_id: 'run-001',
      task_id: 'task-001',
      slot_id: 'slot-001',
      capability: 'execute',
      description: 'Run a command',
      adapter_options: [],
      status: 'cancelled',
      requested_at: '2026-10-14T10:00:00.000Z',
      soft_timeout_at: '2026-10-14T10:05:00.000Z',
    })

    expect(result.success).toBe(false)
  })

  it('验证能力快照和事件信封的稳定字段', () => {
    const capabilityResult = capabilitySnapshotSchema.safeParse({
      provider_kind: 'claude',
      adapter_version: '0.90.0',
      source: 'acp_handshake',
      observed_at: '2026-10-14T10:00:00.000Z',
      capabilities: { session_resume: true },
    })
    const eventResult = eventEnvelopeSchema.safeParse({
      event_id: 'event-001',
      schema_version: 1,
      workspace_id: 'workspace-001',
      session_id: 'session-001',
      run_id: 'run-001',
      sequence: 1,
      type: 'agent.permission_requested',
      source: 'acp-runtime',
      occurred_at: '2026-10-14T10:00:00.000Z',
      payload: { permission_id: 'permission-001' },
    })

    expect(capabilityResult.success).toBe(true)
    expect(eventResult.success).toBe(true)
  })

  it('归一化 Runtime Event 但不允许缺少 session_id', () => {
    const valid = runtimeEventSchema.safeParse({
      session_id: 'session-001',
      kind: 'agent_message_chunk',
      payload: { text: 'hello' },
    })
    const invalid = runtimeEventSchema.safeParse({
      kind: 'agent_message_chunk',
      payload: { text: 'hello' },
    })

    expect(valid.success).toBe(true)
    expect(invalid.success).toBe(false)
  })

  it('区分 resume 和 retry 命令', () => {
    const resume = runCommandSchema.safeParse({
      kind: 'resume',
      run_id: 'run-001',
      request_id: 'request-001',
    })
    const retry = runCommandSchema.safeParse({
      kind: 'retry',
      run_id: 'run-001',
      request_id: 'request-002',
    })

    expect(resume.success).toBe(true)
    expect(retry.success).toBe(true)
  })

  it('要求错误信封包含稳定 code、message 和 request_id', () => {
    const result = apiErrorSchema.safeParse({
      code: 'permission_timeout',
      message: '权限请求已过期',
      details: {},
      request_id: 'request-001',
    })

    expect(result.success).toBe(true)
  })

  it('公开 Role Runtime options 与 Context source 的稳定错误码', () => {
    expect(ERROR_CODES.provider_capability_not_supported).toBe('provider_capability_not_supported')
    expect(ERROR_CODES.context_source_missing).toBe('context_source_missing')
  })

  it('创建 Workspace 必须包含非空根目录路径并拒绝未知字段', () => {
    expect(createWorkspaceRequestSchema.safeParse({
      name: '演示工作区',
      root_path: '/tmp/rolecast-workspace',
    }).success).toBe(true)
    expect(createWorkspaceRequestSchema.safeParse({ name: '演示工作区' }).success).toBe(false)
    expect(createWorkspaceRequestSchema.safeParse({
      name: '演示工作区',
      root_path: '',
    }).success).toBe(false)
    expect(createWorkspaceRequestSchema.safeParse({
      name: '演示工作区',
      root_path: '/tmp/rolecast-workspace',
      unexpected: true,
    }).success).toBe(false)
  })

  it('WorkspaceRootPathDto 严格区分未配置与已配置状态', () => {
    expect(workspaceRootPathDtoSchema.safeParse({
      workspace_id: 'workspace-001',
      root_path: null,
    }).success).toBe(true)
    expect(workspaceRootPathDtoSchema.safeParse({
      workspace_id: 'workspace-001',
      root_path: '/srv/rolecast/workspace',
    }).success).toBe(true)
    expect(workspaceRootPathDtoSchema.safeParse({
      workspace_id: 'workspace-001',
      root_path: null,
      extra: true,
    }).success).toBe(false)
  })

  it('补设 Workspace 根目录只接受严格的非空 root_path', () => {
    expect(setWorkspaceRootPathRequestSchema.safeParse({ root_path: '/srv/workspace' }).success).toBe(true)
    expect(setWorkspaceRootPathRequestSchema.safeParse({ root_path: '' }).success).toBe(false)
    expect(setWorkspaceRootPathRequestSchema.safeParse({ root_path: '/srv/workspace', extra: true }).success)
      .toBe(false)
  })

  it('公开 Workspace 根目录稳定错误码', () => {
    expect(ERROR_CODES.workspace_root_required).toBe('workspace_root_required')
    expect(ERROR_CODES.workspace_root_invalid).toBe('workspace_root_invalid')
    expect(ERROR_CODES.workspace_root_duplicate).toBe('workspace_root_duplicate')
    expect(ERROR_CODES.workspace_root_already_configured).toBe('workspace_root_already_configured')
  })

  it('验证 Phase 1A 的 Session 和消息请求', () => {
    const legacySession = {
      name: '第一次对话',
      provider_connection_id: 'provider-001',
      model_id: 'model-001',
    }
    const roleBoundSession = { name: '审查会话', role_binding_id: 'binding-001' }
    expect(createSessionRequestSchema.safeParse(legacySession).success).toBe(true)
    expect(createSessionRequestSchema.safeParse(roleBoundSession).success).toBe(true)
    expect(createSessionRequestSchema.safeParse({
      ...legacySession,
      role_binding_id: 'binding-001',
    }).success).toBe(false)
    expect(createSessionRequestSchema.safeParse({ ...roleBoundSession, unexpected: true }).success).toBe(false)
    expect(sendMessageRequestSchema.safeParse({ content: '请介绍当前目录' }).success).toBe(true)
    expect(sendMessageRequestSchema.safeParse({ content: '' }).success).toBe(false)
  })

  it('新增 Slot 接受可选幂等键且只接受 RoleBinding，消息可选择目标 Slot', () => {
    expect(addAgentSlotRequestSchema.safeParse({ role_binding_id: 'binding-001' }).success).toBe(true)
    expect(addAgentSlotRequestSchema.safeParse({ role_binding_id: 'binding-001', request_id: 'slot-key' }).success).toBe(true)
    expect(addAgentSlotRequestSchema.safeParse({ model_id: 'model-001' }).success).toBe(false)
    expect(sendMessageRequestSchema.safeParse({ content: '分析任务', agent_slot_id: 'slot-002' }).success).toBe(true)
    expect(sendMessageRequestSchema.safeParse({ content: '分析任务' }).success).toBe(true)
  })

  it('handoff Message 元数据与请求契约向后兼容', () => {
    const base = {
      id: 'message-001',
      session_id: 'session-001',
      run_id: 'run-001',
      sender_kind: 'agent' as const,
      sender_id: 'slot-001',
      content: '交接正文',
      created_at: '2026-10-14T10:00:00.000Z',
    }
    // 旧消息省略新字段。
    expect(messageDtoSchema.safeParse(base).success).toBe(true)
    // handoff 必须同时带目标 Slot。
    expect(messageDtoSchema.safeParse({ ...base, kind: 'handoff', to_slot_id: 'slot-002' }).success).toBe(true)
    expect(messageDtoSchema.safeParse({ ...base, kind: 'handoff' }).success).toBe(false)
    expect(handoffRequestSchema.safeParse({
      source_run_id: 'run-001',
      target_slot_id: 'slot-002',
      request_id: 'handoff-key',
    }).success).toBe(true)
    expect(handoffRequestSchema.safeParse({ source_run_id: 'run-001', target_slot_id: '', request_id: '' }).success).toBe(false)
    expect(ERROR_CODES.source_history_unavailable).toBe('source_history_unavailable')
    expect(ERROR_CODES.source_event_payload_too_large).toBe('source_event_payload_too_large')
    expect(ERROR_CODES.handoff_content_too_large).toBe('handoff_content_too_large')
  })

  it('接受可选且非空的 handoff 来源 Task ID', () => {
    const request = {
      source_run_id: 'run-001',
      target_slot_id: 'slot-002',
      request_id: 'handoff-key',
    }
    expect(handoffRequestSchema.safeParse({ ...request, source_task_id: 'task-001' }).success).toBe(true)
    expect(handoffRequestSchema.safeParse({ ...request, source_task_id: '' }).success).toBe(false)
  })

  it('只允许通过选项 ID 回答权限请求', () => {
    expect(permissionAnswerRequestSchema.safeParse({ option_id: 'allow_once' }).success).toBe(true)
    expect(permissionAnswerRequestSchema.safeParse({ option_id: '' }).success).toBe(false)
  })

  it('区分 WebSocket 首帧认证和事件续传控制消息', () => {
    expect(wsClientMessageSchema.safeParse({ type: 'auth', token: 'token-value', workspace_id: 'workspace-001' }).success).toBe(true)
    expect(
      wsClientMessageSchema.safeParse({
        type: 'resume',
        runs: [{ run_id: 'run-001', last_sequence: 4 }],
      }).success,
    ).toBe(true)
    expect(wsClientMessageSchema.safeParse({ type: 'auth', token: '' }).success).toBe(false)
  })

  it('要求综合快照包含重连对账所需的全部状态', () => {
    const result = sessionSnapshotDtoSchema.safeParse({
      session: {
        id: 'session-001',
        workspace_id: 'workspace-001',
        name: '演示会话',
        status: 'active',
        created_at: '2026-10-14T10:00:00.000Z',
        updated_at: '2026-10-14T10:00:00.000Z',
      },
      agent_slots: [],
      runs: [],
      tasks: [],
      messages: [],
      permissions: [],
      latest_sequences: {},
    })

    expect(result.success).toBe(true)
  })

  it('验证 Role 和 RoleBinding 的完整配置契约', () => {
    const role = {
      id: 'role-001',
      workspace_id: 'workspace-001',
      name: '执行者',
      description: '负责实现任务',
      system_prompt: '保持变更最小。',
      required_guidelines: ['先阅读相关文件'],
      gates: ['tests_passed'],
      output_contract: '返回变更摘要',
      blocking_conditions: ['缺少测试证据'],
      selectable: true,
      dispatchable: false,
      version: 1,
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    }
    const binding = {
      id: 'binding-001',
      workspace_id: 'workspace-001',
      role_id: 'role-001',
      provider_connection_id: 'provider-001',
      model_id: 'model-001',
      runtime_options: { effort: 'high', max_output_tokens: 4096, enabled: true },
      priority: 10,
      enabled: true,
      version: 1,
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    }

    expect(roleDtoSchema.safeParse(role).success).toBe(true)
    expect(roleBindingDtoSchema.safeParse(binding).success).toBe(true)
    expect(createRoleRequestSchema.safeParse({ name: '新角色' }).success).toBe(true)
    expect(createRoleBindingRequestSchema.safeParse({
      role_id: 'role-001',
      provider_connection_id: 'provider-001',
      model_id: 'model-001',
    }).success).toBe(true)
    expect(updateRoleRequestSchema.safeParse({ version: 1, name: '更新后的角色' }).success).toBe(true)
    expect(updateRoleBindingRequestSchema.safeParse({ version: 1, enabled: false }).success).toBe(true)
  })

  it('拒绝 Role 的空 PATCH、未知字段和 runtime_options 敏感键', () => {
    expect(updateRoleRequestSchema.safeParse({ version: 1 }).success).toBe(false)
    expect(updateRoleRequestSchema.safeParse({ version: 1, unknown: true }).success).toBe(false)
    for (const key of ['api_key', 'api.key', 'auth-token', 'authToken', 'authorization', 'clientsecret', 'privateKey', 'sshPrivateKey', 'clientKey']) {
      expect(createRoleBindingRequestSchema.safeParse({
        role_id: 'role-001',
        provider_connection_id: 'provider-001',
        model_id: 'model-001',
        runtime_options: { [key]: 'secret' },
      }).success).toBe(false)
    }
  })

  it('拒绝带凭据或查询参数的 Provider Base URL', () => {
    const baseConnection = {
      id: 'provider-001',
      workspace_id: 'workspace-001',
      provider_kind: 'codex',
      connection_kind: 'custom_endpoint',
      environment_mode: 'inherited',
      config_revision: 1,
    }
    expect(providerConnectionDtoSchema.safeParse({
      ...baseConnection,
      base_url: 'https://user:password@example.test/v1',
    }).success).toBe(false)
    expect(providerConnectionDtoSchema.safeParse({
      ...baseConnection,
      base_url: 'https://example.test/v1?token=secret',
    }).success).toBe(false)
  })

  it('约束 Codex 配置导入 preview/apply 的确认和非秘密字段', () => {
    expect(codexConfigImportPreviewRequestSchema.safeParse({ source_path: '/Users/test/.codex/config.toml' }).success).toBe(true)
    const preview = codexConfigImportPreviewSchema.safeParse({
      preview_id: 'preview-001',
      provider_id: 'provider-001',
      workspace_id: 'workspace-001',
      source_name: 'config.toml',
      source_digest: 'a'.repeat(64),
      target_config_revision: 1,
      base_url: 'https://gateway.example.test/v1',
      codex_config: {
        model_provider: 'rolecast',
        model: 'gpt-test',
        wire_api: 'responses',
        reasoning_effort: 'medium',
      },
      models: [{ model_id: 'gpt-test', display_name: 'gpt-test' }],
      warnings: ['已忽略配置中的凭据字段'],
    })
    expect(preview.success).toBe(true)
    expect(codexConfigImportApplyRequestSchema.safeParse({
      preview_id: 'preview-001',
      confirmed: true,
      target_config_revision: 1,
      credential_ref: 'credential-001',
    }).success).toBe(true)
    expect(codexConfigImportApplyRequestSchema.safeParse({
      preview_id: 'preview-001',
      confirmed: false,
      target_config_revision: 1,
    }).success).toBe(false)
    expect(codexConfigImportPreviewSchema.safeParse({
      preview_id: 'preview-001',
      provider_id: 'provider-001',
      workspace_id: 'workspace-001',
      source_name: 'config.toml',
      source_digest: 'a'.repeat(64),
      target_config_revision: 1,
      codex_config: { api_key: 'secret' },
      models: [],
      warnings: [],
    }).success).toBe(false)
  })

  it('Provider 非秘密更新请求只接受白名单字段并强制 revision', () => {
    expect(updateProviderConnectionRequestSchema.safeParse({
      connection_kind: 'custom_endpoint',
      environment_mode: 'isolated',
      base_url: 'https://gateway.example.test/v1',
      credential_ref: 'credential-001',
      config_revision: 2,
    }).success).toBe(true)

    // null 用于清空。
    expect(updateProviderConnectionRequestSchema.safeParse({
      base_url: null,
      credential_ref: null,
      config_revision: 2,
    }).success).toBe(true)

    // codex_config 只接受 null（清除），不接受任意写入。
    expect(updateProviderConnectionRequestSchema.safeParse({
      codex_config: null,
      config_revision: 2,
    }).success).toBe(true)
  })

  it('Provider 更新请求拒绝 Secret/token 字段、codex_config 与缺失 revision', () => {
    for (const payload of [
      { api_key: 'x', config_revision: 1 },
      { token: 'x', config_revision: 1 },
      { secret: 'x', config_revision: 1 },
      { codex_config: { model: 'gpt-test' }, config_revision: 1 },
      { codex_config: 'gpt-test', config_revision: 1 },
      { connection_kind: 'local' },
      { config_revision: 1 },
    ]) {
      expect(updateProviderConnectionRequestSchema.safeParse(payload).success).toBe(false)
    }
  })

  it('凭据创建请求接受普通 API key 和 UUID 幂等键', () => {
    expect(createCredentialRequestSchema.safeParse({
      idempotency_key: '7d444840-9dc0-11d1-b245-5ffdce74fad2',
      secret: 'sk-synthetic-test-value',
    }).success).toBe(true)
  })

  it('凭据创建请求拒绝非法幂等键、非法 Secret 和未知字段', () => {
    const validKey = '7d444840-9dc0-11d1-b245-5ffdce74fad2'
    for (const payload of [
      { idempotency_key: 'not-a-uuid', secret: 'sk-test' },
      { idempotency_key: validKey, secret: '' },
      { idempotency_key: validKey, secret: 'line1\nline2' },
      { idempotency_key: validKey, secret: 'line1\rline2' },
      { idempotency_key: validKey, secret: 'x'.repeat(64 * 1024 + 1) },
      { idempotency_key: validKey, secret: 'sk-test', request_id: validKey },
      { secret: 'sk-test' },
      { idempotency_key: validKey },
      { idempotency_key: validKey, secret: 'sk-test', credential_ref: 'credential-001' },
    ]) {
      expect(createCredentialRequestSchema.safeParse(payload).success).toBe(false)
    }
  })

  it('凭据创建响应只包含 credential_ref', () => {
    expect(credentialReferenceDtoSchema.safeParse({ credential_ref: 'credential-001' }).success).toBe(true)
    expect(credentialReferenceDtoSchema.safeParse({
      credential_ref: 'credential-001',
      secret: 'sk-test',
    }).success).toBe(false)
    expect(credentialReferenceDtoSchema.safeParse({ credential_ref: '' }).success).toBe(false)
  })

  it('Provider 更新请求拒绝带凭据或 query 的 base_url', () => {
    for (const baseUrl of [
      'https://user:pass@gateway.example.test/v1',
      'https://gateway.example.test/v1?token=x',
      'ftp://gateway.example.test/v1',
    ]) {
      expect(updateProviderConnectionRequestSchema.safeParse({
        base_url: baseUrl,
        config_revision: 1,
      }).success).toBe(false)
    }
  })

  it('Artifact 创建请求只接受来源 Run 与 request_id', () => {
    expect(createArtifactRequestSchema.safeParse({
      source_run_id: 'run-001',
      request_id: 'request-001',
    }).success).toBe(true)

    for (const payload of [
      { source_run_id: 'run-001' },
      { request_id: 'request-001' },
      { source_run_id: '', request_id: 'request-001' },
      { source_run_id: 'run-001', request_id: 'request-001', task_id: 'task-001' },
    ]) {
      expect(createArtifactRequestSchema.safeParse(payload).success).toBe(false)
    }
  })

  it('Artifact 路由参数为 strict 且要求非空标识符', () => {
    expect(artifactSessionParamsSchema.safeParse({ sessionId: 'session-001' }).success).toBe(true)
    expect(artifactParamsSchema.safeParse({ sessionId: 'session-001', artifactId: 'artifact-001' }).success).toBe(true)
    expect(artifactSessionParamsSchema.safeParse({ sessionId: '' }).success).toBe(false)
    expect(artifactParamsSchema.safeParse({ sessionId: 'session-001', artifactId: '' }).success).toBe(false)
    expect(artifactParamsSchema.safeParse({ sessionId: 'session-001', artifactId: 'artifact-001', extra: true }).success).toBe(false)
  })

  it('Artifact metadata 只接受 inline 元数据并限制 SHA-256 与字节大小', () => {
    const metadata = {
      id: 'artifact-001',
      workspace_id: 'workspace-001',
      session_id: 'session-001',
      task_id: 'task-001',
      source_run_id: 'run-001',
      media_type: 'text/plain; charset=utf-8',
      storage_kind: 'inline',
      status: 'ready',
      size_bytes: 65_536,
      sha256: 'a'.repeat(64),
      created_at: '2026-11-04T10:00:00.000Z',
    }

    expect(artifactDtoSchema.safeParse(metadata).success).toBe(true)
    expect(artifactDtoSchema.safeParse({ ...metadata, content_ref: 'artifacts/a.txt' }).success).toBe(false)
    expect(artifactDtoSchema.safeParse({ ...metadata, size_bytes: 65_537 }).success).toBe(false)
    expect(artifactDtoSchema.safeParse({ ...metadata, sha256: 'not-a-digest' }).success).toBe(false)
  })

  it('Artifact 内容 DTO 独立返回文本且错误码保持稳定', () => {
    expect(artifactContentDtoSchema.safeParse({
      artifact_id: 'artifact-001',
      media_type: 'text/plain; charset=utf-8',
      content: '脱敏后的正文',
    }).success).toBe(true)
    expect(artifactContentDtoSchema.safeParse({
      artifact_id: 'artifact-001',
      media_type: 'text/plain; charset=utf-8',
      content: '脱敏后的正文',
      sha256: 'a'.repeat(64),
    }).success).toBe(false)
    expect(ERROR_CODES.artifact_unavailable).toBe('artifact_unavailable')
    expect(ERROR_CODES.artifact_sanitization_failed).toBe('artifact_sanitization_failed')
  })

  it('Artifact 分页查询默认 limit=50、最大 100，且响应只包含 metadata', () => {
    expect(artifactPageQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(artifactPageQuerySchema.parse({ limit: '100', cursor: 'artifact-001' })).toEqual({
      limit: 100,
      cursor: 'artifact-001',
    })
    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { limit: 'not-a-number' },
      { cursor: '' },
      { content: 'must-not-be-listed' },
    ]) {
      expect(artifactPageQuerySchema.safeParse(query).success).toBe(false)
    }

    const metadata = {
      id: 'artifact-001',
      workspace_id: 'workspace-001',
      session_id: 'session-001',
      task_id: 'task-001',
      source_run_id: 'run-001',
      media_type: 'text/plain; charset=utf-8',
      storage_kind: 'inline',
      status: 'ready',
      size_bytes: 4,
      sha256: 'a'.repeat(64),
      created_at: '2026-11-04T10:00:00.000Z',
    }
    expect(artifactPageDtoSchema.safeParse({ items: [metadata], next_cursor: null }).success).toBe(true)
    expect(artifactPageDtoSchema.safeParse({
      items: [{ ...metadata, content: 'body' }],
      next_cursor: null,
    }).success).toBe(false)
    expect(artifactPageDtoSchema.safeParse({ items: [], next_cursor: 'artifact-001', extra: true }).success)
      .toBe(false)
  })

  it('Mailbox 分页查询有默认上限且拒绝非法参数', () => {
    expect(mailboxPageQuerySchema.parse({ slot_id: 'slot-001' })).toEqual({
      slot_id: 'slot-001',
      limit: 50,
    })
    expect(mailboxPageQuerySchema.parse({ slot_id: 'slot-001', limit: '100', cursor: 'message-001' })).toEqual({
      slot_id: 'slot-001',
      limit: 100,
      cursor: 'message-001',
    })
    for (const query of [
      { slot_id: 'slot-001', limit: '0' },
      { slot_id: 'slot-001', limit: '101' },
      { slot_id: 'slot-001', limit: 'not-a-number' },
      { slot_id: 'slot-001', cursor: '' },
      { slot_id: 'slot-001', unexpected: 'value' },
    ]) {
      expect(mailboxPageQuerySchema.safeParse(query).success).toBe(false)
    }
  })

  it('Mailbox 摘要状态与 read_at 一致且不包含正文', () => {
    const summary = {
      id: 'message-001',
      session_id: 'session-001',
      sender_id: 'slot-001',
      to_slot_id: 'slot-002',
      created_at: '2026-11-04T10:00:00.000Z',
      status: 'unread',
      read_at: null,
    }
    expect(mailboxMessageSummaryDtoSchema.safeParse(summary).success).toBe(true)
    expect(mailboxMessageSummaryDtoSchema.safeParse({
      ...summary,
      status: 'read',
      read_at: '2026-11-04T10:01:00.000Z',
    }).success).toBe(true)
    expect(mailboxMessageSummaryDtoSchema.safeParse({ ...summary, read_at: '2026-11-04T10:01:00.000Z' }).success)
      .toBe(false)
    expect(mailboxMessageSummaryDtoSchema.safeParse({ ...summary, content: '正文不可出现在摘要' }).success)
      .toBe(false)
    expect(mailboxMessageSummaryDtoSchema.safeParse({ ...summary, status: 'delivered' }).success).toBe(false)

    expect(mailboxPageDtoSchema.safeParse({ items: [summary], next_cursor: 'message-001' }).success).toBe(true)
    expect(mailboxPageDtoSchema.safeParse({ items: [], next_cursor: null }).success).toBe(true)
    expect(mailboxPageDtoSchema.safeParse({ items: [], next_cursor: null, unread_count: 1 }).success).toBe(false)
  })

  it('Mailbox 详情、标记已读及 message.read Event 使用严格的 metadata 契约', () => {
    const timestamp = '2026-11-04T10:01:00.000Z'
    const detail = {
      message: {
        id: 'message-001',
        session_id: 'session-001',
        run_id: 'run-001',
        sender_kind: 'agent',
        sender_id: 'slot-001',
        content: '仅在详情中返回的正文',
        created_at: '2026-11-04T10:00:00.000Z',
        kind: 'handoff',
        to_slot_id: 'slot-002',
      },
      status: 'read',
      read_at: timestamp,
    }
    expect(mailboxMessageDetailDtoSchema.safeParse(detail).success).toBe(true)
    expect(mailboxMessageDetailDtoSchema.safeParse({ ...detail, status: 'unread' }).success).toBe(false)
    expect(mailboxMarkReadRequestSchema.safeParse({ slot_id: 'slot-002' }).success).toBe(true)
    expect(mailboxMarkReadRequestSchema.safeParse({ slot_id: 'slot-002', content: 'unexpected' }).success).toBe(false)
    expect(mailboxMarkReadDtoSchema.safeParse({
      message_id: 'message-001',
      status: 'read',
      read_at: timestamp,
      event_bus_status: 'failed',
    }).success).toBe(true)
    expect(mailboxMarkReadDtoSchema.safeParse({
      message_id: 'message-001',
      status: 'unread',
      read_at: null,
      event_bus_status: 'published',
    }).success).toBe(false)
    expect(mailboxMessageReadEventPayloadSchema.safeParse({
      message_id: 'message-001',
      recipient_slot_id: 'slot-002',
      read_at: timestamp,
    }).success).toBe(true)
    expect(mailboxMessageReadEventPayloadSchema.safeParse({
      message_id: 'message-001',
      recipient_slot_id: 'slot-002',
      read_at: timestamp,
      content: '正文不能进入事件',
    }).success).toBe(false)
    expect(mailboxParamsSchema.safeParse({ sessionId: 'session-001' }).success).toBe(true)
    expect(mailboxMessageParamsSchema.safeParse({ sessionId: 'session-001', messageId: 'message-001' }).success)
      .toBe(true)
    expect(MAILBOX_ERROR_CODES.mailbox_message_unavailable).toBe('mailbox_message_unavailable')
  })
})
