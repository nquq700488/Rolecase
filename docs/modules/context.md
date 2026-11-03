# Context 模块

## 目标

把 Workspace、Session、Task、Role 和 Artifact 组装成某个 Agent 需要的最小上下文。

## 对外提供的能力

```text
buildWorkspaceContext(workspaceId)
buildSessionSummary(sessionId)
buildTaskContext(taskId)
selectArtifacts(taskId, references)
buildContextBundle(input)
recordContextSources(bundle)
```

## ContextBundle

```text
ContextBundle
├── system_instructions
├── task_input
├── referenced_artifacts
├── session_summary
├── constraints
└── output_contract
```

## AgentSlot Role 上下文初始切片

Role-bound AgentSlot 的 ContextBundle 由 Slot 私有 source snapshot 与原始 Task input 构建：Role `system_prompt` 和顺序固定的 `required_guidelines` 进入 `system_instructions`，原始用户 Message 进入 `task_input`，`output_contract` 保持独立字段。Role/Binding 在 Workspace 配置中的后续编辑只影响新建 Slot；已存在 Slot 使用创建时快照。

当前 AgentRuntimePort/ACP 只提供文本 prompt block；基础设施按稳定 section 顺序把 ContextBundle 渲染为一段 ACP text。它不是有特权的 system-message 通道，`output_contract` 也不做机器校验。

Bundle 构建失败（`context_source_missing` 等）发生在 dispatch 之前：回执转为 `failed/not_dispatched`，Run 不落终态，因此修复来源后同 `request_id` 重放会重建上下文并重新派发，不会返回一个已失败的 Run 冒充成功。

## 上下文原则

- Task 指令优先于 Role 默认指令；
- Role 规范优先于一般 Session 摘要；
- Artifact 通过引用传递，不默认复制完整历史；
- Agent 私有上下文与共享上下文分开；
- 记录最终使用过的上下文来源，便于审计和重放。

## Session 摘要生成

Session 摘要用于把长对话压缩成有界上下文，生成规则：

- **用便宜快速档模型生成**（Claude 的 `haiku` 档、Codex 的 `luna` 档），不占用 Coordinator 的主模型；
- 在 **Session 空闲时**触发，不在对话中途打断；
- 摘要按 Session 滚动更新，**摘要式而非追加式**——每次覆盖上一版，不累积多份；
- 生成模型与耗时计入该 Session 的成本统计；
- 摘要生成失败不影响主流程，只是上下文退回「无摘要」状态并记录告警；
- 摘要内容不得包含 Secret；生成前先经 `SecretRedactionPort`。

## 依赖

允许依赖：domain、RepositoryPort。

禁止依赖：ACP SDK、HTTP、Provider 私有字段、UI 组件。

## 错误

区分 context_source_missing、context_too_large、artifact_unavailable、output_contract_invalid。

## 输入、输出和错误

输入是 Workspace、Session、Task、Role 和 Artifact 引用；输出是可审计的 ContextBundle；错误包括来源缺失、过大和格式不满足。

## 状态和不变量

相同输入和版本应生成可比较的上下文；构建过程不能修改原始 Artifact；所有来源必须可追踪。

## 持久化

不保存完整 Prompt 或 rendered ContextBundle。AgentSlot 创建时，SQLite 私有 `agent_slot_role_snapshots` 保存所选 Role/RoleBinding 的 ID、version 及 `system_prompt`、有序 `required_guidelines`、`output_contract` 源字段；后续 JSON 配置修改只影响新建 Slot。每个 Task 的 `context_sources` 只保存 Slot Role/Binding snapshot 与原始 Message 的 source ID/version，不保存拼装后的 Prompt。迁移前没有 role snapshot 的默认 Slot 只记录 Message source，仍以 task_input-only ContextBundle 运行。

## 事件

可发布 context.built、context.truncated、context_source_missing 等诊断事件。

## 安全边界

根据 Workspace 权限过滤文件和 Artifact；不把不相关 Session 或其他 Workspace 内容带入上下文。

当前 AgentRuntimePort 的通用 ACP 边界只传文本 prompt block；Role 指令以明确分区的普通 ACP 文本影响上下文，不是有特权的 system role，也不提供对用户输入 prompt injection 的防护。`output_contract` 同样只是上下文，不能替代输出校验。

## 替换和升级策略

ContextBuilder 可替换，但必须保持 ContextBundle Schema 和来源记录语义。

## 已知限制

第一阶段不自动理解任意文件格式；文件摘要和内容选择需要明确规则。

## 测试

测试来源优先级、Artifact 选择、Token 限制、敏感内容过滤和相同输入的可重复构建。

## Phase 2 handoff 边界

handoff 不会自动把接收文本注入 ACP Context，也不会自动启动接收 Agent；目标 Slot 的下一条用户消息才走既有 sendMessage/dispatch 路径。

## Web Phase 2/3 目标边界（未实现）

目标态：多 Task handoff 只按 `source_task_id` 拼接所选 Task 的已脱敏输出；Artifact/Mailbox 不会自动注入 ACP Context；reset-context 只切换同一 Slot 的 ACP context generation，保留 Slot ID、Role snapshot 与全部历史，不自动跨 generation 重派。
