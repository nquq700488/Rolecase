# ADR：Web Phase 2/3 Stage 0 冻结契约

> 状态：**Stage 0 契约已通过 Reviewer 审查；Workspace 根路径与 SQLite inline Artifact 切片已实现，其余 Phase 2/3 能力仍为目标态。**
> 计划：`~/.claude/plans/declarative-hugging-cosmos.md`（Web Phase 2/3）。
> 当前代码基线：Contract/Domain `TaskStatus` 无 `starting`/`blocked`；SQLite schema v11；Workspace 根路径通过独立 API 读写且 `WorkspaceDto` 不含该字段；Artifact inline metadata/content API 与持久化已实现；单 Task handoff 的 Mailbox 收件（unread/read）已实现；文件 Artifact/Workflow/多 Task handoff/reset 尚未实现。

---

## 1. 范围与门禁

本 ADR 只冻结 Stage 0 所需契约：Task/Run 状态模型、attempt 与依赖、Workspace 根路径、`source_task_id`、Artifact 崩溃/恢复、reset fence、容量错误映射与 v9 迁移。

- 不包含任何实现，不修改 `packages/`、`apps/`、运行时、Contract 或数据库 schema。
- **0A 文档审查门**：本 ADR 与 Stage 0 文档经 Reviewer 接受后，才启动 Stage 1+ 实现；各阶段仍受自身专项门约束。
- **0B 测量实现门**：用户已于 2026-10-28 批准先实现仅由测试 harness 注入上限的最小测量能力；生产 admission 在额度未获批准前保持 fail-closed。0B 不因 Q/P/N 未批准而阻断。
- **0C 用户额度门**：0B 在参考机（Node `v22.21.1` / `darwin` / `arm64`）产出 Q/P/N 曲线后暂停，由用户决定资源目标并书面批准额度。仅容量相关实现（Stage 4 Q/P admission、Stage 5 N admission）受 0C 约束；其他阶段不因 Q/P/N 未批准被阻断。
- **文件 Artifact dirfd 门**：仅约束文件模式 Artifact。SQLite inline 不执行文件创建/rename/unlink，不受该门阻断，但仍要求已配置且有效的 `root_path`。Node 22/macOS 核心 API 无法证明 dirfd-relative、逐组件 no-follow 的 create/rename/unlink；在未批准并验证受维护依赖前，**文件写入保持 fail-closed，Stage 2 文件路径不得进入实施**。
- 不涉及容量 admission 或文件写入的阶段，只受 0A 与自身阶段验收约束。

---

## 2. Task / Run 状态模型

### 2.1 Task 状态（目标态，新增 `starting` 与 `blocked`）

```text
TaskStatus = queued | blocked | starting | running | paused
           | completed | failed | cancelled | interrupted
```

目标转换表（替换当前 `TASK_TRANSITIONS`；`completed/failed/cancelled` 为终态）：

| From | 允许的 Next | 说明 |
| --- | --- | --- |
| queued | blocked, starting, cancelled | 依赖未满足 → blocked；派发准备 → starting |
| blocked | queued, failed | 依赖满足 → queued；依赖永久不可满足 → failed（`dependency_failed`） |
| starting | running, failed, cancelled, interrupted | 完成 Runtime 派发准备后才进入 running |
| running | paused, completed, failed, cancelled, interrupted | 保持现有语义 |
| paused | running, interrupted | 保持现有可恢复语义 |
| interrupted | running, cancelled | 恢复只能经正式 resume |
| completed / failed / cancelled | — | 终态 |

- **Run 不新增 `blocked`**；`RunStatus` 保持现有 union（含 `queued`）。
- 依赖未满足使用 Task `blocked`，TaskBoard 显示持久化依赖边与阻断原因。
- 未知状态一律 fail-closed，不降级为 `queued`/`running`。

### 2.2 Run 聚合（目标态）

优先级从高到低：

1. 有 pending Permission → `waiting_user`
2. 有 `starting`/`running` Task → `running`
3. 存在可运行、queued 或依赖等待的 Task → `queued`
4. 用户请求 pause 且无活动 turn → `paused`
5. 恢复失败 → `interrupted`
6. 所有节点最新 attempt completed → `completed`
7. 存在耗尽重试的失败且无可继续工作 → `failed`
8. 取消请求下所有活动 turn 停止、其余 Task 取消 → `cancelled`

- 上游完成：依赖满足的 `blocked` → `queued`。
- 上游 failed/cancelled 且依赖永久不可满足：未执行后继 → `failed` + `dependency_failed`。
- 服务重启按同一规则重算并持久化；`completed` 只在所有所需节点最新 attempt completed 后提交。

### 2.3 Attempt、节点与事件归属（目标态）

- Task 字段：`node_key`（同一逻辑节点稳定键）、`attempt`（从 1 开始）、`retry_of_task_id`。
- 唯一约束：`(run_id, node_key, attempt)`。
- Event 必须携带 `run_id + task_id + node_key + attempt`（放在 Event payload 元数据中；不复制正文、不含 Secret）。
- 依赖边以 `node_key` 表达：`task_dependencies(run_id, node_key, depends_on_node_key)`，同 Run 内唯一；拒绝环、跨 Session/Workspace 引用。
- 旧 attempt/Event 不覆盖；所有查询按最新 attempt 或指定 attempt 明确读取。

### 2.4 Retry 语义（目标态）

- **Task retry**：仅 failed/interrupted/cancelled 且仍可重试；依赖必须满足；不得有已 dispatch 后代 attempt。否则 409 `task_retry_requires_run_retry`。新 `task_id`、`attempt+1`、`retry_of_task_id` 指向旧 Task；旧 Task/Event 保留。成功后才排入尚未执行且依赖满足的后继。
- **Run retry**：对 failed/interrupted/cancelled Workflow Run 创建新 Run attempt 与完整节点快照；新 attempt 全部从 `queued` 开始；旧 Run/Task/Event/Artifact 保留。UI 必须明确 at-least-once 与重复外部副作用风险并二次确认。
- 重试上限由 Workflow 节点配置的有限正整数决定；未配置或非有限值时 fail-closed，Stage 0 不假设默认数字。

---

## 3. Workspace 根路径（Artifact 前置）

### 3.1 契约

- 新 Workspace 创建请求必须包含 `root_path`：用户输入的现存目录**绝对路径**；Web 只用文本输入，说明路径由本机服务端访问。
- Application 通过 filesystem Port 校验：存在、是目录、可访问；`realpath` 后只保存规范路径。悬空 symlink、非目录、不可访问、解析失败均拒绝。允许指向目录的 symlink，但存 canonical 路径。
- 规范路径唯一：数据库事务内再次检查（并发下唯一索引兜底）；与另一 Workspace 相同 canonical 路径 → 409。
- 旧 Workspace 不从 cwd、数据库位置或任何隐式来源推导；迁移后 `root_path=NULL`。
- 一次性补设：仅当 `root_path IS NULL`，经同一校验后 CAS 写入；已配置后不可覆盖。
- `WorkspaceDto` 响应形状保持不变；新增 `WorkspaceRootPathDto { workspace_id, root_path: string | null }` 与查询/补设 API。
- 所有 Artifact（inline 与文件）要求已配置 root；未配置时零写入、不回落 cwd。

### 3.2 API 与错误（Workspace 根路径已实现；Artifact 错误仍为目标）

```text
POST /api/workspaces                         # body 增加 root_path（必填）
GET  /api/workspaces/:workspaceId/root-path
POST /api/workspaces/:workspaceId/root-path  # 仅 root_path IS NULL 时
```

| 错误码 | HTTP | 场景 |
| --- | --- | --- |
| `workspace_root_required` | 422 | 新 Workspace 创建缺少 `root_path`（旧客户端兼容读取但不兼容创建） |
| `workspace_root_invalid` | 422 | 不存在、非目录、不可访问、悬空 symlink、非绝对路径 |
| `workspace_root_duplicate` | 409 | canonical 路径已被另一 Workspace 使用 |
| `workspace_root_already_configured` | 409 | 对已配置 Workspace 再次补设 |
| `workspace_root_unconfigured` | 409 | Artifact 创建时 Workspace 尚无有效 root |

---

## 4. Handoff `source_task_id`（目标态）

- 当前 handoff 只支持「来源 Run 恰有一个 Task」；多 Task Run 尚未实现。
- 目标请求增加可选 `source_task_id`：来源 Run 有多个 Task 时**必填**，必须属于该 Run 且指向该节点最新且 completed 的 Task attempt。
- 仅当来源 Run 恰有一个 Task 时，旧请求可省略并推导该 Task；不得在多 Task 场景静默任选。
- 只拼接所选 Task 的持久化 `agent.message` 输出；来源 Slot 由该 Task 推导；保持现有幂等键、Message 持久化、不创建 Run/Task/claim、不自动 dispatch/注入上下文。
- Event 缺少 `task_id/node_key/attempt` 且 Run 非单 Task 时 fail-closed。

| 错误码 | HTTP | 场景 |
| --- | --- | --- |
| `source_task_required` | 422 | 多 Task Run 未提供 `source_task_id` |
| `source_task_invalid` | 409 | Task 不属于来源 Run、非最新 attempt 或非 completed |

---

## 5. Artifact 契约（当前获批：SQLite inline-only）

能力文档：`docs/modules/artifacts.md`。本节为当前已批准的服务端切片；本 ADR 的历史文件模式设计不代表文件写入获批或已实现。

- 只接受同 Session 下 `completed` Run 的唯一 `completed` Task；仅提取 `1..completed_sequence` 连续、可信的持久化 `agent.message` 文本。零 Task、单个未完成 Task、多 Task、归属不一致、空输出或历史缺口均拒绝，Artifact/Event 增量为 0。
- 只接受最多 65,536 UTF-8 bytes；来源原文及脱敏结果均检查字节数。超限返回 413 `artifact_too_large`，不转成文件。
- 创建前复核已保存 Workspace `root_path`；缺失返回 409 `workspace_root_unconfigured`，失效/不可访问/canonical 值变化返回 409 `workspace_root_unavailable`。检查不读写目录内容；内容读取只访问 SQLite。
- Contract：`POST /api/sessions/:sessionId/artifacts` 接受 `{ source_run_id, request_id }`；Session-scoped metadata GET 与独立 content GET 分别返回严格 DTO。metadata/Event 不含正文、路径或 Secret；不存在与跨 Session 内容读取统一返回 404 `artifact_unavailable`。
- SQLite migration v10 增加 inline-only BLOB、大小、SHA-256 和 `(session_id, request_id)` 唯一约束；读取校验实际 byte length、`size_bytes` 与 digest。
- 脱敏 Port 缺失/抛错/输出无效返回 500 `artifact_sanitization_failed`，不得回退保存原文。Artifact BLOB/metadata 与 metadata-only `artifact.created` 在同一事务提交，提交后发布 EventBus。
- 幂等键同来源返回原 Artifact；异来源冲突为 409 `artifact_request_conflict`。完成态 Run 的窄授权 writer 只允许 `artifact.created`，不推进冻结的 `completed_sequence`，不放宽通用 terminal Event writer。
- 稳定错误映射：`invalid_request` 400、`source_history_unavailable` 409、`artifact_too_large` 413、`workspace_root_unconfigured` 409、`workspace_root_unavailable` 409、`artifact_request_conflict` 409、`artifact_unavailable` 404、`artifact_sanitization_failed` 500。
- 计划早期的 64 KiB inline/文件双路径、`content_ref` 与 intent/staging/rename/recovery 是后续文件模式设计，不属于当前实现范围；没有通过目录句柄能力 Gate 前禁止实现文件写入及 realpath 后绝对路径 fallback。

---

## 6. Reset-context 共享 fence（目标态）

- Slot 持久化 `context_generation`（迁移后默认 1）与唯一 `slot_reset_intents(slot_id PRIMARY KEY, operation_id, from_generation, to_generation, stage, created_at)`；每个 Run/Task/Slot claim 保存创建时 generation。
- 所有 start/resume/retry/queued dispatch 在**同一 SQLite 写事务**内确认：`reset_intent IS NULL`、generation 匹配、取得 Slot claim，之后才可 Runtime dispatch。
- Reset 前置：Slot 无 claim、无非终态 Run/Task、无 pending Permission；否则 409 `reset_conflict`。
- 流程：事务写 intent → 通过既有 Runtime connection 调用 `createSession(connection, cwd)`（同一 AdapterContext 内 `session/new`，不 spawn 新 Adapter）→ 成功后单事务提交新 attachment 与 `generation+1` → 提交后关闭旧 ACP Session。
- 失败：保留旧 attachment/generation，清理候选并释放 intent；清理不确定 → 保留 recovery hold（`reset_recovery_required`），禁止 dispatch。
- 崩溃恢复：attachment/generation 未提交 → 清候选、释放 intent；已提交 → 只关闭旧 ACP Session、清 intent，不回滚 generation。任何不确定状态保持 hold，不跨 generation 自动重派。

---

## 7. 容量 Q/P/N（待用户批准，未冻结）

- 作用域：本机 Rolecast 安装的 SQLite/Runtime 全局，所有 Workspace 共用。
- 既有事实：最多 **4 个活动 Adapter subprocesses**（`docs/modules/orchestration.md`），可配置；不得推导进程树或 OS process 总数。
- `Q`（queued Task）、`P`（pending Permission）、`N`（每 Workflow/Template 节点总数）必须是有限正整数；**Stage 0 未提出数值，等待用户批准**。未冻结前对应阶段不实现容量 gate。
- 错误映射（目标态）：

| 错误码 | HTTP/行为 | 场景 |
| --- | --- | --- |
| `scheduler_capacity_reached` | 429 | 达到 Q，新 Run/Workflow 在事务写入前拒绝，无半创建记录 |
| `permission_capacity_exceeded` | deny + 事件 + Run interrupted | 达到 P，新 permission 不创建 pending，回送 deny；不自动 approve |
| `capacity_overcommitted` | 启动拒绝新 admission | 恢复后现存负载超限；保留全部现场，不删队列/权限 |

- 计数并发不得超额；重启后按持久化状态重建；超限无部分写入。

---

## 8. SQLite migration 版本状态

Workspace 根路径 migration v9 已实现；当前 inline Artifact 单独使用 migration v10；Mailbox 收件状态使用 migration v11。早期 Stage 0 草案将 Workspace root、Artifact、Workflow、reset 与 Mailbox 一并列入 v9，已被后续分层迁移取代，不是当前 schema 契约。

| 版本 | 变更 | 旧数据 |
| --- | --- | --- |
| v9（已实现） | `workspaces.root_path TEXT NULL` + 非 NULL 唯一索引 | 既有 Workspace 保持 NULL；当前用户补设值必须保留 |
| v10（当前 Artifact 切片） | inline-only `artifacts` BLOB/metadata 表及 `(session_id, request_id)` 唯一索引 | Artifact 表为空；v9 `root_path` 与既有数据保持不变 |
| v11（Mailbox 收件切片） | `mailbox_read_markers`、按接收方索引、handoff 部分索引 | 历史 handoff 不回填 marker，一律 unread；v10 Artifact 与既有数据不变 |
| 后续版本（未实现） | Task node/attempt、依赖、Workflow snapshot、reset intent/generation、文件 Artifact intents 等 | 另行设计 migration，不提前占用版本或假定回填 |

- 每个前向迁移在 SQLite 事务内建立约束；迁移失败整体回滚。不可逆变更前按项目备份策略保护数据库，不做破坏性 downgrade。
- 旧单 Agent Run/Task/Message/handoff 保持可读；无法唯一映射的旧关系不猜测，相关操作 fail-closed。
- migration 测试须以独立旧版数据库 fixture 升级；v10 测试由 v9 fixture 验证，断言既有 `root_path` 和旧表数据不变、Artifact 表/索引约束正确、失败时迁移回滚。

---

## 9. 未决与用户决策

1. **Q/P/N 数值**：0B 最小测量能力已实现，0C 本机合成容量曲线与报告已完成（见 `容量基线.md` 及同目录 CSV）；当前等待用户审阅、决定资源目标并书面批准有限 Q/P/N。测量结果不构成额度批准，生产 admission 继续 fail-closed；未获书面批准前不冻结数字。
2. **文件系统实现依赖**：Node 22 核心无 dirfd-relative API；受维护 native 依赖（如 `@openclaw/fs-safe`）的 macOS 语义未验证，且本轮禁止安装依赖。**文件模式** Artifact 写入保持 fail-closed；SQLite inline 不受该门阻断（仍需有效 `root_path`）。需用户决定是否批准后续引入并验证依赖。
3. 早期把 Workspace root 与其他 Phase 2 schema 合并至 v9 的草案已过期；当前事实为 Workspace root migration v9 已实现、inline Artifact 独立使用 v10。
4. 桌面端、视觉重做、真实 Provider/live 测试、通用 Workspace CRUD 不在范围。
