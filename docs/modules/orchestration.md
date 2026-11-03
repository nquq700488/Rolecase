# Orchestration 模块

## 目标

负责 Coordinator、Workflow、Task、AgentSlot 的调度和状态推进。

## 对外提供的能力

```text
createTask(input)
assignTask(taskId, slotId)
startRun(sessionId, workflowId)
pauseRun(runId)
resumeRun(runId)
cancelRun(runId)
retryTask(taskId)
handlePermissionRequest(request)
expirePermission(requestId)
handleAgentResult(result)
handleAgentFailure(failure)
```

## Coordinator

Coordinator 是可配置 Role，不固定为某个 Provider。它可以：

- 创建 Task；
- 分配 AgentSlot；
- 读取相关 Artifact；
- 请求重试；
- 请求用户确认；
- 汇总阶段结果；
- 发送和查询 Message/Mailbox。

它不能绕过权限系统执行本地命令。

## 第一阶段能力

Workflow 的表达方式为**表单式配置**，底层数据模型预留 Node / Edge：

- UI 第一版只暴露顺序步骤与有限并行组，用户不接触图形编辑器；
- 数据模型用 `nodes[]` / `edges[]` 表达，不写成线性数组，避免后续加图形编辑时改库；
- 顺序步骤；
- 有限并行组；
- 成功/失败依赖；
- 人工确认；
- 最大重试次数；
- 队列、暂停、取消和恢复。

## Run 命令（Phase 1F）

- 单 Slot 单活动 Run：`slot_activity_claims` 保证同一 ACP Session 不会被两个 request_id 并发 `sendTurn`；冲突返回 409，不排队。
- `cancel` 先把 Run CAS 到 `cancelling`，再调用 `cancelTurn`；pending Permission 走 claim/complete 记录 `cancelled`，取消失败必须显式报错。`session/cancel` 只是 notification，必须等待活动 turn 结束或 `turn_cancelled` 证据；无法确认时 Run/Task 收敛为 `interrupted`，不能只凭通知成功就写 `cancelled`。
- `resume` 只允许 `paused`/`interrupted` 且无 pending Permission，在同一 Run/attempt 上重放原输入，不创建新 Run。
- `retry` 只允许 `failed`/`interrupted`/`cancelled` 且必须是 retry chain 叶节点；新建 attempt+1 的 Run、持久化新 attachment 并复用原用户 Message。子 Run/Task/ContextSource 与 receipt refs 同事务提交；未派发回滚以 status、dispatch_state 和 child refs 做 CAS，CAS miss 不删除 Run/claim 或覆盖 receipt。重建 Session 或 dispatch 失败时回滚或保留可同 key 重试的 `failed/not_dispatched` 现场。
- 完成/失败/取消统一以 `state_revision` CAS 在同一事务中更新 Run、Task 与 claim；终态（completed/failed/cancelled）不可被迟到事件覆盖。

## AgentSlot 定向会话（Phase 2 初始切片）

- 一个 Session 可包含多个 AgentSlot；每个 Slot 持有独立 ACP Session、私有 Runtime attachment 和 Role source snapshot。运行时 registry 以 `slot_id` 为 key。
- 新 Slot 必须从所属 Workspace 选择启用且可派发的 RoleBinding；ProviderConnection/model 在创建时解析并固定，Role/Binding 的后续编辑只作用于新 Slot。非空 `runtime_options` 暂不支持。
- 消息可显式携带 `agent_slot_id`。旧客户端省略时稳定选择原始、未绑定 Role 的默认 Slot；Session/Slot 不匹配在 Runtime 工作前拒绝。
- 每条 Task 的 `slot_id` 决定 send、resume/retry、cancel、permission response 与恢复时使用哪个 Runtime；同 Slot 单活动 Run 约束不变，不同 Slot 可独立运行。
- Role 的 `system_prompt`、guidelines 和 `output_contract` 从 Slot snapshot 构造 ContextBundle；因通用 ACP 只有文本 prompt block，渲染后的标签段作为普通 prompt text 发送，不具备 system-role 权威。`MessageDto.content` 仍只保存原始用户文本。
- 非默认 Slot 可软删除，但存在 claim 或任何非终态 Run（含 paused/interrupted/recovery conflict）时返回 409；历史 Run/Task/Message/Permission 与 Role snapshot 保留。删除后新消息不能再针对该 Slot 派发；attachment 留作 teardown-only cleanup record，关闭 ACP connection 后删除。

## 并发与恢复

- **并发上限默认 4 个 Adapter 子进程**，可配置。每个 Adapter 是 Node 进程且可能再拉起 CLI 子进程，内存开销大；超限的任务进入 `queued`，不排队堆积无上限；
- **服务重启后的恢复顺序**：先按 attachment 逐个 `connect → session/resume` → 恢复成功的非终态 Run 回到 `paused` 等待用户决定继续；恢复失败的标记 `interrupted` 并保留 attachment/现场。没有 attachment 的历史非终态 Run 直接收敛 `interrupted`，然后按真实 Run 重建 Slot claim；同 Slot 多个非终态 Run 建立 `recovery_conflict` hold。不自动重跑、不静默丢弃；
- 终态不可回退；`interrupted` 不是终态，可由用户决定继续或重跑。

## 权限等待与超时

`PermissionRequest` 的状态推进由 Orchestration 负责，Adapter 只提供请求和选项：

1. 收到请求后先在事务中保存 PermissionRequest，再把 Run 改为 `waiting_user`、所属 Task 改为 `paused`；
2. 立即发布 `agent.permission_requested`，通过 WebSocket 呈现 Adapter 原样提供的选项；
3. 默认 5 分钟后发布 `agent.permission_overdue`，只提升提醒，不自动批准或拒绝；
4. 默认 30 分钟后将请求改为 `expired`，调用 `AgentRuntimePort` 回传拒绝/取消，发布 `agent.permission_expired` 和 `run.interrupted`，并创建可审计的系统 Message；
5. 过期后的回答返回状态冲突，不得再次调用 Runtime，也不得自动重跑；回答/取消必须先以 `lease_until` claim 权限决定，Adapter 应答成功后再以原子 complete 同步 PermissionRequest、Run 和 Task；服务重启时先释放过期 claim。ACP 数字 request ID 必须单独保存其字符串化映射，不能用 Rolecast Permission ID 替代；权限状态事件必须追加到 EventStore 并经 EventBus 推送。

Run 的 `waiting_user` 和 Task 的 `paused` 都不是终态。硬超时产生的 `interrupted` 仍可由用户查看现场后继续或创建新的重试 attempt。软、硬超时由服务端持久化时间戳驱动，服务重启后必须恢复待处理计时；浏览器是否在线不影响计时。`overdue_at` / `expired_at` 用于幂等，避免服务重启重复发送提醒或重复回传拒绝。

权限等待不占用可调度的执行槽，但 Adapter 进程仍占用系统资源；实现必须另设待处理请求数量和进程资源上限，防止通过大量权限等待绕过默认 4 个 Adapter 的资源保护。

## 依赖

允许依赖：domain、ContextBuilderPort、AgentRuntimePort、RepositoryPort、EventBusPort、EventStorePort、ClockPort。

禁止依赖：具体 ACP 包、HTTP、Vue、数据库 Driver。

## 状态规则

终态不能静默改写。`resumeRun` 只允许 `paused`/`interrupted`，且必须没有 pending Permission（`waiting_user` 需先回答或取消）；`interrupted` 会按 attachment 尝试重挂接，失败则返回 409。它复用当前 Run，不创建新 attempt，并在同一 CAS 事务中发布 `run.resumed`。`retryTask` / Run retry 创建新 attempt，保留原始失败事件。服务重启时从 Repository 恢复未完成 Run；权限等待必须先回答或过期，不能绕过 PermissionRequest 直接 resume。

## 输入、输出和错误

输入是 Session、Workflow、AgentSlot、Task 和 Runtime Event；输出是 Task/Run 状态变化、Message 和 Artifact 引用。

## 状态和不变量

同一个 Task 不能被多个 Slot 同时取得前台执行权；终态不可回退；重试必须增加 attempt。

## 持久化

通过 Repository、MessageRepository 和 EventStore Port 保存状态，不直接写 SQLite。

## 事件

发布 task.*、run.*、message.created、artifact.created 和 permission 等事件。

## 安全边界

只能调度当前 Workspace/Session 的 Slot；不能绕过 PermissionRequest 或读取其他 Workspace。

## 替换和升级策略

调度策略可替换，但必须保持 Task 状态机、Run 状态机和事件语义。

## 已知限制

第一阶段只支持顺序步骤和有限并行；不支持无限递归 Coordinator。

## 测试

使用 Fake Runtime 测试顺序、并行、阻断、重试、取消、权限等待和崩溃恢复。

## Phase 2 handoff 边界

handoff 只持久化定向 Message，不创建 Run/Task/claim、不自动调度 Agent、不实现 Coordinator/TaskBoard/Workflow。

## Web Phase 2/3 目标调度与容量（未实现）

目标态：依赖驱动的 Task 调度（`blocked/queued/starting/running`）、多 Task Run 聚合、pause/resume/cancel/retry 与重启恢复；Q（queued Task）/P（pending Permission）/N（Workflow 节点）为全局有限容量，数值**待用户批准**（见 `docs/architecture/容量基线.md`）。既有的最多 4 个活动 Adapter subprocesses 事实不变；不推导进程树或 OS process 总数。reset 与所有 dispatch 共享 coverage generation/intent fence。

## 0B 容量测量能力（内部，生产关闭）

- **边界策略**：`packages/server/src/application/orchestration/capacity-admission.ts` 提供纯函数 `evaluateCapacity`，覆盖 Q（queued Task）、P（pending Permission）、N（Workflow 总节点数）三个维度；规则为 `used + requested <= limit`。额度必须是三个有限正整数；缺失、非法、负值、小数、NaN/Infinity 或非法 usage 一律 fail-closed，返回稳定内部原因（`limits_unconfigured` / `limits_invalid` / `usage_invalid` / `capacity_exceeded`），无默认值。
- **测试专用注入**：额度只由隔离测试 harness 显式传入；策略不读取环境变量、生产配置、DI composition、Runtime、日志或 SQLite。`packages/server/src/main.ts` 不导入该模块；测试以源码断言与环境变量注入双重验证。生产 composition 不读取任何测试额度。
- **使用量来源**：测试夹具用文件型临时 SQLite 的真实 `tasks.status='queued'` 与 `permission_requests.status='pending'` 行计数（安装级全局，不按 Workspace），关闭并重开后计数一致；quota 本身不写入数据库。N 只接受调用方预先计算的总节点数整数，0B 不负责也不声称验证 DAG/嵌套遍历（留 Stage 5）。
- **测试覆盖**：低于/恰好达到/limit+1；缺失/非法额度；SQLite 关闭重开计数；**同一 Node 进程/同一 SQLite 连接的顺序事务边界**（未验证多连接/跨进程并发，真正并发曲线留 0C/Stage 4）；失败事务整体回滚；拒绝路径零 Run/Task/Permission 写入、Fake Runtime dispatch 0 次。Dispatch 只在 SQLite admission 事务 commit 且接受后由 Fake Runtime spy 记录，拒绝路径不会触达 Runtime；不启动真实 Adapter。该证据只证明测试夹具，不证明未来生产 Scheduler/Permission admission 事务或真实 Adapter 资源。
- **生产状态**：当前没有容量受限的生产入口；生产 admission 在用户书面批准 Q/P/N 前保持 fail-closed。legacy 单 Agent Run 与 Permission 注册路径未接入该策略，回归测试证明其行为不变。
- **未完成**：0C 曲线未采集；未提出或冻结任何 Q/P/N 数值；未修改 schema、RepositoryPort、HTTP、Contract、Runtime 或既有 Run/Permission 行为。
