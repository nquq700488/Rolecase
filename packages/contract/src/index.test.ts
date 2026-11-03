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

  it('验证 Phase 1A 的 Workspace、Session 和消息请求', () => {
    expect(createWorkspaceRequestSchema.safeParse({ name: '演示工作区' }).success).toBe(true)
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
})
