# Persistence 模块

## 目标

保存用户可读配置、运行状态、历史事件和 Artifact 索引，并提供事务和迁移。

## 存储分工

```text
JSON       → 用户配置、Workspace Role / RoleBinding
SQLite     → Workspace、ProviderConnection（含非秘密 Codex 配置和 config_revision）、ModelCatalog、Session、AgentSlot、Run、Task、Message、ContextSource、Event、Artifact 索引及 Slot 私有 Role source snapshot
Keychain   → 秘密
文件系统    → 大型 Artifact 内容
```

## 对外提供的能力

```text
WorkspaceRepository
ProviderRepository
RoleConfigRepository（JSON 实现；Port 语义与存储实现解耦）
SessionRepository
MessageRepository
TaskRepository
ArtifactRepository
RunRepository
PermissionRepository
EventStore
```

`PermissionRepository` 保存 PermissionRequest 的状态、Adapter 选项、时间戳和回答引用；它不保存凭据原文。

`EventStore` 实现 `EventStorePort`，负责追加事件和按 sequence 重放；它不是发布订阅总线。PermissionStateStore 的生命周期事件先追加到 EventStore，再由 InProcessEventBus 推送，确保实时 UI 与断线 replay 看到同一语义。

Phase 1A 的实现落点为 `infrastructure/persistence/sqlite-database.ts`、`sqlite-repository.ts`、`sqlite-permission-event-store.ts` 和 `sqlite-permission-recovery-store.ts`：启动时执行显式 migrations，综合 Session Snapshot 在同一个 SQLite 读事务中读取 Session、Slot、Run、Task、Message、Permission 和最新 sequence。权限状态与审计事件在同一 SQLite 事务内提交，提交后才推送 EventBus。

所有 Repository 都通过 Port 暴露，Application 不直接依赖 SQLite 或 JSON 文件 API。

`RoleConfigRepository` 的 Workspace mutation 必须支持异步 callback，并在同一受控临界区内完成读取、校验、CAS 和原子 rename。Role 删除与 Binding 创建/更新必须共享该临界区，避免产生悬空引用。ProviderConnection 和 ModelCatalog 由 SQLite 提供只读引用校验；当前它们没有删除路径，未来增加删除前必须增加引用阻断或跨存储迁移事务。

## 事务边界

必须保持原子性的操作：

- Task 状态和 Task Event；
- Artifact 元数据和 Task 输出关联；
- Session 创建时的 Session、初始 AgentSlot 与 Runtime attachment；若初始 Slot 使用 RoleBinding，其 Slot、attachment 和私有不可变 Role source snapshot 与 Session 在同一事务内提交。未绑定初始 Slot 不写 Role snapshot；
- Run 终态和失败原因；
- start 的 Run、Task、用户 Message、Slot claim、command receipt 和 ContextSource 联合创建；
- PermissionRequest 状态、回答/过期时间与对应的 Run/Task 状态变化；权限决定必须支持带 `lease_until` 的原子 claim → complete/release，服务重启时释放过期 claim，避免多个协调器向 Adapter 重复应答。

## 分页和恢复

- 历史 Activity 使用稳定游标；
- Event 在同一 Run 内使用单调 sequence；
- 服务启动时扫描未完成 Run；
- 进程运行期间按持久化 `soft_timeout_at` / `expires_at` 扫描 `pending` 请求；服务启动时不假定旧 Adapter 或 ACP Session 仍存在。未能重新挂接 Runtime 的 pending 请求必须在同一事务中以 `runtime_unavailable` 原因收敛为 `expired`，对应 Run 改为 `interrupted`、Task 改为 `paused`，写入系统 Message 和事件且不调用失效 Runtime；`overdue_at` / `expired_at` 保证幂等。Phase 1F 起启动恢复按附件重挂接，顺序见「Run 闭环持久化」；
- 大型内容使用 checksum 和文件引用；
- 删除 Workspace 不默认删除源代码。

## 事件保留与压缩

事件会持续增长，按以下策略控制：

- **Session 活跃期全量保留**，保证可完整重放；
- **Session 归档时压缩**：保留状态转换类事件（`run.*`、`task.*`、`session.*`、`artifact.created`、`agent.permission_*`），丢弃流式增量类事件（如 `agent_message_chunk`）；
- 压缩是**不可逆**操作，必须在 Session 进入归档状态后执行，不能在活跃 Session 上做；
- 压缩后 `sequence` 不重排，保留原始值以保证游标稳定；
- 不设时间 TTL：删除历史必须由用户显式触发，避免误删。

## Run 闭环持久化（Phase 1F）

- `runtime_attachments`：单 Slot 一行的私有 Runtime 现场（含 ACP Session ID、配置 revision、Adapter 版本与指纹、cwd/运行目录），不进入公共 DTO。已软删除 Slot 的 attachment 在 ACP Session/connection 确认关闭前保留为 cleanup record；正常 recover 不将其挂入活动 Runtime，单独的 teardown-only 恢复关闭后再删除记录。
- `agent_slot_role_snapshots`：单 Slot 一行的不可变私有 Role/RoleBinding source 字段与版本；不保存渲染 ContextBundle/Prompt，不进入公共 DTO。
- `context_sources`：每 Task 保存 Role、RoleBinding、原始 Message 的 source ID/version，不保存其渲染文本；迁移前的可恢复用户输入回填为 Message source。
- `command_receipts`：`(workspace_id, request_id, command)` 幂等回执，带 `dispatch_state`。start 命令保存 `target_slot_id`、`input_digest`（不可逆输入摘要，不存原文）；`add_slot` 先用 `reserved/not_started` 持久预留稳定 Slot ID 与 RoleBinding 摘要，Slot/attachment/Role snapshot 与 completed receipt 同事务提交。若进程在 ACP 初始化后、最终事务前崩溃，重试允许 ACP 初始化 at-least-once，但不会派发 Run/prompt，最终只保留一个持久 Slot；fake/offline 测试不证明真实 Adapter 子进程在父进程崩溃后的 OS 清理。迁移前 start receipt 的 NULL target 只对应 Session 原始 Slot；retry 子 Run 的 Run/Task/Message 引用与 receipt 同事务提交，rollback 需按状态和引用 CAS，防止 stale dispatch。
- `slot_activity_claims`：`slot_id` 唯一键，保证单 Slot 单活动 Run；`recovery_conflict` hold 让启动时无法判断归属的现场 fail-closed。
- `runs` 增加 `state_revision`（CAS）、`retry_of_run_id`、`retry_chain_id`；`tasks.input_message_id` 为私有输入关联。
- migration v5 只回填可唯一确定的 `input_message_id`，无法证明唯一对应的保持 NULL（不可恢复）；migration v7 为 `agent_slots` 增加私有 `deleted_at`，软删除保留历史 Slot/Run/Task/Permission/Role snapshot 行，默认未绑定 Slot 不可删除。
- 配置更新与模型目录替换、Run/Task/回执/claim 的跨表变更都在同一 SQLite 事务内提交。

## 迁移

每个数据库变更有 migration version、向前迁移、备份提示和集成测试。当前 Provider 配置字段由 migration v3 增加 `codex_config_json` 和单调 `config_revision`；Provider 更新使用 `id + workspace_id + expected config_revision` 条件写入并检查 affected rows。migration v4 增加 `permission_requests.adapter_request_id_encoded`，用带标签编码（`n:` / `s:`）保存 ACP JSON-RPC request ID，从而保留 number / string 类型身份；旧列 `adapter_request_id` 只有裸文本、无法还原原类型，迁移时固定按 **string** 身份编码（旧版本确实按 string 使用该字段），读取端对无标签或非法编码解码为 `null` 而不是猜测类型。migration v6 为 start 回执增加 nullable `target_slot_id` 与 `input_digest`，创建私有 `agent_slot_role_snapshots` / `context_sources`，并把历史 Task 中唯一确定的 `input_message_id` 回填为 Message source；旧 receipt 的 NULL target 由 Application 解释为原始 Slot、NULL 摘要退化为比较 Message。migration v7 为 `agent_slots` 增加 nullable `deleted_at`；已删除 Slot 的历史外键行保留，Runtime attachment 作为 cleanup record 留到 ACP connection 关闭确认后。`CURRENT_SCHEMA_VERSION` 必须与最新 migration 一致，否则已处于上一版的数据库会跳过新迁移。不可逆迁移必须明确告知用户。

第一阶段必须建立以下约束和索引：

- `events(run_id, sequence)` 唯一约束，保证同一 Run 的 sequence 单调且不重复；
- `permission_requests(status, expires_at)` 索引，支持服务重启后的超时扫描；
- `tasks(run_id, status)`、`messages(session_id, created_at)` 和 `artifacts(session_id, created_at)` 索引；
- 所有 Workspace 归属查询都带 `workspace_id` 条件，避免跨 Workspace 读取；
- Local Token 默认不建明文列；跨重启持久化时只允许 `token_hash` 和生命周期元数据，原文由 Keychain 管理。

## 依赖

允许依赖：domain Port、SQLite Driver、JSON 文件 API。

禁止依赖：ACP、Coordinator、Vue、HTTP Controller。

## 输入、输出和错误

输入是领域命令、实体和事件；输出是 Repository 查询结果、事务结果或迁移错误。

## 状态和不变量

事务内的状态和事件必须原子提交；迁移版本只能向前；损坏数据库必须阻止静默覆盖。

## 持久化

SQLite 保存运行状态，JSON 保存用户配置，文件系统保存大型 Artifact；EventStore 保存事件用于 replay。

## 事件

Persistence 不决定业务事件；Application 在 EventStore 事务成功后，通过 EventBusPort 进行实时分发。

## 安全边界

文件路径必须在允许目录内；Artifact 内容按权限读取；数据库不保存 Credential 原文。

## 替换和升级策略

Repository 实现可替换，只需保持 Port、事务、分页和迁移语义。

## 已知限制

第一阶段只支持本地 SQLite，不提供多进程远程数据库协作。

## 测试

测试事务回滚、并发冲突、迁移、损坏数据库、断电恢复和分页边界。

## Phase 2 handoff 持久化（migration v8）

migration v8 为 `messages` 增加 nullable `kind`、`to_slot_id` 和私有 `handoff_request_id`，并建立 `(session_id, handoff_request_id)` 部分唯一索引；旧消息保持 NULL。`runs` 增加私有 `event_sequence` 与 `completed_sequence`：新 Run 从 0 初始化，重复事件与游标在同一 SQLite 写事务内提交；成功完成时冻结 `completed_sequence`，之后仅 handoff 专用 metadata Event 可推进 `event_sequence`。普通 append、权限状态/事件与 recovery 对 completed/failed/cancelled 一律拒绝；legacy Run 的游标保持 NULL，不能用于 handoff。

Event 分页为两阶段读取：同一读事务内先查询 `length(CAST(payload_json AS BLOB))` 与边界元数据（每页最多 8 条、单条 512 KiB、每页 4 MiB），全部通过后才读取 payload 并映射；超限 payload 不进入 JS、不 parse。

## Web Phase 2/3 目标迁移（v9，未实现）

目标态 schema v9：`workspaces.root_path`（nullable + 部分唯一索引）、Task `node_key/attempt/retry_of_task_id` + `(run_id,node_key,attempt)` 唯一、`task_dependencies`、Run Workflow 快照字段、`agent_slots.context_generation`、`slot_reset_intents`、Artifact 元数据/intent、Mailbox read marker、Workflow template。旧行不猜测：root 保持 NULL；唯一单 Task 可回填 `node_key='legacy'`，其余保持 NULL 并 fail-closed。迁移前备份 SQLite（含 WAL checkpoint），失败回滚；回滚方式为恢复备份。当前 schema 为 v8。

## SQLite 初始化失败资源释放

`SqliteDatabase` 构造函数先打开 SQLite 连接，再设置 PRAGMA 并执行迁移。连接打开后的任一步失败（PRAGMA 或 migration）都会尽力关闭该连接，再抛出初始化错误：

- 初始化主错误作为抛出错误的 `cause` 原样保留（包括非 `Error` 的 throw 值）；`cause` 与 `AggregateError.errors` 保存原始值，message 只做安全格式化；
- 若连接关闭也失败，抛出 `AggregateError`，`errors` 同时包含原始初始化值与原始关闭值，且保留初始化值作为 `cause`；不静默吞掉任一错误；
- 连接尚未创建（`new Database` 本身失败）时没有可关闭的资源，仍按初始化失败处理。

容量测量测试夹具据此在构造失败时删除受控临时目录；该行为仅保证资源释放与诊断，不改变迁移语义或 schema。
