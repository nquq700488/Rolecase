# Domain 模块

## 目标

定义核心实体、状态转换和不变量，并消费稳定的 Application Port。该模块不依赖任何外部运行时。

## 核心实体

```text
Workspace
ProviderDefinition
ProviderConnection
ModelCatalogEntry
Role
RoleBinding
Session
AgentSlot
WorkflowTemplate
Task
Message
Artifact
Run
Event
PermissionRequest
```

## 对外提供的能力

- 创建和校验实体；
- 执行状态转换；
- 定义不可变 Domain Event；
- 消费 `application/ports` 中定义的稳定边界；
- 暴露领域错误。

## 关键不变量

- Task 只能分配给当前 Session 的 AgentSlot；
- Role 属于且只能属于一个 Workspace，名称 trim 后不能为空；
- RoleBinding 必须引用同一 Workspace 的 Role、ProviderConnection 和 Model；Model 必须属于指定 ProviderConnection；
- RoleBinding 的 version 必须单调递增，更新不能覆盖其他版本；
- RoleBinding 必须引用同一 Workspace 的 Role 和 Provider；
- AgentSlot 的 provider/model 是创建时解析的有效快照，RoleBinding 变更不追溯修改既有 Slot；
- Message 必须属于 Session，接收者只能是 Slot、用户或广播范围；
- Artifact 必须有 Task 或用户来源；
- Run 进入终态后不能接受新 Task；
- PermissionRequest 只能从 `pending` 转为 `answered` 或 `expired`，过期后不能再回答；
- PermissionRequest 硬超时必须关联 `Run.interrupted`，不能静默变为 completed；
- `environment_mode=isolated` 的 ProviderConnection 必须具有完整的非秘密配置来源；
- Credential 原文不能进入实体；
- 取消不能被静默改成 completed。

## 依赖

允许依赖：语言标准库、不可变数据工具。

禁止依赖：ACP、HTTP、SQLite、文件系统、Vue、进程 API。

## 输入、输出和错误

输入是 Application 传入的命令值对象；输出是新的领域对象或 Domain Event；错误表示不变量违反或非法状态转换。

## 状态和不变量

实体状态只能通过领域方法转换；终态不可回退；所有集合和事件对象不可变。

## 持久化

无。由 Repository Port 的基础设施实现负责。

## 事件

产生不可变 Domain Event，由 Application 发布到 EventBusPort。

## 安全边界

领域实体不得包含 Credential 原文、文件系统路径之外的秘密或未验证外部对象。

## 替换和升级策略

实体变更必须同步迁移、Contract Mapper 和不变量测试；Port 名称和语义变更需要 ADR。

## 已知限制

Domain 不知道外部 Provider 的真实能力，能力差异由 Providers 和 Runtime 转换。

## 测试

- 状态机单元测试；
- 不变量测试；
- Property-based 测试；
- 不可变对象测试；
- Port 的 Fake Contract Test。

## Web Phase 2/3 目标状态机（未实现）

目标态：`TaskStatus` 增加 `starting`（派发准备）与 `blocked`（依赖未满足），补充 `queued→blocked→queued`、`blocked→failed/dependency_failed`、`queued→starting→running` 转换；Task 增加 `node_key`/`attempt`/`retry_of_task_id` 与依赖边。Run 状态 union 不变，按 ADR 第 2.2 节聚合；Task retry 与 Run retry 的边界、at-least-once 确认见 ADR 第 2.4 节。当前 Domain 仍只有既有状态与转换。
