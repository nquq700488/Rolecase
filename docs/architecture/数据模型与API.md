# 数据模型与 API

> 本文定义第一阶段的领域实体、状态、关系和 HTTP/WS 契约。具体 DTO Schema 应在 `packages/contract` 中实现。

## 1. Workspace

```text
Workspace
├── id
├── name
├── root_path
├── config_path
├── state_path
├── permission_policy
├── created_at
├── updated_at
└── status
```

`permission_policy` 默认值：

```text
soft_timeout_ms: 300000       # 5 分钟，仅提醒
hard_timeout_ms: 1800000      # 30 分钟，过期并中断；可显式关闭
hard_timeout_action: expire_and_interrupt
```

约束：

- `root_path` nullable：新建 Workspace 必须由用户明确提供现存目录绝对路径；迁移后的旧 Workspace 保持 NULL，禁止从 cwd 或数据库位置推断；
- Application filesystem Port 校验服务端可访问性并保存 canonical path；配置路径不创建目录、不读取目录内容；
- canonical path 全局唯一，由 SQLite 非 NULL 唯一索引兜底；旧 Workspace 只允许通过 CAS 执行一次 NULL→path 补设；
- 文件访问不得超出 Workspace 根路径，除非用户显式授权；此配置校验不代表 Artifact 文件操作已通过目录句柄安全 Gate；
- 删除 Workspace 不默认删除源代码，只删除 Rolecast 管理的状态。

`WorkspaceDto` 不包含 `root_path`；独立 `WorkspaceRootPathDto { workspace_id, root_path: string | null }` 由根路径 API 返回。

## 2. ProviderDefinition

```text
ProviderDefinition
├── kind: claude | codex
├── display_name
├── adapter_package
├── supported_connection_kinds[]
└── enabled
```

ProviderDefinition 是系统内置的 Provider 类型，不保存用户密钥，也不属于某一个 Workspace。第一阶段只内置 Claude 和 Codex。

## 3. ProviderConnection

```text
ProviderConnection
├── id
├── workspace_id
├── provider_kind: claude | codex
├── connection_kind: local | api_key | custom_endpoint
├── adapter_version
├── base_url
├── credential_ref
├── local_config_source
├── codex_config?（非秘密字段）
├── config_revision
├── environment_mode: inherited | isolated
├── enabled
├── created_at
└── updated_at
```

凭据只保存 `credential_ref`，不进入 DTO、日志或普通 JSON。

`environment_mode` 默认为 `inherited`。设为 `isolated` 时，运行时状态目录由 Rolecast 在 Workspace 的 `.rolecast/runtime/` 下派生；不得把用户全局配置目录作为软链接或隐式配置源。Claude 可以直接使用环境凭据启用隔离，Codex 必须先完成非秘密配置导入；登录态不能静默复制，isolated 只接受 API key 的 `credential_ref`。

创建与运行可运行性是两件事：Claude 的 isolated 连接可以直接通过创建接口建立（`api_key` / `custom_endpoint` 需 `credential_ref`，后者还需 `base_url`；`local` 可无引用保存为待配置），创建时只 `validate` 引用、不读取 Secret；Codex isolated 只能由 Codex 配置导入 apply 写入。能否运行由组合判定在 test / discover / Session 入口决定，`credential_ref` 仍只允许出现在 `isolated`。

## 4. ModelCatalogEntry

```text
ModelCatalogEntry
├── id
├── provider_connection_id
├── provider_model_id
├── display_name
├── source
├── capabilities
├── context_limit
├── effort_options
├── available
├── observed_at
└── metadata
```

`source`：

```text
acp_handshake | provider_api | local_config | manual
```

ACP 握手优先；离线 Provider 元数据只能作为明确标记的兜底来源。

## 5. Role 和 RoleBinding

```text
Role
├── id
├── workspace_id
├── name
├── description
├── system_prompt
├── required_guidelines[]
├── gates[]
├── output_contract
├── blocking_conditions[]
├── selectable
├── dispatchable
├── version
├── created_at
└── updated_at
```

```text
RoleBinding
├── id
├── workspace_id
├── role_id
├── provider_connection_id
├── model_id
├── runtime_options
├── priority
├── enabled
├── version
├── created_at
└── updated_at
```

Role 不直接绑定 Model。RoleBinding 必须引用同一 Workspace 的 Role 和 ProviderConnection。

## 6. Session 和 AgentSlot

```text
Session
├── id
├── workspace_id
├── title
├── goal
├── status
├── summary
├── created_at
└── updated_at
```

```text
AgentSlot
├── slot_id
├── session_id
├── role_id
├── role_binding_id
├── provider_connection_id
├── model_id
├── conversation_id
├── private_context_id
├── status
└── created_at
```

上面是目标态模型。当前已实现的公共 `AgentSlotDto` 只有 `id`、`session_id`、`role_binding_id?`、`model_id`、`status`、`created_at`：`role_id`、`provider_connection_id`、`conversation_id`、`private_context_id` 暂不对外，分别由私有 Role snapshot、Runtime attachment（含 ACP Session ID）承载。

同一个 Role 可以在一个 Session 中出现多个 Slot。每个 Slot 拥有独立 ACP Session 和 Runtime attachment；RoleBinding Slot（包括 Session 创建时的初始 Slot 与后续新增 Slot）在创建时解析同 Workspace 的 Binding。Binding 必须启用且不含暂不支持的 `runtime_options`，关联 Role 必须同时 `selectable`、`dispatchable`；ProviderConnection 与 Model 取自该 Binding。后续 Role/Binding 编辑只作用于新 Slot。Role 的 `system_prompt`、ordered guidelines 和 `output_contract` 以私有 source snapshot 固定，不进入公共 AgentSlot DTO。

AgentSlot 增加私有 nullable `deleted_at`（migration v7）。软删除保留 Slot 行和历史 Run/Task/Message/Permission/Role snapshot，公共快照和活动 Slot 查询隐藏已删除行；默认未绑定 Slot 不允许删除，存在 Slot claim 或任何非终态 Run（包括 paused/interrupted/recovery conflict）时返回 409。Runtime attachment 在 ACP Session/connection 关闭确认后才删除；已删除 Slot 的剩余 attachment 只用于恢复清理，不进入活动 Runtime。

`conversation_id` 与 ACP session **一一对应**（当前只存在于私有 Runtime attachment）：

- AgentSlot 创建时建立 ACP session，并把 session id 写入私有 attachment；
- 同 Slot ID 的 `reset-context` 接口尚未实现；当前通过软删除旧 Slot 后以同一 RoleBinding 新建 Slot 获得新 ACP Session（Slot ID 改变）；
- 服务重启后优先用 ACP `session/resume` 恢复（实测两个 Adapter 均声明 `sessionCapabilities.resume`）；恢复失败则收敛该 Slot 的 Run 为 `interrupted`，不静默新建。

## 7. Workflow、Task 和 Artifact

```text
WorkflowTemplate
├── id
├── workspace_id
├── name
├── nodes[]
├── edges[]
├── version
└── enabled
```

第一阶段节点类型：

```text
agent_task | parallel_group | human_approval | artifact_review
```

```text
Task
├── id
├── session_id
├── run_id
├── node_id
├── owner_slot_id
├── title
├── instruction
├── status
├── blocked_by[]
├── blocks[]
├── input_artifact_ids[]
├── output_artifact_ids[]
├── retry_policy
├── attempt
├── started_at
└── completed_at
```

```text
Artifact（当前获批的 inline 切片）
├── id / workspace_id / session_id
├── task_id / source_run_id
├── media_type = text/plain; charset=utf-8
├── storage_kind = inline / status = ready
├── size_bytes（UTF-8，最大 65,536）
├── sha256
└── created_at
```

当前仅接受同 Session 中 completed Run 的唯一 completed Task 输出，脱敏后以 BLOB 存 SQLite；内容不进入 metadata DTO 或 Event。脱敏前、脱敏后都按 UTF-8 byte length 限制，超限拒绝且不转成文件。读取时校验 BLOB 长度、记录大小与 SHA-256；失败统一按 `artifact_unavailable` 处理，不返回损坏内容。

后续文件 Artifact 目标路径曾规划为 `<workspace>/.rolecast/artifacts/<session_id>/<artifact_id>`，并以 Workspace-relative `content_ref` 引用；这不是当前实现或授权范围。文件写入需另行通过目录句柄能力 Gate，禁止 realpath 后绝对路径 fallback。

## 8. Message、Run、Event 和 PermissionRequest

```text
Message
├── id
├── session_id
├── run_id
├── task_id
├── from_slot_id
├── to_slot_id
├── audience
├── kind
├── summary
├── content_ref
├── artifact_ids[]
├── status
├── created_at
└── read_at
```

Message 是可持久化的协作消息。Mailbox 不是独立数据表，而是按 `to_slot_id`、`audience` 和 `status` 查询 Message 形成的投递视图。

```text
Run
├── id
├── session_id
├── workflow_id
├── status
├── input_summary
├── output_summary
├── started_at
├── completed_at
└── failure_reason
```

```text
Event
├── event_id
├── schema_version
├── workspace_id
├── session_id
├── run_id
├── sequence
├── type
├── source
├── payload
└── occurred_at
```

```text
PermissionRequest
├── id
├── run_id
├── task_id
├── slot_id
├── capability
├── description
├── adapter_options[]
├── status: pending | answered | expired
├── requested_at
├── soft_timeout_at
├── overdue_at?
├── expires_at?
├── expired_at?
├── answered_at?
├── selected_option_id?
├── adapter_request_id?（ACP JSON-RPC request ID，保留 number / string 原始类型）
└── expiration_reason?: timeout | runtime_unavailable | cancelled
```

权限请求由 Adapter 提供可选项，Rolecast 只渲染并回传，不自行增删选项。创建后 Run 进入 `waiting_user`、所属 Task 进入 `paused`。默认 `soft_timeout_at = requested_at + 5 分钟`，`expires_at = requested_at + 30 分钟`；硬超时关闭时 `expires_at` 为空。`overdue_at` 和 `expired_at` 用于幂等记录服务端已执行的时间点。

- 软超时只产生一次 `agent.permission_overdue` 提醒，状态仍为 `pending`；重启恢复时根据 `overdue_at` 去重；
- 硬超时将状态改为 `expired`，向 Adapter 回传拒绝/取消，并将 Run 标记为 `interrupted`；
- 过期后提交回答返回 `permission_timeout` / 状态冲突，不能再次触达 Adapter；
- 所有超时、回答和拒绝都必须有事件与可审计 Message，不自动批准或自动重跑。

## 9. 状态

### Run

```text
accepted → running → completed
                    ├→ paused → running
                    ├→ waiting_user → running
                    ├→ interrupted → running     （服务重启后恢复失败，可继续或重跑）
                    ├→ failed
                    └→ cancelled
```

`interrupted` **不是终态**：它表示进程中断且会话未能恢复，或权限请求硬超时后执行被中断；用户可以查看现场后选择继续或重跑。`completed`、`failed` 和 `cancelled` 为终态，不可回退。

恢复规则：

- `paused` / `interrupted`：可 `resume`；存在 pending Permission 时必须先回答或取消，`waiting_user` 不能直接 resume；
- `interrupted` 的 resume 会先按 attachment 重挂接 Runtime；重挂接失败时命令返回 409，用户应改用 `retry`；
- `retry` 必须创建新的 attempt，原 Run、Task、Event 和失败原因不可覆盖；
- `resume` 不创建新的 Run 或 attempt，只推进当前状态并发布 `run.resumed`。

### Task（目标态；`starting` / `blocked` 尚未实现）

```text
queued → starting → running
  │                  ├→ paused
  ├→ blocked         ├→ completed
  │   ├→ queued      ├→ failed
  │   └→ failed      └→ cancelled
  └→ cancelled
```

依赖未满足时 `queued → blocked`；依赖满足后 `blocked → queued`；依赖因上游失败/取消而永久不可满足时 `blocked → failed`（`dependency_failed`）。派发准备使用 `queued → starting → running`；**不存在 `running → blocked`**。终态不能被静默改写；重试必须创建新 attempt，并保留原始失败事件。

## 10. REST API

下文标注“已实现”的路由以 `packages/server/src/http-ws/http-server.ts` 当前注册为准；标注“规划中”的路由尚未注册，不应视为可调用契约。

### Workspace

```text
GET    /api/workspaces                  # 已实现
POST   /api/workspaces                  # 已实现
GET    /api/workspaces/:workspaceId     # 规划中
PATCH  /api/workspaces/:workspaceId     # 规划中
DELETE /api/workspaces/:workspaceId     # 规划中
```

### Provider 和 Model

```text
GET    /api/workspaces/:workspaceId/providers                # 已实现
POST   /api/workspaces/:workspaceId/providers                # 已实现
PATCH  /api/providers/:providerId                            # 已实现
DELETE /api/providers/:providerId                            # 规划中
POST   /api/providers/:providerId/test                       # 已实现
POST   /api/providers/:providerId/discover                   # 已实现
GET    /api/providers/:providerId/models                     # 已实现
POST   /api/providers/:providerId/config-import/preview      # 已实现
POST   /api/providers/:providerId/config-import/apply         # 已实现
```

### Credential

```text
POST   /api/credentials                                      # 已实现
```

请求体只接受 `{ idempotency_key: UUID, secret: string }`。`idempotency_key` 是客户端为单次创建操作生成的键，**与 `X-Request-Id` 链路追踪 ID 独立**：前者决定引用与幂等结果，后者只用于日志关联。`secret` 非空、不超过 64 KiB 字符且不含 `CR`/`LF`；最终字节级判据仍由 CredentialStore 负责。

成功返回 `201` 与 `{ credential_ref }`，并设置 `Cache-Control: no-store`；响应与错误都不回显 Secret。同一幂等键 + 同一 Secret 重试返回同一引用（包括进程重启后）；同一幂等键 + 不同 Secret 返回 `409 credential_idempotency_conflict`，**不覆盖**既有凭据，错误 `details.credential_ref` 回传既有引用（引用不是 Secret）供调用方继续使用。该入口只创建，不提供读取、列表、轮换或删除。

`PATCH /api/providers/:providerId` 接受严格的非秘密更新（省略=保留，`null`=清空；`codex_config` 只允许 `null`）：`connection_kind`、`environment_mode`、`base_url`、`credential_ref`（后两者 `null` 表示清空）与 `config_revision`。拒绝非 `null` 的 `codex_config` 值（仅允许 `codex_config: null` 清除命令接入前的 Claude 遗留配置）、Secret/Token 字段与带凭据或 query 的 URL。成功时 `config_revision` 自增并在同一事务内清空该连接的模型目录；`discover` 只有在捕获的 revision 仍是当前版本时才写入目录，否则返回 409 `state_conflict`。

### Run 命令与 Runtime 重挂接（Phase 1F）

- `RunStatus` 增加内部过渡态 `cancelling`；`RunDto` 增加可选 `retry_of_run_id`。
- 私有表/字段（不进入公共 DTO / snapshot）：`agent_slots.deleted_at`（软删除标记）、`runtime_attachments`（slot/session/Provider/配置 revision/Adapter 版本/指纹/cwd/运行目录/ACP Session ID；已删除 Slot 的行暂作 cleanup record）、`agent_slot_role_snapshots`（不可变 Role/Binding 源字段与版本，不含渲染 prompt）、`context_sources`（每 Task 的 Role/Binding/Message source ID/version）、`command_receipts`（start 的 `target_slot_id`/`input_digest`，add_slot 的 reservation、稳定 Slot 目标和 `input_digest`）、`slot_activity_claims`（单 Slot 单活动 Run）。
- 命令 API：`POST /api/runs/:runId/cancel|resume|retry`，body `{ request_id }`，返回 `202` + `{ request_id, status, run_id?, task_id?, error_code? }`；`/api/sessions/:sessionId/messages` 的 `request_id` 也是幂等键。
- 回执状态 `reserved/running/completed/failed/ambiguous`，私有 `dispatch_state=not_started|started|accepted`。未越过 dispatch 的确定性失败转 `failed/not_dispatched`（同 key 可安全重试）；已 `started` 但结果未知转 `ambiguous`，同 key 返回 409 `command_outcome_ambiguous`。
- 同 key 换输入一律 409 `state_conflict`：start 回执保存不可逆的 `input_digest`，即使失败发生在创建 Run/Message 之前也能判定输入已变化；旧回执没有摘要时退化为比较已持久化的用户 Message。
- `resume` 与 `retry` 都重放原用户输入，属于 **at-least-once**，外部副作用可能重复，UI 必须二次确认。
- `retry` 创建 attempt+1 的新 Run，复用原用户 Message；祖先只要仍有后代就不能 retry（`(retry_chain_id, attempt)` 与非空 `retry_of_run_id` 唯一索引兜底）。新 ACP Session 建立后必须先持久化新 attachment 再替换内存 Runtime，旧 Session/连接安全关闭；创建子 Run、Task、ContextSource 与 receipt refs 在同一事务提交。attachment 保存失败时 rollback 仅在 receipt 仍指向该 child 且未越过 dispatch 时以状态和 refs 做 CAS；stale dispatcher 比较 refs 后不得调用 Runtime。
- `cancel` 的 `session/cancel` 只是通知：必须等待活动 turn 结束或 `turn_cancelled` 证据，无法确认时 Run/Task 收敛为 `interrupted`；complete/fail/cancel 都在同一 `state_revision` CAS 事务中更新 Run、Task 与 claim。
- 启动恢复按 attachment 校验 Provider revision/kind、Adapter 版本、私有 Adapter 指纹与 cwd/运行目录；不一致或指纹缺失不 spawn，关联 Run 收敛 `interrupted`。没有 attachment 的历史非终态 Run 同样收敛 `interrupted`，并按真实 Run 重建 Slot claim；同 Slot 多个非终态 Run 建立 `recovery_conflict` hold。
- `input_message_id` 只在 Task 私有列，公共 DTO/snapshot 不包含。
- 单 Slot 不排队：已有非终态 Run 时新 start/retry 返回 409 `slot_busy`；历史库同 Slot 多个非终态 Run 时建立 `recovery_conflict` hold。
- Permission `expiration_reason` 增加 `cancelled`。

当前**不持久化认证会话，也不计划持久化**：认证只支持 inherited 本地 CLI 或 isolated API key，REST/WS 只返回脱敏的 `authMethods` 摘要与 `credential_ref`。没有认证表、OAuth callback 路由、Token 字段或认证状态机；Phase 1C 的登录能力探测只作为历史资料，不构成后续 API。

`config-import/preview` 只读取受控 Codex Home（`CODEX_HOME` 或 `~/.codex`）下用户选择的 `config.toml` 并返回脱敏草稿，不写入任何配置；preview 绑定 Workspace、Provider、源文件 SHA-256 和目标 `config_revision`。`apply` 只能在用户明确确认草稿后执行，必须通过目标 revision 条件更新，仅保存非秘密 ProviderConnection 字段；API Key 连接的凭据仍通过 `credential_ref` 引用 CredentialStore；Runtime 只在 Adapter spawn 边界通过 CredentialStore 读取并注入 Secret，isolated Codex 过滤继承认证环境变量，登录态不在两个目录之间复制。文件符号链接、危险 URL、源文件变化和重复 preview 使用均拒绝并返回结构化错误。

### Role 和 Binding

```text
GET    /api/workspaces/:workspaceId/roles                   # 已实现
POST   /api/workspaces/:workspaceId/roles                   # 已实现
GET    /api/roles/:roleId                                    # 已实现
PATCH  /api/roles/:roleId                                    # 已实现
DELETE /api/roles/:roleId                                    # 已实现
GET    /api/workspaces/:workspaceId/bindings                 # 已实现
POST   /api/workspaces/:workspaceId/bindings                 # 已实现
GET    /api/bindings/:bindingId                              # 已实现
PATCH  /api/bindings/:bindingId                              # 已实现
DELETE /api/bindings/:bindingId                              # 已实现
```

### Session 和 AgentSlot

```text
GET    /api/workspaces/:workspaceId/sessions                    # 已实现
POST   /api/workspaces/:workspaceId/sessions                    # 已实现
GET    /api/sessions/:sessionId                                  # 已实现
GET    /api/sessions/:sessionId/snapshot                         # 已实现
PATCH  /api/sessions/:sessionId                                  # 规划中
DELETE /api/sessions/:sessionId                                  # 规划中
POST   /api/sessions/:sessionId/agents                           # 已实现；body: role_binding_id, request_id?
DELETE /api/sessions/:sessionId/agents/:slotId                   # 已实现；软删除非默认空闲 Slot
PATCH  /api/session-agents/:slotId                               # 规划中
POST   /api/session-agents/:slotId/reset-context                 # 不在当前范围；新建 Slot 会改变 ID
```

### Workflow、Run 和 Artifact

```text
GET    /api/workspaces/:workspaceId/workflows                  # 规划中
POST   /api/workspaces/:workspaceId/workflows                  # 规划中
PATCH  /api/workflows/:workflowId                              # 规划中
DELETE /api/workflows/:workflowId                              # 规划中
POST   /api/sessions/:sessionId/runs                           # 规划中
GET    /api/runs/:runId                                        # 规划中
POST   /api/runs/:runId/cancel                                 # 已实现
POST   /api/runs/:runId/resume                                 # 已实现
POST   /api/runs/:runId/retry                                  # 已实现
GET    /api/runs/:runId/tasks                                  # 规划中
GET    /api/runs/:runId/artifacts                              # 规划中
GET    /api/runs/:runId/events                                 # 规划中
```

#### Session-scoped Artifact metadata 页面

```text
GET /api/sessions/:sessionId/artifacts?limit=&cursor=                  # 已实现，metadata-only 分页
GET /api/sessions/:sessionId/artifacts/:artifactId                     # 已实现，metadata-only
GET /api/sessions/:sessionId/artifacts/:artifactId/content             # 已实现，显式按需读取纯文本
```

页面默认 `limit=50`、上限 100，按 `created_at DESC, id DESC` keyset 分页，复用现有 `artifacts_workspace_session_idx(workspace_id, session_id, created_at, id)`，无需新 migration。首屏/翻页不取正文；Web 用户显式打开单项后才请求独立 content endpoint，并以纯文本显示，不解析 HTML/Markdown。不存在或跨 Session cursor 使用统一 `artifact_unavailable`。

### Messages and permissions

```text
POST   /api/sessions/:sessionId/messages                      # 已实现；body 可带 agent_slot_id 定向投递
POST   /api/session-agents/:slotId/messages                    # 规划中
GET    /api/sessions/:sessionId/activity                       # 已实现
GET    /api/runs/:runId/permissions                            # 规划中
POST   /api/permissions/:requestId/answer                      # 已实现
WS     /api/ws                                                 # 已实现
```

Phase 1A 开放 Workspace 列表/创建、Provider 测试/发现、Session 创建、综合快照、消息和权限回答；Session 创建请求现有两个互斥的 strict 形状：Provider/model 路径 `{ name, provider_connection_id, model_id }` 保持兼容，RoleBinding 路径 `{ name, role_binding_id }` 从同 Workspace 的已验证 Binding 解析 Provider 与 Model。绑定路径要求 Binding 已启用、`runtime_options` 为空，关联 Role 同时 `selectable`、`dispatchable`；成功只创建一个绑定初始 AgentSlot，Session、Slot、Runtime attachment 和私有 Role source snapshot 在同一 SQLite 事务内提交。混合字段或未知字段被 Contract 拒绝；Session DTO 与成功响应不变。

Phase 1F 已开放 Run `cancel`/`resume`/`retry` 与启动恢复。Phase 2 首个 AgentSlot 生命周期切片开放 `POST /api/sessions/:sessionId/agents`，body `{ role_binding_id, request_id? }`，仅允许同 Workspace 的可派发 RoleBinding；`add_slot` receipt 在 ACP 创建前预留稳定 Slot ID，新增 Slot、attachment、Role snapshot 与 completed receipt 原子提交。进程在 ACP 初始化后、最终事务前崩溃时允许 ACP 初始化 at-least-once，但不会派发 Run/prompt，最终只保留一个持久 Slot；不声称 fake/offline 测试证明真实子进程在父进程崩溃后的清理。创建出的 Slot 有独立 ACP Session 和 Role source snapshot。`DELETE /api/sessions/:sessionId/agents/:slotId` 可软删除非默认空闲 Slot；活动 Run/claim 存在时返回 409，跨 Session 与不存在目标统一 404。Session message body 可带 `agent_slot_id`；省略时固定投递到原始默认 Slot，request receipt 持久绑定其 resolved slot。Role context 以通用 ACP text sections 传递，不是 provider system-role 权限。同 ID `reset-context` 尚未实现；当前可删除后重建得到新 Slot ID。Coordinator、TaskBoard、Mailbox/Artifact workflow 与 Slot 重配置仍未开放。

## 11. Event envelope

```json
{
  "event_id": "event-001",
  "schema_version": 1,
  "workspace_id": "workspace-001",
  "session_id": "session-001",
  "run_id": "run-001",
  "sequence": 12,
  "type": "task.started",
  "source": "orchestration",
  "occurred_at": "2026-10-13T00:00:00Z",
  "payload": {}
}
```

事件类型完整清单（与 §9 状态机一一对应）：

```text
workspace.created / workspace.updated / workspace.deleted

provider.connected / provider.disconnected
provider.capabilities_updated / provider.health_changed

session.created / session.updated / session.archived
session.agent_added / session.agent_removed
message.created / message.read

run.accepted / run.started / run.paused / run.resumed
run.waiting_user / run.interrupted
run.completed / run.failed / run.cancelled

task.queued / task.started / task.paused / task.blocked
task.completed / task.failed / task.cancelled

artifact.created / artifact.updated

agent.status_changed
agent.permission_requested / agent.permission_overdue
agent.permission_answered / agent.permission_expired

credential.created / credential.rotated / credential.deleted

context.built / context.truncated / context_source_missing

adapter.started / adapter.capability_discovered / adapter.crashed
```

约束：

- 新增事件类型必须同步本节与 [events 模块](../modules/events.md)；
- 事件名使用 `域.动作` 形式，全小写；
- `credential.*` 与 `context.*` 事件不得携带 Secret 或完整私有内容。

## 12. 错误格式

```json
{
  "ok": false,
  "error": {
    "code": "provider_capability_not_supported",
    "message": "当前 Provider 不支持该模型配置",
    "details": {},
    "request_id": "request-001"
  }
}
```

`details` 不得泄露密钥、Token、内部堆栈或完整 Provider 请求。

### 12.1 错误码完整清单

命名规则：`snake_case`，按「域」分组。错误码集中在 `packages/contract` 定义，是唯一来源。

```text
validation
  invalid_request             字段缺失或格式非法
  invalid_response            客户端收到无法验证的服务响应
  invalid_input               字段缺失或格式非法
  invalid_schema_version     请求的 schema 版本不支持
  payload_too_large          超出请求体上限

auth
  unauthorized               缺少或无效的 Local Token
  credential_missing         引用的凭据不存在
  credential_store_unavailable  系统密钥存储不可用
  credentials_unavailable       生产模式没有可用 Keychain
  credential_not_found       凭据引用不存在
  credential_denied          系统密钥存储拒绝访问
  credential_invalid         凭据取值不符合公共契约（空、超限或含行分隔符）
  credential_idempotency_conflict  同一幂等键已保存过不同的 Secret，拒绝覆盖
  credential_required        API Key 连接缺少 credential_ref
  credential_environment_mismatch   credential_ref 与 environment_mode 不匹配（inherited 携带引用）
  codex_custom_endpoint_unverified  Codex custom endpoint 的 endpoint 覆盖已证实但认证未证，不能作为可运行连接

not_found
  not_found                  通用资源不存在；AgentSlot 等未单列的资源用 details.resource 区分
  workspace_not_found
  provider_not_found
  model_not_found
  role_not_found
  binding_not_found
  session_not_found
  task_not_found
  artifact_not_found
  run_not_found

conflict
  state_conflict             非法状态转换（如改写终态）
  command_outcome_ambiguous  同 request_id 的命令结果不确定，需新 request_id
  slot_busy                  该 Slot 已有活动 Run（不排队）
  duplicate_request          同一 request_id 重复提交
  resource_in_use            资源被占用（如端口、文件锁）

capability
  provider_capability_not_supported   当前 Provider 不支持该配置
  model_unavailable                   模型不在握手返回的可用列表中
  adapter_capability_missing          Adapter 未声明该能力
  capability_discovery_failed         握手失败或未返回能力

context
  context_source_missing      Slot Role snapshot 或 Task source reference 缺失 / 版本不匹配

runtime
  adapter_start_failed
  adapter_crashed
  handshake_failed
  session_create_failed
  turn_cancelled
  permission_timeout         权限请求未在规定时间内应答
  permission_not_found       权限请求不存在
  permission_option_invalid  权限选项不是 Adapter 提供的选项
  permission_denied

infra
  db_unavailable
  migration_failed
  internal_error             未分类的内部错误
```

约束：

- 新增错误码必须同步本节；
- 4xx 类错误必须携带面向用户的中文 `message`；
- `internal_error` 不得暴露原始堆栈，堆栈只进脱敏日志。

## 13. 网络层 wire 约定

本节是前后端共同的 wire 行为定义，唯一定义点在这里。前后端各自的实现细节见 [HTTP/WS 模块](../modules/http-ws.md) 与 [Web UI 模块](../modules/web.md)。

### 13.1 鉴权

```text
Authorization: Bearer <Local Token>

WebSocket 首帧（连接建立后）：

```json
{"type":"auth","token":"<Local Token>","workspace_id":"workspace-001"}
```

Local Token 由服务启动时生成，默认只保存在 Server 进程内存。REST 使用 `Authorization: Bearer <Local Token>`；浏览器原生 WebSocket 无法设置 Authorization header，因此 `/api/ws` 建立连接后必须在限定时间内发送首帧 `{"type":"auth","token":"<Local Token>","workspace_id":"workspace-001"}`，服务端在认证前不得订阅、缓存或发送业务事件，缺失/无效 Token 以 1008 关闭。Token 不进入 URL、访问日志或持久化。前端通过 URL fragment 接收后立即清除 hash，并存入 `sessionStorage`；不得写入 `localStorage`。SQLite 默认不保存 Token 原文；跨重启持久化场景只允许 Keychain 保存原文、SQLite 保存 Hash 和生命周期元数据。服务生成本地页面入口时负责把 Token 放入 fragment；刷新后 fragment 已清除，Web 必须显示重新打开本地入口的提示，不能从 URL 查询参数恢复。

### 13.2 request_id

- 客户端可传 `X-Request-Id`；未传时服务端生成；
- 服务端必须在响应 header 与错误 body 中回传同一个 `request_id`；
- `request_id` 贯穿服务端日志，用于把用户报错关联到具体请求；
- 幂等写操作依赖 `request_id` 去重，见 13.4。

### 13.3 超时

| 场景 | 建议超时 |
| --- | --- |
| 普通 REST 读写 | 10s |
| 触发型操作（启动 Run、测试连接） | 60s |
| WebSocket 心跳间隔 | 30s |

超时必须由客户端封装层统一处理，调用点不各自设超时。

以上是 HTTP/WS 传输超时；**权限等待超时是业务状态机策略，不受 10s/60s HTTP 超时影响**：软超时默认 5 分钟，硬超时默认 30 分钟，由服务端根据持久化时间戳执行。浏览器断开或刷新不能取消该计时。

### 13.4 重试

- 读操作：可自动重试，指数退避，最多 2 次；
- 写操作：默认不自动重试；只有携带 `request_id` 且服务端保证幂等的接口才可重试；
- 4xx 一律不重试（除 429）；5xx 与网络错误可重试；
- 重试必须由封装层统一实现，调用点不自行循环。

### 13.5 事件续传

WebSocket 断线后：

1. 客户端重连，指数退避；
2. 重连成功后按本地记录的每个 Run 的最后 `sequence` 请求补发；
3. **必须重新拉取综合 Session Snapshot**，其中包含 Session、AgentSlot、Run、Task、Message、PermissionRequest 和每个 Run 的最新 `sequence`，不能只依赖补发事件；
4. 服务端无法补发时，发送 `snapshot_required` 控制消息，客户端必须重拉快照并覆盖本地状态，不得静默丢事件。

### 13.6 统一约束

- 业务代码不得直接调用 `axios`、`fetch` 或 `WebSocket`，只能经封装层；
- 所有响应在封装层边界做 Schema 校验，校验失败按 `invalid_response` 处理；
- 日志与错误信息不得包含 Local Token、API Key、Authorization header。

## Phase 2 handoff 与 per-Run 水位

`POST /api/sessions/:sessionId/handoffs` 从已完成 Run 的持久化 Agent 输出创建 handoff Message；MessageDto 新增兼容可选 `kind`（`handoff`）与 `to_slot_id`，`sender_id` 表示来源 Slot。私有 `handoff_request_id` 不进入 DTO/API，v8 中以 Session-scoped 部分唯一索引保证幂等。Run 私有 `event_sequence`/`completed_sequence` 不进入公共 DTO；handoff 读取严格止于完成水位，旧 Run 或水位缺失返回 `409 source_history_unavailable`。`audience`、read/status 与 Artifact 引用仍为后续范围。

## Web Phase 2/3 Stage 0 契约（部分实现）

Stage 0 冻结的完整契约见 `Stage0-Web-Phase2-3-ADR.md`；Workspace 根路径切片已实现，inline Artifact 已获批作为当前服务端切片；其余条目仍为目标态：

- Task 状态目标新增 `starting`、`blocked`；Run 不新增 `blocked`。Task 增加 `node_key`、`attempt`、`retry_of_task_id`，唯一 `(run_id, node_key, attempt)`；Event payload 目标携带 `run_id + task_id + node_key + attempt`。
- `WorkspaceDto` 响应形状不变；新建 Workspace 请求要求 `root_path`，独立 `WorkspaceRootPathDto` 及 `GET/POST /api/workspaces/:workspaceId/root-path` 已实现；错误 `workspace_root_required`、`workspace_root_invalid`、`workspace_root_duplicate`、`workspace_root_already_configured` 已实现。`workspace_root_unconfigured` 仍是未来 Artifact 门禁错误。
- handoff 请求增加可选 `source_task_id`；多 Task Run 必填，错误 `source_task_required` / `source_task_invalid`。
- Artifact 模块（`docs/modules/artifacts.md`）：当前服务端切片仅为 SQLite inline UTF-8 文本（≤65,536 bytes）、completed Run/Task 来源、脱敏、幂等、SHA-256 与独立 metadata/content API；超限拒绝，不转文件。Workspace root migration v9 已实现，Artifact 表使用 v10。文件模式、`content_ref`、intent/staging/rename/recovery 仍属后续设计且因目录句柄能力未证明保持 BLOCKED。
- 容量错误 `scheduler_capacity_reached`（429）、`permission_capacity_exceeded`、`capacity_overcommitted`；0B 测试注入测量能力已实现，Q/P/N 由 0C 用户批准；生产 admission 在批准前 fail-closed。
- reset-context：Slot `context_generation` + 唯一 reset intent + claim generation fence；错误 `reset_conflict`、`reset_recovery_required`。
- Mailbox（`docs/modules/mailbox.md`）：仅现有单 Task handoff、按 Session + 目标 Slot 隔离；`GET /api/sessions/:sessionId/mailbox`、`GET /api/sessions/:sessionId/mailbox/:messageId`、`POST /api/sessions/:sessionId/mailbox/:messageId/read` 已实现，摘要不含正文、`limit` 默认 50/最大 100、keyset 游标、状态仅 unread/read；错误码 `mailbox_message_unavailable`（404）。首次 mark-read 与 metadata-only `message.read` Event 同事务，EventBus 在提交后 best-effort 发布。多 Task handoff、`source_task_id` 仍未实现。
- SQLite Workspace 根路径 migration v9 已实现；inline Artifact 使用 migration v10；Mailbox read marker 使用 migration v11；Workflow/Task/reset 与文件 Artifact schema 仍使用未来独立 migration。迁移规则见 ADR 第 8 节。
