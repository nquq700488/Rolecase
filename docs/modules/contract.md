# Contract 模块

## 目标

定义前后端、客户端和事件流之间的稳定数据契约。

## 对外提供的能力

- REST 请求和响应 Schema；
- WebSocket 事件 Schema；
- DTO 枚举、错误码、分页结构；
- 边界输入验证；
- Schema 版本管理。

## 公共接口

```text
parseRequest(schema, input)
serializeResponse(schema, value)
parseEvent(input)
```

主要 DTO：

```text
WorkspaceDto
PermissionPolicyDto
ProviderDefinitionDto
ProviderConnectionDto
ConfigImportDraftDto
ModelCatalogEntryDto
MessageDto
RoleDto
RoleBindingDto
SessionDto
AgentSlotDto
WorkflowDto
TaskDto
ArtifactDto
RunDto
EventDto
PermissionRequestDto
ApiErrorDto
```

`ProviderConnectionDto.environment_mode` 只能为 `inherited` 或 `isolated`；`ProviderConnectionDto.codex_config` 只允许非秘密 Codex 字段，`config_revision` 由 SQLite 条件更新维护；`PermissionRequestDto.status` 只能为 `pending`、`answered` 或 `expired`。配置导入 preview/apply 的请求和响应必须经过严格 Schema 校验。

Session 创建请求由 `createSessionRequestSchema` 验证为两个互斥的 strict 形状之一：旧路径 `{ name, provider_connection_id, model_id }`，或 RoleBinding 路径 `{ name, role_binding_id }`。混合字段、未知字段及缺失必需字段均拒绝；RoleBinding 的 Workspace 归属和运行资格由 Application 校验。该联合输入不改变 `SessionDto` 或创建响应形状。

`RoleDto` 包含 Role 文本、guidelines、gates、output contract、blocking conditions、selectable、dispatchable 和 version；`RoleBindingDto` 包含 Role、ProviderConnection、Model 引用、浅层受限 `runtime_options`、priority、enabled 和 version。Role/Binding 的 PATCH 必须携带当前 version，未知字段、无界长文本、超限数组和敏感 runtime option 必须拒绝。`ConfigImportDraftDto` 只允许非秘密字段，不能包含 API Key、OAuth Token、原始配置文件内容或本地凭据路径。

### 第一阶段契约基线

```text
ApiError
├── code: snake_case
├── message: 中文用户可见消息
├── details: 脱敏结构化信息
└── request_id

ProviderConnectionDto
├── id / workspace_id
├── provider_kind: claude | codex
├── connection_kind: local | api_key | custom_endpoint
├── base_url?
├── credential_ref?
├── codex_config?（仅非秘密字段）
├── config_revision
└── environment_mode: inherited | isolated

CodexConfigImportPreview
├── preview_id / provider_id / workspace_id
├── source_name / source_digest
├── target_config_revision
├── base_url? / codex_config / models[]
└── warnings[]

CodexConfigImportApplyRequest
└── preview_id / confirmed=true / target_config_revision / credential_ref?

PermissionRequestDto
├── id / run_id / task_id / slot_id
├── capability / description
├── adapter_options[]
├── status: pending | answered | expired
├── requested_at / soft_timeout_at
├── overdue_at? / expires_at? / expired_at?
├── selected_option_id?
├── adapter_request_id?（ACP JSON-RPC request ID，保留 number / string 原始类型）
└── expiration_reason?: timeout | runtime_unavailable | cancelled（当前 schema 已含 cancelled）

SessionSnapshotDto
├── session / agent_slots / runs / tasks
├── messages / permissions
└── latest_sequences: run_id → sequence

WsClientMessage
├── auth: token + workspace_id（首帧，仅 WebSocket，不进 URL）
└── resume: runs[]（run_id + last_sequence）

WsServerControl
└── authenticated | snapshot_required(session_id)

RunCommand
├── start | cancel | resume | retry
├── run_id
└── request_id

EventEnvelope
├── event_id / schema_version
├── workspace_id / session_id / run_id
├── sequence / type / source
├── occurred_at
└── payload
```

`resume` 复用当前 Run，`retry` 创建新的 attempt；两者必须使用不同的 Application Command 和审计事件。所有响应和事件都必须先通过 Schema 校验，再进入 Store 或 WebSocket。

## 不提供的能力

- 不执行数据库操作；
- 不启动 Agent；
- 不保存密钥；
- 不包含领域业务规则；
- 不导入 ACP SDK。

## 依赖

允许依赖：Schema 库、纯类型工具。

禁止依赖：domain、application、SQLite、HTTP Server、Vue 组件。

## 升级策略

- 新字段必须向后兼容；
- 删除字段先经历 deprecated 周期；
- 事件必须带 `schema_version`；
- DTO 与 Domain Entity 通过 Mapper 转换，不能直接复用。

## 输入、输出和错误

输入是外部请求或事件 payload；输出是经过 Schema 验证的 DTO；错误统一返回字段校验错误和 schema_version 不兼容错误。

## 状态和不变量

Schema 版本必须可识别；未知必填字段和非法枚举必须拒绝；解析不能修改输入对象。

## 持久化

无。Contract 只负责运行时解析和序列化。

## 事件

定义事件 envelope 和 payload Schema，不发布事件。

## 安全边界

拒绝未验证的外部输入；错误 details 不回显密钥或内部堆栈。

## 替换和升级策略

新增字段向后兼容；删除字段经过 deprecated 周期；Schema 变更必须增加契约测试。

## 已知限制

Contract 不负责语义级业务校验，语义校验由 Domain 和 Application 完成。

## 测试

- 合法和非法输入；
- 旧版本 payload 兼容；
- 序列化往返；
- 错误码稳定性；
- 事件 Schema 版本。

## Web Phase 2/3 目标契约（未实现）

目标态（见 `docs/architecture/Stage0-Web-Phase2-3-ADR.md`）：`TaskStatus` 增加 `starting`、`blocked`；`RunStatus` 不增加 `blocked`。新增 `WorkspaceRootPathDto`（保持旧 `WorkspaceDto` 形状）、Workspace 创建 `root_path` 与一次性补设请求、handoff `source_task_id`、Artifact/Workflow/Mailbox DTO 及错误码。当前 v1 Contract 未包含这些字段，旧客户端严格解析行为保持不变。
