# Artifact 模块（Phase 2/3 目标态）

> 状态：**能力文档，目标态；尚未实现。**
> 前置：所有 Artifact 都要求 Workspace `root_path` 已配置且有效。SQLite inline 不做文件系统操作，不受 dirfd 门阻断；文件写入还受 `docs/architecture/文件系统目录句柄能力证据.md` 的 fail-closed 门约束。

---

## 目标

把任务输出、Coordinator 产物或用户受控文本持久化为可审计的 Artifact：小内容内联存储，大内容写入 Workspace 管理的文件目录；读取时可校验完整性并保证 Workspace 隔离。Artifact 不自动注入 Context，也不自动执行其中指令。

## 对外提供的能力

- 从合规来源创建 Artifact：≤64 KiB（UTF-8）inline；>64 KiB 写 Workspace 文件。
- 持久化元数据：ID、Workspace/Session/Task 引用、媒体类型、字节数、SHA-256、Workspace 相对 `content_ref`、状态。
- 读取 ready Artifact 的元数据与内容；读取时校验哈希。
- 按 request ID / operation ID 幂等重放。
- crash recovery：仅依据 `artifact_write_intent` 清理关联 staging/final；未知文件隔离。
- 任务/Workflow 对 Artifact 的引用在同一 SQLite 事务内随 ready 元数据提交。

## 不提供的能力

- 任意文件上传、目录浏览、文件选择器或外部 URL 抓取。
- 跨 Workspace 读取、公开直链、内容搜索、全文索引。
- 自动把 Artifact 注入 ACP Context 或作为 Agent 指令执行。
- 无 Workspace root 时的 cwd/默认目录回退。
- 对未知自由文本中所有秘密的通用识别（仅覆盖 Rolecast 管理的 Redaction scope）。

## 输入、输出和错误

目标 API（未实现）：

```text
POST /api/sessions/:sessionId/artifacts        # 来源：task_output / coordinator_output / controlled_text
GET  /api/artifacts/:artifactId                # 元数据
GET  /api/artifacts/:artifactId/content        # ready 内容或受控预览
```

| 错误码 | HTTP | 场景 |
| --- | --- | --- |
| `workspace_root_unconfigured` | 409 | Workspace 未配置有效根目录；零写入、不回退 |
| `workspace_root_invalid` | 422 | 根路径失效、非目录或无法 canonicalize |
| `artifact_unavailable` | 404 | 不存在、跨 Workspace、哈希不匹配或损坏 |
| `invalid_request` | 422 | 来源/媒体类型/大小等请求无效 |

创建/读取不得返回 staging 内容或未 commit 的文件；错误与日志不含输入正文或 Secret。

## 状态和不变量

- 写入阶段：`intent`（私有）→ `staging` → `renamed` → `ready`（DB commit）。只有 `ready` 对外可见。
- 不变量：一个 request ID 最多一个 Artifact；ready row 才有 `content_ref`/哈希；文件内容与哈希一致；inline 内容不进入文件系统；文件路径始终位于 `<root_path>/.rolecast/artifacts/<session_id>/<artifact_id>`。
- 崩溃不变量：无 intent 且无元数据的未知文件不可读、不自动删除；intent 清理只触碰其明确关联路径。
- 任何 fsync/rename/DB commit 失败都不发布 Artifact；恢复失败保持 fail-closed。

## 允许依赖

Application 依赖 `RepositoryPort`、filesystem Port（路径校验与受控文件操作）、`SecretRedactionPort`、Clock/ID Port。Persistence 依赖 SQLite；Infrastructure 实现文件系统与脱敏边界。

## 禁止依赖

- Domain/Application 直接依赖 Node `fs`、SQLite Driver、Provider SDK、HTTP/Web。
- Artifact 内容进入 Adapter argv、Prompt、Event、日志或公共 DTO。
- 以 `realpath` 检查后的未锚定绝对路径执行 create/rename/unlink（当前无安全实现时 fail-closed）。

## 持久化

目标 schema v9（见 ADR 第 8 节）：

- `artifacts(id, workspace_id, session_id, task_id?, media_type, size_bytes, sha256, content_ref, storage_kind, status, created_at)`。
- `artifact_write_intents(operation_id/request_id, artifact_id, workspace_id, session_id, relative_staging_path, relative_final_path, stage, created_at)`，不含原始内容。
- inline 内容存 SQLite 受控列；文件内容仅存于 Workspace root 下。

迁移：旧库无 Artifact 行；新表为空；`workspaces.root_path` 默认 NULL，未配置时所有 Artifact 创建 fail-closed。

## 事件

目标事件：`artifact.created`（payload 仅含 artifact_id、workspace/session/task 引用、size、sha256、storage_kind，不含正文）与 ready 元数据在**同一 SQLite 事务**提交；EventBus 仅在该事务 commit 后发布。失败/清理不发布 created 事件。

## 安全边界

- 来源必须是任务已脱敏输出、Coordinator 产物或用户受控文本；写入前再次调用 `SecretRedactionPort`。
- 只接受 `credential_ref` 引用，不读取 Keychain 原文；不接受 Credential 字段或任意文件上传。
- 脱敏缺失、抛错或输出无效时拒绝写入；错误不含输入正文。
- 使用合成 Secret canary 测试：SQLite、staging/final 文件、API、事件、日志中原文出现次数为 0。
- 路径 containment、逐组件 no-follow、symlink/traversal 拒绝；当前文件系统能力未证明，文件写入保持阻断。

## 替换和升级策略

- `content_ref` 是存储位置间接层；未来可替换存储后端（如对象存储）而不改变公共 DTO。
- 迁移只增表/列，不破坏旧数据；回滚通过备份恢复 SQLite 文件。
- inline 只依赖已配置的 `root_path` 与 SQLite，不受 dirfd 门阻断；文件模式在安全目录句柄实现被证明并获批前保持 fail-closed、不实施。

## 已知限制

- 文件系统 dirfd-relative 能力未证明，**文件模式** Artifact 写入 BLOCKED；SQLite inline 不受该能力门阻断（仍受 `root_path` 与阶段门约束）。
- TLS/外部日志不在本模块范围；脱敏只覆盖 Rolecast 管理的 Secret scope。
- SQLite 与文件系统不能组成同一原子事务，依赖 intent 与 reconciliation 收敛；提交后 EventBus 发布存在进程崩溃窗口。
- 不支持跨设备原子 rename；staging 与 final 必须在同一 Workspace 文件系统。
