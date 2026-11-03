# Events 模块

## 目标

提供内部不可变事件总线，把 Domain/Application/Runtime 事件传递给持久化、HTTP 和 WebSocket。

## 对外提供的能力

```text
publish(event)
subscribe(filter, handler)
unsubscribe(subscriptionId)
replay(streamId, afterSequence)
```

## Event Envelope

```text
event_id
schema_version
workspace_id
session_id
run_id
sequence
type
source
occurred_at
payload
```

## 事件类型

```text
session.created
session.agent_added
message.created
message.read
run.accepted
run.started
run.paused
run.resumed
run.completed
run.failed
run.cancelled
run.waiting_user
run.interrupted
task.queued
task.started
task.paused
task.blocked
task.completed
task.failed
task.cancelled
artifact.created
agent.permission_requested
agent.permission_overdue
agent.permission_answered
agent.permission_expired
agent.status_changed
```

## 规则

- 事件对象不可变；
- 修正通过新事件表达；
- sequence 在同一 Run 内单调递增；
- 事件发布失败必须被记录，不能静默丢弃；
- 大型内容使用引用，不直接塞入事件；
- Event Bus 负责内存发布订阅，Event Store 负责持久化和 replay。

## 依赖

允许依赖：domain Event、EventBusPort、EventStorePort。

禁止依赖：Vue、具体 WebSocket、ACP 帧、数据库 Driver。

## 输入、输出和错误

输入是不可变 Domain/Application/Runtime Event；输出是订阅通知或 EventStore 写入结果；处理器错误必须隔离并记录。

## 状态和不变量

Event ID 唯一；同一 Run 的 sequence 单调递增；Event 不可修改；replay 顺序稳定。

## 持久化

EventStorePort 负责持久化和 replay；EventBusPort 负责实时发布订阅；两者是不同边界。

## 事件

本模块定义 Event Envelope 和事件类型，不拥有具体业务状态。

## 安全边界

事件 payload 不得包含密钥和未经授权的大型私有内容；大型内容只传引用。

## 替换和升级策略

Bus 和 Store 可以分别替换；事件字段和 schema_version 必须保持兼容。

## 已知限制

第一阶段事件总线为单进程实现，不提供跨机器分布式投递。

## 测试

测试顺序、重复订阅、断线重放、过滤、事件版本和处理器失败隔离。

## Phase 2 per-Run sequence 与 handoff metadata Event

Event sequence 是 per-Run：新 Run 从 1 连续分配，所有生产 Run-scoped writer（普通 append、权限事件、recovery、finalizeRun）在同一 SQLite 事务内更新 `event_sequence`。`completed_sequence` 只在成功完成事务中冻结，表示 Agent 输出完整性边界；completed 后仅 handoff 专用 writer 可追加 `type='message.created'` 的 metadata Event（sequence = event_sequence+1），不改变 `completed_sequence`，且该 Event 不参与正文拼接。

## Web Phase 2/3 目标事件（未实现）

目标态：Task 相关 Event 携带 `task_id/node_key/attempt`；新增 Artifact `artifact.created`（仅元数据，不含正文）、Mailbox read marker、capacity 拒绝、reset generation/intent 事件；Artifact 事件与 ready 元数据同事务提交，EventBus 仅在提交后发布。
