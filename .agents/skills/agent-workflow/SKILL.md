---
name: agent-workflow
description: >
  当复杂开发、复杂修复需要 Plan → Dev → Review → Test → Deliver 阶段治理时使用。
  单次审查用 code-review；单次调试用 systematic-debug；多模型用 multi-agent-orchestrate。
---

# 多 Agent 协作工作流

> 本 skill 是**编排层**——负责阶段串联和角色调度。
> 设计：`solution-brainstorm`（产出见 `planner.md`）· 编码：仓库有测试时 `test-driven-development`
> 审查：`code-review` · 反馈：`receiving-code-review` · 调试：`systematic-debug`

---

## 执行卡片

必须：

- 完成任务路由和模式判断
- 完整模式先产出并确认方案、任务清单和验收标准
- P1 校验任务清单后再进入开发
- P2 按已确认任务清单逐项执行并更新状态
- P3 使用 `code-review` 两阶段审查

禁止：

- 缺少已确认任务清单时进入实现
- 子 Agent 递归启动编排 skill
- 跳过验证或用子 Agent 汇报替代复核

输出：

- 开始时输出 `【任务路由】`
- 交付时输出 `【交付检查】`

---

## 必读规范

1. `AGENTS.md`
2. `.agents/task-routing.md`
3. `.agents/execution-mode-guidelines.md`
4. `.agents/orchestrator.md`
5. `.agents/agent-registry.md`

按阶段补读：规划 → `planner.md`；开发 → `workflow.md` + `coding-standards/common.md` + `contexts/development.md`；审查 → `quality-checklist.md` + `contexts/review.md`；测试 → `testing-guidelines.md`；调试 → `contexts/debug.md`。
入口在开始时选定：本地走本 skill，多模型走 `multi-agent-orchestrate`。选定后不切换、不在本流程内套 CCB。

---

## 使用边界

✅ 使用：完整模式、本地多 Agent、Plan→Dev→Review→Test→Deliver
❌ 不使用：纯咨询、轻量修改、单次审查（`code-review`）、单次调试（`systematic-debug`）、用户要多模型/全链路/点名外部 agent（从一开始用 `multi-agent-orchestrate`）

---

## 五阶段编排

| Phase | 角色 | 委托 Skill | 产出 |
|-------|------|-----------|------|
| **P0** 头脑风暴 | Orchestrator | `solution-brainstorm` **模式 A** | 设计确认 + 任务清单 + 验收标准 |
| **P1** 规划校验 | Planner | `planner.md`（只校验，不重写方案） | 可执行的任务清单、文件级影响面、风险 |
| **P2** 开发 | Developer | 行为变更且仓库有测试时用 `test-driven-development`；无测试栈则按仓库命令验证并注明 | 改动文件、验证结果 |
| **P3** 审查 | Reviewer | `code-review`（同轮 Stage 1 + Stage 2；按 task ledger 复审） | 审查结论与完整 ledger |
| **P4** 测试 | Tester | `testing-guidelines.md` 门禁 | 测试报告 |
| **P5** 交付 | Orchestrator | `memory-update`；仅当用户本轮明确要求提交时才用 `commit-helper` | 最终交付 diff 的 Review 状态为 PASS（无 HOLD / blocking）且通过测试；交付说明 + 记忆落盘，未要求则不提交 |

Phase 3 后任何代码变更（包括 Phase 4 Tester 修复）都会使 Reviewer 结论失效。以同一 task ledger 对最终 diff 重审并重跑适用测试；遵守 `quality-checklist.md` 三轮上限，超限则停止并升级，不得交付未审代码。

---

## 编排规则

### Phase 0 → Phase 1 切换：上下文卫生

任务清单未就绪则阻断，不进入实现。其余按 `.agents/context-compression-guidelines.md` 手段表：过决策树落盘，建议用户切断上下文；进入下一阶段前重读 `AGENTS.md`、`workflow.md` 和已确认任务清单。

### Phase 1 → Phase 2 切换：上下文注入

进入开发阶段前，必须：

1. 在派发 Developer 的 prompt 中注入 `contexts/development.md` 的核心约束
2. 在派发协议中要求 Developer 以 `contexts/development.md` 的执行节奏工作
3. 为每个子任务写清成功标准、负责文件、禁止触碰范围和验证方式
4. 明确反过度实现约束：不新增未确认的扩展点、配置项、抽象层、缓存、队列或批处理

### Phase 2 → Phase 3 切换：审查上下文注入

进入审查阶段前，必须：

1. 按 `.agents/quality-checklist.md` 组装 Review Input Pack（初审为空 ledger；复审带完整 task ledger）
2. 在派发 Reviewer 的 prompt 中注入 `contexts/review.md` 的同轮双阶段约定和完整当前 diff；完整 diff 仅为上下文，不授权扩大批准范围
3. 确认 Reviewer 已知悉 Stage 1 未通过也不能跳过 Stage 2；缺少复审 ledger 或修复报告时先停止并补齐上下文

### 调试/调研场景

- 开发中遇到 bug → 注入 `contexts/debug.md` 四阶段系统化调试纪律
- 技术选型/方案调研 → 注入 `contexts/research.md` 多方案对比要求

### Phase 2 开发：按任务清单逐项执行

Developer 按已确认的子任务清单逐项执行：

开干前先确认：

- 当前子任务的成功标准是否可验证
- 是否存在未澄清假设；有则返回 `NEEDS_CONTEXT`
- 是否能用更小改动完成；能则采用更小方案
- 每个计划改动文件是否都在负责范围内

**执行节奏**：

```text
任务 1.1：[描述]
  → 读取相关文件
  → 实现代码
  → 验证（仓库已有的 lint / 类型检查 / 测试；没有则注明）
  ✅ 完成

任务 1.2：[描述]
  → ...
  ✅ 完成
```

**进度输出格式**：
每完成一个任务，输出一行进度：

```text
✅ 1.1 [子任务]
⏳ 1.2 [子任务]  ← 当前进行中
❌ 2.1 [子任务]
```

全部任务完成后，按决策树更新 `AI_MEMORY.md`；从 `TASK_MEMORY.md` 清掉已完成项。

### 派发协议

每次派发本地角色按 `agent-registry.md`「本地 Agent 派发协议」注入：

- 角色身份 + 输入上下文（方案全文、相关文件路径）
- 必读规范索引 + 必须门禁
- 产出格式 + 阻断条件
- **禁止递归编排**

### 子 Agent 上下文隔离

不传递会话历史，只传精确构建的输入。不让子 Agent 自行读取方案文件推导意图。

### 连续执行

已确认方案不暂停。只在 BLOCKED、不可解决的模糊点或全部完成时才中断。进度用一句话 + emoji 同步。

### 并行派发

- Planner 标注的可并行子任务 → Developer 统一承接；运行环境支持时派发本地子 Agent 并行编码，否则按批次串行执行或回到 Orchestrator 重新拆分
- 审查阶段：Reviewer（正式门禁）+ Inspiration（ADVISORY 补充视角）可并行；Inspiration 输出明确标记非阻断，不替代正式结论
- 测试阶段：Tester（正式门禁）+ Inspiration（补充视角）可并行

### 实施者四态

| 状态 | 处理 |
|------|------|
| `DONE` | 进入下一阶段 |
| `DONE_WITH_CONCERNS` | 涉及正确性→解决后继续；仅备注→记录后继续 |
| `NEEDS_CONTEXT` | 补充上下文重新派发 |
| `BLOCKED` | 缺上下文补、需更强推理换模型、任务太大拆、方案有误上报 |

---

## 必守红线

- 不跳过模式判断、方案确认、并行分析（咨询 / 单文件轻改除外，见 `AGENTS.md`）。
- 子 Agent 不得递归启动 `agent-workflow` / `multi-agent-orchestrate`。
- 审查委托给 `code-review`：按 checklist 携带并更新 task ledger；同轮必须完成 Stage 1 + Stage 2，不得因 Stage 1 未通过而跳过 Stage 2。
- 反馈委托给 `receiving-code-review`：禁止表演性认同。
- 不信任子 Agent 汇报：用 git diff/Read 复核真实变更。
- 本流程不跑 CCB、不执行 `solution-brainstorm` 模式 B。用户中途改口要多模型 → 停下来问用户是否改走 `multi-agent-orchestrate`，不自动切换。
- 不跳过仓库已有的 lint、类型检查、必要测试；没有对应命令则说明。禁止 `--no-verify`。
- **开发阶段按已确认任务清单逐项执行**：不得跳过清单中的任务，不得添加清单外的功能。
- **Phase 5 交付**：记忆与观察项用 `memory-update`。用户本轮明确要求提交时才用 `commit-helper`。用户说结束/退出时才用 `memory-reminder`。不要因为交付完成就提交。
