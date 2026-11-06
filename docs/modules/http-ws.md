# HTTP/WS 模块

## 目标

提供本地 REST 和 WebSocket 控制面，把外部请求转换为 Application Command。

## 实现落点

本模块是**唯一允许依赖 Web 框架的模块**。

- HTTP 框架：Fastify；
- WebSocket：`@fastify/websocket`，承载 `GET /api/ws` 事件流；
- 请求校验：在边界用 Contract Schema 校验，不把原始 payload 传进 Application；
- Local Token / Origin / Host 校验：REST 用 Fastify hook 校验，WS 先校验 Origin/Host，再要求连接建立后限定时间内首帧 `auth` 消息携带 Token 和 Workspace ID；认证前不订阅、不缓存、不发送业务事件；启动成功后 Server 输出带 fragment 的本地 Web 入口，刷新丢失 Token 时 Web 只显示重新打开入口提示；
- 依赖装配：由 `main.ts` 注入 Application Service，本模块不自行创建实现。

`domain`、`application`、`contract` 目录禁止 import 任何 Web 框架。替换 HTTP 框架的规则见 [模块边界与升级规则](../architecture/模块边界与升级规则.md)。

## 对外提供的能力

- Workspace、Provider、Role、Binding、Session、Workflow CRUD；Role/Binding 支持单资源 GET、列表、创建、PATCH 和删除；
- Credential 创建（只写入，不提供读取、列表、轮换或删除）；
- Run 启动、取消、恢复、重试；
- Message、Permission、Artifact metadata/content 查询及受限创建；
- WebSocket 事件订阅；
- 统一错误响应；
- Local Token 和 Origin/Host 校验。

## Credential 路由

```text
POST   /api/credentials
```

- 请求体只接受 `{ idempotency_key: UUID, secret: string }`；`idempotency_key` 是客户端为单次创建操作生成的键，**与 `X-Request-Id` 链路追踪 ID 无关**；
- 成功返回 `201`、`{ ok: true, data: { credential_ref } }` 与 `Cache-Control: no-store`；响应永不回显 Secret；
- 同一幂等键 + 同一 Secret 重试返回同一引用；同键不同 Secret 返回 `409 credential_idempotency_conflict`，不覆盖既有凭据，并在 `details.credential_ref` 回传既有引用（非 Secret）；
- 校验失败 400 且不调用 Application；`credential_invalid` 422、`credential_denied` 403、`credentials_unavailable` 503；
- 不记录请求体，错误信封不含 Secret。该路由不受 Workspace 路径约束，仅由 Local Token + Origin/Host 保护。

## Role / Binding 路由

```text
GET    /api/workspaces/:workspaceId/roles
POST   /api/workspaces/:workspaceId/roles
GET    /api/roles/:roleId
PATCH  /api/roles/:roleId
DELETE /api/roles/:roleId
GET    /api/workspaces/:workspaceId/bindings
POST   /api/workspaces/:workspaceId/bindings
GET    /api/bindings/:bindingId
PATCH  /api/bindings/:bindingId
DELETE /api/bindings/:bindingId
```

列表和创建使用路径中的 Workspace ID；单资源读取和变更由 Application 校验归属。REST 当前是本地单用户控制面，不提供独立的 Workspace ACL；跨 Workspace 的扁平 ID 访问统一返回资源不存在，不泄露资源存在性。

## Workspace 根路径

```text
POST /api/workspaces
GET  /api/workspaces/:workspaceId/root-path
POST /api/workspaces/:workspaceId/root-path
```

- 创建请求严格接受 `{ name, root_path }`，缺少 `root_path` 返回 422 `workspace_root_required`；路径经 Application 的 filesystem Port 校验并保存 canonical 路径。成功仍返回原有 `WorkspaceDto`，不增加 `root_path` 字段。
- 根路径状态单独使用严格 `WorkspaceRootPathDto { workspace_id, root_path }`；迁移后的旧 Workspace 在补设前返回 `root_path: null`。
- 一次性补设仅允许 NULL → canonical path；无效路径返回 422 `workspace_root_invalid`，其他 Workspace 已占用该 canonical 路径返回 409 `workspace_root_duplicate`，重复补设返回 409 `workspace_root_already_configured`。未知 Workspace 返回 404 `not_found`。
- 两条 root-path 路由与 Workspace 创建一样经过 Local Token、Host、Origin 检查。控制器只校验 Contract 并调用 WorkspaceService；不直接访问数据库、创建目录或读取根目录内容。错误响应不回显原始路径。
- 旧客户端仍可读取既有 WorkspaceDto，但旧格式 `{ name }` 不再满足创建 Contract；创建 Workspace 前需升级客户端并提供根路径。

## Artifact 路由（inline 切片）

路由由独立的 `http-ws/artifact-routes.ts` 注册；复用本模块安全 hooks 与统一错误映射，不在控制器中访问 SQLite。

```text
POST /api/sessions/:sessionId/artifacts
GET  /api/sessions/:sessionId/artifacts?limit=&cursor=
GET  /api/sessions/:sessionId/artifacts/:artifactId
GET  /api/sessions/:sessionId/artifacts/:artifactId/content
```

列表路由以严格 query 接受可选 `limit`（默认 50，最大 100）与 keyset `cursor`，返回仅含 metadata 的有界页；按 `created_at DESC, id DESC` 稳定分页，正文列不进入查询。创建请求严格为 `{ source_run_id, request_id }`；成功返回 metadata-only DTO。来源必须是该 Session 的 completed Run 且恰有一个 completed Task；服务端只取 `completed_sequence` 内完整持久化 Agent 文本。inline UTF-8 上限为 65,536 bytes，超限为 413 `artifact_too_large`，不转文件。单条 metadata 与内容通过独立 GET 返回；内容路由校验 BLOB 长度和 SHA-256。不存在与跨 Session、完整性错误统一为 404 `artifact_unavailable`。

Artifact 稳定 HTTP 映射固定为：`invalid_request` 400、`source_history_unavailable` 409、`artifact_too_large` 413、`workspace_root_unconfigured` 409、`workspace_root_unavailable` 409、`artifact_request_conflict` 409、`artifact_unavailable` 404、`artifact_sanitization_failed` 500。来源零 Task、恰有一个未完成 Task、多 Task、归属不符或历史缺口均不得写入 Artifact/Event。创建前只复核 Workspace root path；inline 不对目录内容执行文件操作。上述四条路由均经过 Local Token、Host、Origin 安全 hooks。

## Session 创建

`POST /api/workspaces/:workspaceId/sessions` 继续使用现有路由和 Contract Schema；请求体必须严格匹配以下一种形状：

- Provider/model：`{ name, provider_connection_id, model_id }`；保留既有创建方式。
- RoleBinding：`{ name, role_binding_id }`；服务端从当前 Workspace 的 Binding 解析 Provider 与 Model，并创建一个绑定的初始 AgentSlot。

两种形状不能混用或添加额外字段。Contract 校验失败仍返回现有 validation error；Application 会验证 Binding、Role、ProviderConnection 和 Model 的 Workspace 归属及运行资格。HTTP 路由、Session DTO 和成功响应形状不变。

## Run 命令 API（Phase 1F）

`POST /api/runs/:runId/cancel|resume|retry` 接受 `{ request_id }`，返回 `202` 与稳定回执；`409 slot_busy` 表示 Slot 已有活动 Run，`409 command_outcome_ambiguous` 要求换新 request_id。WS 的 `resume` 仍然只表示事件游标续传，与 Run resume 无关，不得复用。

## 路由边界

Controller 只能：

1. 解析并验证 Contract DTO；
2. 调用 Application Service；
3. 将结果映射为 DTO；
4. 转换稳定错误码。

Controller 不得：

- 直接 SQL；
- 启动 ACP 进程；
- 拼接 Prompt；
- 读取原始 Credential；
- 修改 Domain Entity。

## 生产级要求

### 错误映射

Domain / Application 错误统一映射为 wire 错误信封，并附正确 HTTP 状态码：

| 错误类别 | 状态码 |
| --- | --- |
| 输入校验失败 | 400 |
| 未认证 / Local Token 无效 | 401 |
| 资源不存在 | 404 |
| 状态冲突（终态改写、重复创建） | 409 |
| 能力不支持 / 参数不被 Provider 接受 | 422 |
| 内部错误 | 500 |

错误体格式与错误码定义见 [数据模型与 API](../architecture/数据模型与API.md)。**不允许把内部堆栈返回浏览器**，堆栈只进脱敏日志。

### request_id

入口生成或透传 `X-Request-Id`，并在响应 header 与错误 body 中回传同一个值；写入访问日志，用于把用户报错关联到具体请求。

### 日志

- 结构化访问日志：方法、路径、状态码、耗时、`request_id`；
- 必须脱敏：Local Token、Authorization、API Key、Provider 原始请求体；
- 错误日志记录错误类别与上下文，不记录完整私有对话。

### 资源限制

- 请求体大小上限，超出返回 413；
- 请求超时（普通读写 10s、触发型操作 60s），见 wire 约定的超时表；
- WebSocket 单连接事件缓冲上限，超出时明确断开而非无限积压。

### 权限请求等待

权限请求的 5 分钟软提醒和默认 30 分钟硬超时是服务端业务状态机，不受普通 REST/触发型请求的 10s/60s HTTP 超时影响：

- `GET /api/runs/:runId/permissions` 返回 `pending`、`answered` 或 `expired` 的持久化快照；
- `POST /api/permissions/:requestId/answer` 只接受仍为 `pending` 的请求，过期后返回 409 与 `permission_timeout`，不再转发 Adapter；
- `agent.permission_overdue`、`agent.permission_expired` 和 `run.interrupted` 通过统一 Event Envelope 推送；客户端重连后必须同时重拉 Run、Task 和 PermissionRequest 快照；
- WS 断开、页面关闭或浏览器休眠不能暂停服务端计时。

配置导入接口必须区分 preview 和 apply：preview 只返回脱敏草稿，apply 必须携带用户确认后的版本标识；不得通过 HTTP 返回凭据原文或 OAuth 文件。

### 优雅关闭

收到 `SIGTERM` / `SIGINT` 时按序执行：

1. 停止接受新请求；
2. 关闭 WebSocket 连接并通知客户端；
3. 取消或挂起运行中的 Run（状态持久化，可恢复）；
4. 清理 ACP Adapter 子进程，不留孤儿进程；
5. 关闭 SQLite 连接；
6. 退出。

不得直接 `process.exit()` 跳过清理。

## 安全

- 只监听 127.0.0.1；
- REST 校验 `Authorization: Bearer <Local Token>`；WS 不使用 query string Token，而是以首帧 `auth` 消息完成认证；
- 校验 Origin 和 Host，并对状态变更请求执行 CSRF 防护；
- 设置适用于本地 Web UI 的 CSP、`X-Content-Type-Options`、`Referrer-Policy` 和 `Permissions-Policy`；
- 对连接测试、Run 启动、配置导入和权限回答设置本地速率限制；
- `/healthz` 只返回健康信息；
- 不将内部堆栈或密钥返回浏览器。

安全 Header、速率限制和 CSRF/Origin 策略属于本模块的实现检查项，不由 Domain 或 Application 决定。具体阈值必须在 Server 配置中集中管理，不能散落在 Controller。

## 事件流

WebSocket 发送统一 Event Envelope，支持 sequence、断线重连和 replay。认证后客户端发送 `resume` 控制消息；服务端无法填补 sequence 缺口时发送 `snapshot_required`。客户端必须调用综合 Session Snapshot 接口，重新拉取 Session、AgentSlot、Run、Task、Message、PermissionRequest 和每个 Run 的最新 sequence，不能只依赖事件。快照从同一 SQLite 读事务中生成，避免状态与 sequence 交错。

## 依赖

允许依赖：contract、application、events、Fastify 及其官方插件。

禁止依赖：domain 内部实现、SQLite、ACP SDK、Vue Store、Keychain 实现、装饰器 DI 框架。

## 输入、输出和错误

输入是 HTTP/WS 请求和 Contract DTO；输出是 DTO、Event Envelope 或稳定 ApiError；内部堆栈只进入脱敏日志。

## 状态和不变量

同一个 request_id 的幂等命令不能重复创建 Run；WebSocket 断线后必须能按 sequence 恢复。

## 持久化

不直接持久化，由 Application 和 Persistence 完成。

## 事件

订阅 Events 模块并转发 Event Envelope；不创建业务事件。

## 安全边界

Local Token、Origin、Host 和 Workspace 权限必须校验；敏感请求不能通过未认证连接执行。

## 替换和升级策略

HTTP Framework 可替换，只需保持 REST/WS Contract、错误码和鉴权行为。

## 已知限制

第一阶段只监听本机，不支持跨设备或局域网远程控制。

## 测试

测试 DTO 验证、错误映射、鉴权、Origin、断线重连、重复请求和幂等性。

## Phase 2 handoff

`POST /api/sessions/:sessionId/handoffs` 接受 `{ source_run_id, target_slot_id, request_id }`，返回 `201` 与持久化的 MessageDto；重放返回同一条 Message。`409 source_history_unavailable` 表示来源 Run 无完整可信水位，`413 source_event_payload_too_large` 表示单条/页事件超限，`413 handoff_content_too_large` 表示正文超过 64 KiB；同 key 参数冲突返回 `409 state_conflict`。

## Web Phase 2/3 路由状态

Workspace 创建与一次性 root-path 补设、SQLite inline Artifact 创建、分页列表、单条 metadata 与 content 四条路由均已实现（见上文）。Mailbox 三条路由已实现：`GET /api/sessions/:sessionId/mailbox`（`slot_id` 必填，`limit` 默认 50/最大 100，可选 `cursor`）、`GET /api/sessions/:sessionId/mailbox/:messageId?slot_id=...`、`POST /api/sessions/:sessionId/mailbox/:messageId/read`；不可见目标统一返回 `404 mailbox_message_unavailable`，非法 limit/cursor/body 返回统一校验错误。其余目标仍包括 handoff 的可选 `source_task_id`、TaskBoard/Task retry、Workflow、capacity 与 reset 路由。相关错误映射见 `Stage0-Web-Phase2-3-ADR.md`（source_task、容量、reset）。
