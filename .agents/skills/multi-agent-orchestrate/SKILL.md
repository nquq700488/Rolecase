---
name: multi-agent-orchestrate
description: >
  当用户明确要求多模型/多角色协作、全链路、一起想方案，
  或完整模式且存在高风险、跨模块决策时使用。单次问某个 agent 用 ccb-bridge；本地五阶段用 agent-workflow。
---

# 多模型协作编排器

> 本 skill 与 `agent-workflow` 平行，只负责 CCB 调度、通讯和不可用报错。开始时选定，中途不切到本地流程。
> 外部 agent **不能**调用本地 Skill。本地 Orchestrator 从下列文件抽取门禁，内联进 `ccb ask` 的 prompt：
> `solution-brainstorm`（模式 B 轮次协议）、`testing-guidelines.md`、`quality-checklist.md`、`agent-registry.md`。
> 本地收尾（提交、记忆、处理审查意见）仍由本机执行对应 Skill，不要派给 CCB。

## 必读规范

1. `AGENTS.md`
2. `.agents/task-routing.md`
3. `.agents/execution-mode-guidelines.md`
4. `.agents/collaboration.md`
5. `.agents/agent-registry.md`
6. `.ccb/ccb.config`
7. `.ccb/ccb-compact.config` / `.ccb/ccb-multi.config`（按当前 profile 读取）
8. `.agents/orchestrator.md`

---

## 使用边界

✅ 使用：用户明确说"多模型""全链路""一起想方案"；完整模式 + 高风险/跨模块；用户点名多个外部 agent
❌ 不使用：单次问某个 agent（用 `ccb-bridge`）；普通轻量修改；用户说"直接做""不要多模型"

---

## CCB 编排五阶段

> CCB 外部 agent 是远端独立会话，**不能调用本地 skill**。Orchestrator 的职责是：
> 从对应规范/门禁中提取关键文本 → 内联到 prompt → 外部 agent 按这些门禁执行。
> 下表中的 `ccb ask ...` 均为简写；实际执行必须记录每个 `job_id`，并对每个 job 执行 `ccb watch <job_id>` 直到终态。P0 并行提交多个 agent 时，必须收集全部 `job_id` 并逐个监听；除非用户明确要求静默发送，否则不得只 ask 不 watch。
> 角色解析按当前 `.ccb` profile 的 `agent_name:provider`：`agent_name` 决定角色规范，`provider` 只决定运行后端 / 模型。

| Phase | CCB 调用 | Orchestrator 向 prompt 注入的门禁（来自规范） |
|-------|---------|------------------------------------------|
| **P0** 头脑风暴 | 本地 Orchestrator 按 `solution-brainstorm` 模式 B 主持轮次，`ccb ask` 各 agent | 需求、约束、相关文件；独立发散 → 交叉挑战 → 共识收敛 |
| **P1** 方案定稿 | 有 P0 → 共识后 `ccb ask planner` 定稿；无 P0 → 直接 `ccb ask planner` 出方案 | `planner.md`：目标、范围、影响面、验收、可并行；已有共识则只定稿不另写一套 |
| **P2** 编码 | `ccb ask developer` 实施 | Developer 门禁（`agent-registry.md`）+ 有测试栈时 TDD（`testing-guidelines.md` / `test-driven-development`）+ 方案全文 + 文件路径；四态报告 |
| **P3** 审查 | `ccb ask reviewer` | 按 `quality-checklist.md` 组装完整 Review Input Pack（含 full diff 与初审空 ledger / 复审完整 ledger）；同轮完成 Stage 1 + Stage 2；Stage 1 FAIL 或存在 blocking finding 均不可合入；其余字段和回合处理不在此复制 |
| **P4** 测试 | `ccb ask tester` | Tester 门禁（`testing-guidelines.md`「Tester 验证质量门禁」）：覆盖矩阵、执行真实性、证据充分性，主路径通过但关键风险未测必须阻断 |
| **P5** 交付 | Orchestrator 汇总 + `memory-update`；仅用户本轮明确要求提交时才加 `commit-helper` | — |

---

## CCB 通讯最小规则

```bash
# 发送任务 + 等待结果（默认）
ccb ask <agent> <<'EOF'
【身份设定】[按 agent-registry.md CCB 身份注入规则]
【角色规范】[按当前 .ccb profile 的 agent_name 解析本次执行角色并展开，不能留占位]
……
EOF
ccb watch <job_id>       # 优先传 job_id

# 链式委派（agent 内部需要另一个结果继续）
ccb ask --chain <agent>

# 完成通知（不阻塞当前流程）
ccb ask --notify-sender <agent>
```

- 有文件能力 → 传规范路径；无文件能力 → 内联关键门禁
- `ccb ask` 必须配套监听（`watch` / `--chain` / `--notify-sender`），禁止裸发
- 验证铁律：外部 agent 返回后必须 git diff 或 Read 核实

---

## 不可用即报错

```text
CCB 不可用 / agent 离线 / 调用失败
  → 报错停止，告知用户：哪个环节、哪个 agent、什么原因
  → 建议：装好 / 启动 CCB 后重试，或改用本地流程 skill agent-workflow
  → 不降级回本地、不用 inspiration 顶替
```

详见 `collaboration.md`「不可用即报错」。

---

## 必守红线

- 不跳过模式判断、注入判断、方案确认。
- 所有 CCB 通讯走 `ccb ask <agent>`，禁止直连外部 AI CLI/API。
- `ccb ask` 后必须记录 `job_id` 并 `ccb watch <job_id>`。
- 每个 prompt 注入 `【身份设定】` + 展开的 `【角色规范】`，禁止占位。
- 子 agent 不得递归编排。
- 禁止把 `code-review` / `test-driven-development` 等本地 Skill 派给 CCB agent；门禁从规范文件抽取后内联。
- 外部审查结论回到本机后，用 `receiving-code-review` 处理；禁止表演性认同。
- CCB / agent 不可用时报错停止，不降级回本地（见 `collaboration.md`「不可用即报错」）。用户可另行改走 `agent-workflow`，那是新开入口，不是自动降级。
- 长流程未完成进度写入 `TASK_MEMORY.md`。不要另建 `tasks.md`。Phase 切换前同步；压缩后以这份记录为准，不重复派发已完成子任务。
