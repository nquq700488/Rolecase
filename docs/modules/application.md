# Application 模块

## 目标

把用户动作转换为领域用例，通过 Port 调用基础设施，隔离 UI 和基础设施细节。

## 用例

```text
CreateWorkspace
ConfigureProviderConnection
CreateCredential
PreviewProviderConfigImport
ApplyProviderConfigImport
DiscoverProviderModels
CreateRole
UpdateRole
DeleteRole
CreateRoleBinding
UpdateRoleBinding
DeleteRoleBinding
CreateSession
AddAgentSlot
SendSessionMessage
CreateTask
RunWorkflow
CancelRun
ResumeRun
AnswerPermissionRequest
ExpirePermissionRequest
StoreArtifact
ResumeSession
RetryTask
```

## 对外提供的能力

- 用例级命令处理；
- 输入校验和权限检查；
- 事务边界编排（单 Agent Run + Task + 用户 Message 必须同一事务）；
- Role / RoleBinding 配置用例的 Workspace mutation、引用完整性和乐观并发控制；
- Codex 配置导入 preview/apply 的目标绑定、摘要校验、Credential 引用校验和 ProviderConnection `config_revision` CAS；
- Credential 创建用例（`CredentialService.create`）：只调用 `CredentialStorePort.save(idempotency_key, secret)` 并返回引用，不调用 `get`、不缓存 Secret；同一幂等键 + 同一 Secret 返回同一引用，同键异值映射 409 `credential_idempotency_conflict`，无效/拒绝/不可用分别映射 422 / 403 / 503；
- PermissionScheduler 驱动运行中 PermissionRequest 的软/硬超时；
- Domain Event 发布；
- 稳定的应用错误。

## 幂等命令（Phase 1F）

`ConversationService` 以 `request_id` 驱动命令回执：`reserved → running(started) → completed`。connect/createSession/resumeSession 阶段的确定性失败转 `failed/not_dispatched`，同 key 可安全重试；越过 dispatch 后结果未知才转 `ambiguous`。回执重放先于 Run 状态与 Runtime 可用性检查；`failed/not_dispatched` 可以复用已创建的 Run/Task/Message/子 attempt，不重复副作用。回执不保存 Prompt、输入 hash 或 Secret；start 的同键输入比较通过既有 Message 内容完成。

accepted 只能由 Runtime 的 dispatch 信号或已收到的 Runtime Event 证明。turn 正常结束但两者都没有时按结果未知处理：回执转 `ambiguous`，Run 收敛 `interrupted`（`dispatch_unconfirmed`），保留 Slot claim，同 key 重放返回 409 而不重派。若该 ambiguous 写回抛错或 CAS 未命中，回执保持在 `running/started` 并保留 claim，不降级为 `failed/not_dispatched`，由启动恢复转 ambiguous；无活动 turn 的 `running/started` 回执重放同样返回 409。

Run 的完成、失败与取消统一走 `state_revision` CAS 事务，同时更新 Run、Task 并释放 claim。取消必须先等待活动 turn 结束或 `turn_cancelled` 事件；`cancelTurn` 通知成功不等于停止，无法确认时收敛 `interrupted`。retry 建立的新 ACP Session 先持久化 attachment，再替换内存 Runtime 并关闭旧 Session/连接。

## 依赖

允许依赖：domain、`application/ports`、ClockPort、IdGeneratorPort、CredentialStorePort（引用校验与按幂等键写入）。

禁止依赖：具体 ACP 包、SQLite Driver、Keychain SDK、WebSocket、Vue。

## Application 层内的用例模块

以下目录属于 Application 层，但每个模块都有独立 README、Port 和测试边界；它们不是可以互相直接调用实现细节的内部类：

```text
application/
├── workspace
├── providers
├── credentials
├── roles
├── sessions
├── orchestration
├── context
└── runs
```

`orchestration` 和 `context` 是独立的能力模块，Application 通过它们的 Port 使用能力。具体边界见各自模块文档。

## 错误规则

- 不吞掉基础设施错误；
- 将可恢复、不可恢复和用户输入错误区分；
- 不向外暴露内部堆栈或密钥；
- 每个命令生成 request_id。

## 输入、输出和错误

输入是 Contract 转换后的 Application Command；输出是 DTO Mapper 可消费的结果或事件；错误分为输入、冲突、基础设施和不可恢复错误。

## 状态和不变量

用例必须通过 Domain 方法修改状态；跨 Repository 的状态变化必须由 Application 设定事务边界。

## 持久化

通过 Repository Port 和 RoleConfigRepositoryPort 持久化，不直接访问数据库或文件；Role/Binding 的 JSON 原子写入由 Config Port 实现。

## 事件

成功、失败和等待用户的用例必须发布 Domain/Application Event。

## 安全边界

执行文件、Provider 和凭据操作前必须检查 Workspace、Session 和 Local Token 对应的权限上下文。

## 替换和升级策略

基础设施替换只需保持 Port；用例输入输出变更必须更新 Contract 和 Application Test。

## 已知限制

Application 不提供长时间运行的进程状态机，持续运行交给 Orchestration 和 ACP Runtime。

## 测试

使用 Fake Port 测试所有用例，不启动真实 Adapter 或数据库。重点覆盖事务失败、并发状态冲突和重试。

## Phase 2 handoff（已完成 Run → 目标 Slot）

`HandoffService` 只接受 `status=completed` 且 `completed_sequence` 非 NULL 的来源 Run，且该 Run 恰好有一个 Task；来源 Slot 由 Task 推导，目标 Slot 必须同 Session、未软删除且不同于来源。服务按 `1..completed_sequence` 有界分页拼接 `agent.message` 文本，UTF-8 正文上限 64 KiB；`source_history_unavailable` / `source_event_payload_too_large` / `handoff_content_too_large` 分别映射 409/413/413。幂等 lookup 先于来源正文读取与目标 Slot 活动状态校验：同 Session/key/source/target 即使目标 Slot 已软删除也返回原 Message；参数不同 409。handoff Message、私有幂等键与 metadata-only `message.created` Event 在同一事务提交，EventBus 在提交后发布。不创建 Run/Task/claim，不调用 Runtime，不自动 dispatch 或注入 ACP Context。

## Web Phase 2/3 目标能力（未实现）

目标态：Workspace 创建/一次性补设经 filesystem Port 校验 canonical root；HandoffService 支持多 Task 的 `source_task_id`；新增 Artifact 应用服务（脱敏、64 KiB 分流、intent/ready 编排）、Workflow/Coordinator 调度与 Q/P/N admission、Slot reset fence（generation/intent/claim 同事务）。Artifact 文件写入因目录句柄能力未证明保持 BLOCKED；当前 Application 无这些能力。
