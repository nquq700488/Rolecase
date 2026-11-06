# Mailbox 模块

> 状态：当前切片仅支持现有单 Task handoff 的收件摘要、详情读取与 unread/read 状态；不扩展 handoff 来源归属。

## 目标

为 Session 内的目标 AgentSlot 提供隔离的 handoff 收件视图。列表与详情读取保持纯读；只有用户显式标记已读时才持久化 `read`。

## 对外提供的能力

- 仅查询 `kind='handoff'` 且 `to_slot_id` 与请求 Slot 相同的消息。
- 返回不含正文的摘要页，并通过单条详情读取正文。
- 以 `unread` / `read` 和 nullable `read_at` 表示收件状态；迁移前已有 handoff 默认 unread。
- 使用 `created_at DESC, message_id DESC` 稳定排序和有界 keyset 分页。默认 `limit=50`、最大 `100`；响应包含 `items`、`next_cursor`。
- 由 Web 在用户打开详情后显式请求 mark-read；详情 GET 本身不写状态。

## 不提供的能力

普通 Message 收件、`delivered` / `acknowledged` 状态、多 Task handoff 来源选择、推断 Task/Event lineage、打开后自动投递或注入 Agent context、自动 dispatch、全量 unread count、outbox/通知补发、Artifact UI、Coordinator 或 Workflow 状态转换。

## 公共接口

```text
GET  /api/sessions/:sessionId/mailbox?slot_id=...&limit=...&cursor=...
GET  /api/sessions/:sessionId/mailbox/:messageId?slot_id=...
POST /api/sessions/:sessionId/mailbox/:messageId/read
```

列表返回严格的分页摘要，不含消息正文。详情返回既有 Message 数据及 Mailbox 收件状态。mark-read 请求通过严格 Contract 提供 `slot_id`；成功响应给出已读状态及 `event_bus_status`（`published`、`failed` 或 `not_attempted`）。既有 `MessageDto`、handoff 请求与 Session snapshot shape 不变。

## 输入、输出和错误

- `sessionId`、`messageId`、`slot_id`、`limit`、`cursor` 均在 Contract 边界校验；limit 超过 100 或 cursor 格式无效时拒绝请求。
- 不存在、跨 Session/Workspace、目标 Slot 不符、cursor 不属于当前可见收件范围、或目标并非 handoff，统一返回不可用语义，不暴露消息或资源存在性。
- 参数校验沿用现有 HTTP Contract 错误映射；不可用响应使用同一稳定错误类型，详情与错误均不包含未授权正文。

## 状态和不变量

- 缺少 read marker 表示 `unread`；唯一 marker 表示 `read`，其 `recipient_slot_id` 必须匹配 Message 接收 Slot。
- 列表、详情 GET 不写 marker/Event，不改变 Run、Task、Workflow 或 Slot claim。
- 首次 mark-read 在一个 SQLite 事务中写 marker 与 metadata-only `message.read` Event；任一步失败则整体回滚。EventBus 仅在事务提交后 best-effort 发布。
- EventBus 发布成功返回 `published`；发布失败仍返回已持久化的 read 状态并返回 `failed`；重复或并发标记不增加 marker/Event、不重复发布，返回 `not_attempted`。
- `message.read` 不含正文、不推进来源 Run 的 `completed_sequence`。持久化 marker 与 Event 是权威状态；读取 API 反映已提交状态。
- 游标绑定当前 Session/Workspace/Slot 中可见的 handoff。后续页使用末项的稳定排序键及 keyset 条件，避免同时间戳条目重复或遗漏。
- Web 未读数字只统计已加载摘要，必须标注“已加载未读”；`next_cursor` 非空时提示仍有更多消息，不得声称是 Slot 全量未读数。

## 允许依赖

Application 依赖 Mailbox Repository Port、EventBus Port、Clock/ID Port 及既有 Domain/Contract 类型。Infrastructure 实现归属查询、SQLite marker/Event 事务与通知发布。

## 禁止依赖

Domain/Application 直接依赖 SQLite Driver、Fastify、Vue 或 ACP/Provider SDK；HTTP 直接执行 SQL；Mailbox 读取驱动消息发送、Runtime dispatch、Task/Run 状态迁移或 context 注入。

## 持久化

SQLite migration v11 前向新增 `mailbox_read_markers` 表、收件索引与 handoff 部分索引（`sqlite-mailbox-store.ts`）。marker 以 `message_id` 唯一标识状态转换并引用既有 Message/Slot，保存接收 Slot 与 `read_at`。既有 handoff 不需回填，marker 缺失即 unread。查询按 Session、接收 Slot 与 handoff kind 过滤，使用有界 keyset 分页；列表只选择摘要列，不读取正文。迁移不改写既有 Message、Event、Run 或 Session snapshot。历史 fixture 缺少 `messages` 表时迁移跳过建表（fail-open 到后续版本）。

## 事件

首次显式标记已读时写入 `message.read` metadata Event，仅含 Message/接收 Slot 标识与时间，并与 marker 同事务提交。它只追加 metadata，不改变来源 Run 完成水位；EventBus 发布在 commit 后 best-effort 执行，不提供 outbox 或重放补发保证。

## 安全边界

所有路由继续经过既有 Local Token、Host、Origin 安全 hooks。每次查询或写入都核验 Session→Workspace、Slot→Session、Message→Session/Workspace/目标 Slot 关系以及 handoff kind。跨作用域与资源缺失使用统一不可用语义；列表摘要不含正文，错误和日志不泄露正文或资源存在性。

## 替换和升级策略

Mailbox Repository Port 可由其他存储实现替换，但必须保持归属隔离、稳定排序/游标语义、marker 幂等、marker/Event 原子性及 EventBus best-effort 结果语义。数据库只做向前 migration；通用 terminal Event writer 不放宽，`message.read` 只能通过受限 metadata 写入路径追加。

## 测试策略

使用新建临时 SQLite、合成 handoff 与 Fake EventBus 覆盖默认 unread、纯读、分页边界/游标隔离、详情、mark-read 幂等与并发、Event 插入回滚、EventBus 拒绝，以及 Session/Workspace/Slot/handoff 隔离。Web 测试覆盖部分未读计数、分页提示、显式 mark-read、失败可恢复及 Session/Slot 切换；浏览器验收使用本地合成数据，不连接真实 Server/Provider。

## 已知限制

仅支持现有 Run 恰有一个 Task 的 handoff；多 Task handoff 在 Task attempt 与 Event lineage 可验证前保持 fail-closed。`event_bus_status='failed'` 表示持久化已成功、实时通知可能未送达；调用方可重新读取 API。未读数字是当前已加载摘要的部分计数，不是 Slot 全量计数。
