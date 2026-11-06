# Artifact 模块（SQLite inline 切片）

> 状态：当前获批的服务端 API/持久化范围；仅 SQLite inline 文本，UTF-8 正文上限 65,536 字节。
> 文件 Artifact、Coordinator、上传/删除、Run-scoped 列表与 Q/P/N 生产 admission 不在当前范围。Session-scoped metadata 分页与纯文本按需预览 UI 已作为独立 Web 切片接入；这不代表文件模式或完整 Stage 2 已完成。

---

## 目标

将同一 Session 中已完成 Run 的唯一已完成 Task 所持久化 Agent 文本，脱敏后保存为可校验的 inline Artifact。Artifact 不自动注入 Context，也不执行其中指令。

Workspace 必须已有 `root_path`。创建时通过 `WorkspaceRootPathPort.resolveExistingDirectory` 复核路径仍可访问且 canonical 值未变化；该检查不创建、枚举、读取或写入目录内容。inline 存储只访问 SQLite，不依赖目录句柄能力 Gate。文件写入仍受 `docs/architecture/文件系统目录句柄能力证据.md` 的 fail-closed 门约束。

## 对外提供的能力

- 从请求指定的同 Session、`completed` Run 创建 Artifact；该 Run 必须恰有一个 `completed` Task。
- 仅读取 `completed_sequence` 以内连续、可信的持久化 `agent.message` 文本；不接收任意用户文本、Coordinator 输出、文件或 Credential 内容。
- 创建前后均按 UTF-8 字节计数；超过 65,536 字节拒绝，不转存文件。
- 使用 `SecretRedactionPort` 脱敏后保存原始 UTF-8 bytes、byte length 和 SHA-256。
- 通过 Session-scoped API 分别读取 metadata 与内容；读取内容先校验长度及摘要。
- Web 按 Session 分页读取 metadata；只有用户显式打开单项时才请求独立 content endpoint，并以纯文本预览。
- `(session_id, request_id)` 幂等；同 key/同来源返回既有 Artifact，同 key/异来源冲突。

## 不提供的能力

任意文件上传、目录浏览、文件选择器、外部 URL 抓取、跨 Session/Workspace 读取、公开直链、Run-scoped 列表、内容搜索、全文索引、Artifact 更新/删除、自动 Context 注入或 Agent 指令执行、大于 65,536 字节的文件后备路径、无 Workspace root 时的 cwd/默认目录回退。

## 输入、输出和错误

```text
POST /api/sessions/:sessionId/artifacts
  request: { source_run_id, request_id }
  response: ArtifactDto（仅 metadata）

GET /api/sessions/:sessionId/artifacts?limit=&cursor=
  response: ArtifactPageDto（items 仅含 metadata，带 next_cursor）

GET /api/sessions/:sessionId/artifacts/:artifactId
  response: ArtifactDto（仅 metadata）

GET /api/sessions/:sessionId/artifacts/:artifactId/content
  response: ArtifactContentDto（独立返回文本）
```

`ArtifactPageQuery` 的 `limit` 默认 50、最大 100，`cursor` 可选；页面按 `created_at DESC, id DESC` 稳定 keyset 分页。`ArtifactPageDto` 为 `{ items: ArtifactDto[], next_cursor: string | null }`；列表只返回 metadata，不读取或传输正文。游标不属于当前 Session/Workspace 时统一返回 `artifact_unavailable`；未知 Session 使用 `not_found`。

`ArtifactDto` 字段：`id`、`workspace_id`、`session_id`、`task_id`、`source_run_id`、固定 `media_type`（`text/plain; charset=utf-8`）、`storage_kind='inline'`、`status='ready'`、`size_bytes`、`sha256`、`created_at`。不含正文、`content_ref`、文件路径或 Secret。`ArtifactContentDto` 只含 `artifact_id`、`media_type`、`content`。

| 错误码 | HTTP | 场景 |
| --- | ---: | --- |
| `invalid_request` | 400 | 请求 Schema 或路由 ID 无效 |
| `source_history_unavailable` | 409 | Run/Task 不合格、输出为空、序列缺口或历史矛盾（含零 Task、单个未完成 Task） |
| `artifact_too_large` | 413 | 脱敏前或脱敏后 UTF-8 内容超过 65,536 字节 |
| `workspace_root_unconfigured` | 409 | Workspace 未配置 root path |
| `workspace_root_unavailable` | 409 | root path 不存在、不可访问或 canonical 路径已变化 |
| `artifact_request_conflict` | 409 | 同一 Session/request_id 指向不同来源 Run |
| `artifact_unavailable` | 404 | Artifact 不存在、跨 Session，或内容完整性校验失败 |
| `artifact_sanitization_failed` | 500 | 脱敏 Port 缺失、抛错或返回无效结果 |

不存在与跨 Session 读取统一隐藏为 `artifact_unavailable`。错误、日志和事件不得含正文、Secret 或路径。创建与读取继续受现有 Local Token、Host、Origin 安全 hooks 保护。

## 状态和不变量

- Artifact、BLOB、metadata-only `artifact.created` Event 在同一 SQLite 事务提交；事务成功后才发布 EventBus。
- 来源拒绝时 Artifact/Event 写入增量为 0。Run 必须 `completed`，唯一 Task 必须 `completed`；只读取 `1..completed_sequence`，检查连续性且不读取完成水位之外的事件。
- 脱敏失败不回退到原文。脱敏前后都以 UTF-8 bytes 校验上限。
- 读取前校验 BLOB 实际长度、`size_bytes` 与 SHA-256；任一不一致均不返回正文。
- 幂等重放不新增 Artifact/Event、不重复发布。completed Run 的专用 Artifact metadata writer 只允许 `artifact.created`，推进 `event_sequence` 但不改变冻结的 `completed_sequence`；不放宽通用 terminal Run Event writer。
- 内容仅由单独 content 路由返回，不进入 metadata、Event、日志或其他 DTO。

## 允许依赖

Application 依赖聚焦的 Artifact Store Port、Repository/Run Event 读取 Port、`WorkspaceRootPathPort`、`SecretRedactionPort`、Clock/ID Port。Infrastructure 实现 SQLite/BLOB、路径验证与现有脱敏边界。

## 禁止依赖

Domain/Application 直接依赖 Node `fs`、SQLite Driver、Provider SDK、HTTP/Web；Artifact 内容进入 Event/日志/metadata DTO；以 `realpath` 后绝对路径执行文件操作。

## 持久化与迁移

SQLite schema v10 新增 inline-only `artifacts` 表、`content_blob BLOB`、`(session_id, request_id)` 唯一索引及大小/归属约束。记录 Workspace/Session/Task/来源 Run、固定媒体类型、`storage_kind='inline'`、`status='ready'`、byte length、SHA-256 与创建时间。迁移不创建目录、不回填 Artifact；v9 的 `workspaces.root_path` 值保持不变。当前表不含 `content_ref`、绝对路径、write intent、staging 或文件分支。

## 事件

`artifact.created` 仅携带 Artifact metadata，不含正文；它与 BLOB/metadata 在同一 SQLite 事务提交。提交成功后才发布 EventBus；completed Run 的专用 writer 只追加此类 Artifact metadata Event，推进 `event_sequence` 而不改变冻结的 `completed_sequence`。

## 安全边界

- 来源文本来自已持久化、已脱敏的 Agent Event；写入前再次调用 `SecretRedactionPort`。不读取 Keychain 原文。
- 使用合成 Secret canary 验证原文不会进入 BLOB、metadata/content DTO、Event、错误或日志。
- inline Artifact 要求有效 Workspace root，但不对该目录执行文件操作；文件 Artifact 在 dirfd 能力 Gate 通过且单独获批前仍不可实现。

## 替换和升级策略

Artifact Store 可在保持 `ArtifactStorePort` 事务、幂等、完整性与事件语义的前提下替换实现。SQLite schema 采用前向 migration；未来文件存储或新的响应形状须单独设计 Contract 与迁移，不复用当前 inline 表为隐式文件模式。

## 已知限制

当前仅支持 ≤65,536 UTF-8 bytes 的 inline 文本；Web 提供 Session-scoped metadata 有界分页及显式打开后的纯文本预览，不提供搜索、更新、删除或 Coordinator 来源。SQLite commit 后、EventBus 发布前进程崩溃时，持久化 Event 可 replay，但 EventBus 不提供跨进程 exactly-once。

## 测试

使用独立临时 SQLite 与合成 Secret 覆盖来源资格、字节边界、脱敏拒绝、幂等、事务回滚、Session 隔离及 BLOB 长度/SHA-256 完整性校验；不得连接真实 Server/Provider 或读取真实凭据.
