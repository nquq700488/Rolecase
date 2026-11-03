# ADR：Web Phase 2/3 Stage 0 冻结契约

> 状态：**Stage 0 草案，待 Reviewer 接受与用户批准；本文全部为目标态，尚未实现。**
> 计划：`~/.claude/plans/declarative-hugging-cosmos.md`（Web Phase 2/3）。
> 当前代码基线：Contract/Domain `TaskStatus` 无 `starting`/`blocked`；SQLite schema v8；Workspace DTO 无 `root_path`；无 Artifact/Workflow/Mailbox/reset 实现。

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

### 3.2 目标 API 与错误（未实现）

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

## 5. Artifact 契约（新模块，目标态）

能力文档：`docs/modules/artifacts.md`。

- ≤64 KiB（UTF-8）inline 存 SQLite；>64 KiB 写 `<root_path>/.rolecast/artifacts/<session_id>/<artifact_id>`，DB 只存 Workspace 相对 `content_ref`、SHA-256、大小与元数据。
- 所有 Artifact 先要求有效 `root_path`；路径 containment、symlink/traversal 拒绝；读取先校验哈希，失败统一 `artifact_unavailable`，不返回损坏内容。
- 大文件固定流程：来源校验与脱敏 → 事务写 `artifact_write_intent`（operation/request ID、artifact ID、受限相对 staging/final 目标；不含原文）→ 同 Workspace 以 no-follow exclusive create 写 staging → fsync 文件 → 原子 rename → fsync 父目录 → 最后一个 SQLite 事务写 `ready` 元数据、Task/Run 引用与事件并删除 intent。
- 公开 API/Task/Coordinator 只读 `ready`；DB commit 前不可见。
- **崩溃/恢复表：**

| 崩溃点 | intent | 文件系统 | 重启处理 | 对外可见 |
| --- | --- | --- | --- | --- |
| intent 已写，staging 未写 | 有 | 无 | 删除 intent | 否 |
| staging 写入中/已写，未 rename | 有 | staging | 仅删除 intent 关联 staging，删除 intent | 否 |
| rename 完成，DB commit 前 | 有 | final | 仅删除该 intent 关联 final，删除 intent | 否 |
| DB commit 成功 | 已删除 | final | 无需恢复 | 是（ready） |
| 文件存在但无 intent/元数据 | 无 | unknown | 隔离，不提供读取、不递归删除 | 否 |
| rename/fsync/commit 任一失败 | 有 | 不确定 | 保持不可见，fail-closed | 否 |

- 同 request ID 重放返回同一 Artifact，不产生第二文件/行。
- Secret：只接受任务输出、Coordinator 产物或受控用户文本；写入前用现有 `SecretRedactionPort` 脱敏；脱敏缺失/抛错/输出无效时拒绝写入，错误与日志不含正文。不得接受 Credential 字段、Keychain 原文或任意文件上传。
- 测试使用唯一合成 Secret canary，扫描 SQLite、staging/final 文件、API、事件与日志；替代标记可用。

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

## 8. v9 迁移契约（目标态，未实现）

当前 schema 版本为 **v8**（handoff Message 字段、Run 游标与完成水位）。本切片计划前向迁移到 **v9**：

| 变更 | 说明 | 旧数据 |
| --- | --- | --- |
| `workspaces.root_path TEXT NULL` + `WHERE root_path IS NOT NULL` 唯一索引 | Artifact 根目录 | 全部保持 NULL |
| `tasks.node_key TEXT NULL`、`attempt INTEGER NOT NULL DEFAULT 1`、`retry_of_task_id TEXT NULL` | 节点/attempt | 唯一单 Task Run 可回填 `node_key='legacy'`、attempt=1；多 Task 或无法唯一证明保持 NULL |
| `task_dependencies(run_id, node_key, depends_on_node_key)` | 依赖边 | 不回填，空表 |
| `runs.workflow_snapshot_json TEXT NULL`、`template_id TEXT NULL`、`template_version INTEGER NULL` | Workflow 快照 | 旧 Run 保持 NULL |
| `agent_slots.context_generation INTEGER NOT NULL DEFAULT 1` | reset fence | 旧 Slot 置 1 |
| `slot_reset_intents(...)` | reset intent | 空表 |
| `artifacts(...)`、`artifact_write_intents(...)` | Artifact 元数据/恢复 | 空表 |
| `mailbox_read_markers(message_id, slot_id, read_at)` | Mailbox read | 空表 |
| `workflow_templates(...)` | 模板 | 空表 |

- 唯一/外键约束在 migration 事务内创建；`node_key`、`root_path` 的部分唯一索引只对非 NULL 生效。
- 迁移失败整体回滚；迁移前备份 SQLite 文件（含 WAL checkpoint）；回滚方式为恢复备份文件，不做破坏性 downgrade。
- 旧单 Agent Run/Task/Message/handoff 保持可读；无法唯一映射的旧关系不猜测，相关 resume/dispatch/handoff 返回 `source_history_unavailable` 或 `state_conflict`。
- 迁移集成测试：v8 fixture → v9，断言旧字段/行不变、新列 NULL/默认值正确、唯一索引生效、失败回滚。

---

## 9. 未决与用户决策

1. **Q/P/N 数值**：0B 最小测量能力已获用户批准（尚未实现），生产 admission 保持 fail-closed；0B 在参考机产出曲线后由用户决定资源目标并书面批准，未批准前不冻结数字。
2. **文件系统实现依赖**：Node 22 核心无 dirfd-relative API；受维护 native 依赖（如 `@openclaw/fs-safe`）的 macOS 语义未验证，且本轮禁止安装依赖。**文件模式** Artifact 写入保持 fail-closed；SQLite inline 不受该门阻断（仍需有效 `root_path`）。需用户决定是否批准后续引入并验证依赖。
3. **Schema v9 的字段命名/索引**：本 ADR 为冻结候选，Reviewer 接受后生效。
4. 桌面端、视觉重做、真实 Provider/live 测试、通用 Workspace CRUD 不在范围。
