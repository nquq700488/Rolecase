# Skill 指令清单

> `.agents/skills/` 是 Skill 正文的唯一维护点。本文件只做触发索引，不复制执行步骤。
> 写法、措辞形态与 description 规则见 [skills/writing-skill/SKILL.md](skills/writing-skill/SKILL.md)。

---

## 触发边界

本项目的 Skill 是**规范 Skill**：它定义可复用流程和触发语义，但不保证所有 AI 工具都会原生自动调用。

| 层级 | 作用 | 触发可靠性 |
|------|------|------------|
| `.agents/skills/{skill-name}/SKILL.md` | 通用流程权威来源 | 依赖模型是否读取并遵守规范 |
| `.claude/commands/{skill-name}.md` 等适配层 | 把工具命令路由到规范 Skill | 由对应工具支持能力决定 |
| 脚本 / Git hooks / CI / 调度器 | 执行可自动化的真实检查或门禁 | 可靠自动触发 |

规则：

- 用户明确输入 `/{skill-name}` 或说出对应触发语义时，Agent 应读取并执行该 Skill。
- 工具若没有原生 Skill/命令机制，只能通过 `AGENTS.md`、工具规则文件或 prompt 引导触发。
- 外部 CCB agent 不能直接调用本地 Skill；Orchestrator 必须把必要规则内联进 prompt。
- 运行时 hook 接线见 `.agents/hooks.md`。Skill 正文不是 hook，不能代替脚本拦截。
- 需要强制自动触发的事项，应实现为脚本、Git hook、CI 或调度任务，而不是只写入 Skill。

---

## 各工具 Skill 配置位置

| AI 工具 | 配置目录 | 使用方式 |
|---------|---------|---------|
| Claude Code | `.claude/commands/{skill-name}.md` | 对话中输入 `/{skill-name}` 调用 |
| Cursor | `.agents/skills/` + `CURSOR.md` | 自动发现项目 Skill；hook 见 `.cursor/hooks.json`。不要复制到 `.cursor/rules/` |
| Copilot | `AGENTS.md` | 无独立适配层，依赖入口规范 |

> 新增 Skill 后：在 `.claude/commands/{skill-name}.md` 写一行路由；在下表加一行「何时用」。正文只在 `.agents/skills/` 维护。

---

## 已注册 Skill

流程与红线以各 `SKILL.md` 为准。本表只回答：**何时读它**。

| Skill | 何时用 | 正文 |
|-------|--------|------|
| `/commit-helper` | 仅用户本轮明确说提交/commit 时；任务完成或收尾不要用 | [commit-helper](skills/commit-helper/SKILL.md) |
| `/onboard` | 用户说初始化项目、接入 AI 规范、onboard、设置项目；或规范文件缺失需重建 | [onboard](skills/onboard/SKILL.md) |
| `/agent-workflow` | 复杂开发/修复需要 Plan→Dev→Review→Test→Deliver；本地编排 | [agent-workflow](skills/agent-workflow/SKILL.md) |
| `/ccb-bridge` | 单次问某个外部 agent，或要求外部 AI 审查/测试/规划/生成 | [ccb-bridge](skills/ccb-bridge/SKILL.md) |
| `/multi-agent-orchestrate` | 用户明确要求多模型/多角色/全链路，或完整模式且高风险跨模块 | [multi-agent-orchestrate](skills/multi-agent-orchestrate/SKILL.md) |
| `/solution-brainstorm` | 完整模式、高风险、需求不清，或用户要求先设计/多模型头脑风暴 | [solution-brainstorm](skills/solution-brainstorm/SKILL.md) |
| `/frontend-design` | 新建或重塑 UI、设计一下、优化观感、高保真、不要模板感；编码前要定视觉方向 | [frontend-design](skills/frontend-design/SKILL.md) |
| `/web-design-guidelines` | 审查 UI、检查可访问性、审计设计、审查 UX；前端实现后的合规检查 | [web-design-guidelines](skills/web-design-guidelines/SKILL.md) |
| `/code-review` | 用户说 review / 审查这个改动；或编排进入审查阶段。不要任务一做完就自行审查 | [code-review](skills/code-review/SKILL.md) |
| `/receiving-code-review` | 已收到 reviewer / 用户 / PR / 外部 agent 的审查意见，需要处理 | [receiving-code-review](skills/receiving-code-review/SKILL.md) |
| `/test-driven-development` | 实现功能、修 bug、重构、改行为且仓库有测试栈；尤其想跳过测试或事后再补时。无测试栈不要硬造 | [test-driven-development](skills/test-driven-development/SKILL.md) |
| `/systematic-debug` | bug、测试失败、异常行为、性能、构建失败；尤其想跳过调查直接试错时 | [systematic-debug](skills/systematic-debug/SKILL.md) |
| `/memory-update` | 记录一下、更新记忆、写入 TASK_MEMORY / AI_MEMORY；收尾时需沉淀决策 | [memory-update](skills/memory-update/SKILL.md) |
| `/memory-reminder` | 结束、退出、收尾、关闭会话、完了、就这样、可以结束了、/exit | [memory-reminder](skills/memory-reminder/SKILL.md) |
| `/context-handoff` | 压缩上下文、压缩接着干、提前压缩、整理交接、生成恢复摘要、准备下个会话继续 | [context-handoff](skills/context-handoff/SKILL.md) |
| `/parallel-worktree` | 多个 Agent 同时改不同模块，需要独立目录/分支和受控合并；隔离后不要自动 commit | [parallel-worktree](skills/parallel-worktree/SKILL.md) |
| `/loop-automation` | 启动 loop、自动巡检、心跳检查、看门狗、定时检查；等待外部异步结果 | [loop-automation](skills/loop-automation/SKILL.md) |
| `/writing-skill` | 新增/改写/评估 Skill，或同步 commands 路由与本索引 | [writing-skill](skills/writing-skill/SKILL.md) |
| `/add-guard-rule` | 加一条拦截规则、新增 guard、这条也拦截一下、加到约束里、移除某条规则；不用于改 hook 接线 | [add-guard-rule](skills/add-guard-rule/SKILL.md) |

近邻不要用错：

- 本地五阶段 → `agent-workflow`；多模型五阶段 → `multi-agent-orchestrate`；只问一个外部 agent → `ccb-bridge`
- 主动审查当前变更 → `code-review`；处理已收到的意见 → `receiving-code-review`
- 编码前视觉方向 → `frontend-design`；实现后 UI 合规 → `web-design-guidelines`
- 现在写入记忆 → `memory-update`；会话结束检查清单 → `memory-reminder`；主动压缩 / 跨会话交接 → `context-handoff`（落盘仍过决策树）
- 改完文件未过决策树 → Stop hook 每会话最多催一次（`.agents/hooks.md`）；不代替 `memory-reminder`
- 提交代码 → 用户本轮明确说提交才用 `commit-helper`；做完任务不要自动提交
- 功能设计 → `solution-brainstorm`；项目规范初始化 → `onboard`
- 改 `constraints.json` 写前拦截 → `add-guard-rule`；改 hook 事件接线 / 注入脚本 → `.agents/hooks.md`

<!--
新增一行：`| /skill-name | 何时用 | [skill-name](skills/skill-name/SKILL.md) |`
并在 `.claude/commands/{skill-name}.md` 创建一行路由。
-->
