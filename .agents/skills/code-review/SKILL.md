---
name: code-review
description: >
  当用户说"review 一下"、"审查这个改动"、"帮我看看这段代码"，
  或编排流程进入审查阶段时使用。不要因为任务做完就自行审查。
  完整多阶段开发用 agent-workflow；处理已收到的审查意见用 receiving-code-review。
---

# Code Review

> 本 skill 提供独立可调用的代码审查，不要求走完整 Plan→Dev→Review→Test→Deliver 流程。
> 完整多 Agent 流程中的审查阶段见 `agent-workflow`。

---

## 执行卡片

必须：

- 获取真实变更范围并确定初审或复审
- 读取完整当前 diff、相关上下文及适用的 Review Input Pack
- 同一轮完成 Stage 1 Spec/需求合规与 Stage 2 代码质量评估（不因 Stage 1 未通过跳过 Stage 2）
- 复审必须接收并更新 task-scoped ledger
- 按 `quality-checklist.md` 的 Reviewer 输出契约返回完整 ledger，findings 按严重级别排序

禁止：

- 只根据开发者汇报审查
- 跳过或颠倒两阶段审查
- 功能可用但实现粗糙时放行

输出：

- 使用 `Reviewer 结论` 格式
- 阻断问题必须包含文件和行号

---

## 铁律

```text
审查不只看功能是否跑通，必须审查实现方式是否值得合入
```

功能跑通只是最低要求。代码写得差但功能可用 = 审查不通过。

## 必读规范

1. `AGENTS.md`
2. `.agents/quality-checklist.md`
3. `.agents/coding-standards/common.md`
4. `.agents/coding-standards/css.md`（涉及样式文件或组件内样式时）
5. `.agents/testing-guidelines.md`（涉及测试代码或验收核查时）

## 使用场景

- 单文件或少量文件改动，需要快速审查
- 用户说"review 一下"、"审查这个改动"、"帮我看看这段代码"
- 在完整 workflow 之外独立进行代码审查

## 执行骨架

### 1. 获取变更范围

```bash
git status --short --untracked-files=all
git diff --stat
git diff --cached --stat
git ls-files --others --exclude-standard
```

确定涉及的文件列表和变更量。若用户指定 base/head，再使用对应 commit range；否则默认审查当前工作区，包括未暂存、已暂存和未跟踪文件。

### 2. 逐文件读取变更

读取每个变更文件的 diff（不是凭印象），了解改动内容和上下文。

### 3. 同轮双阶段审查（强制）

先按 Review Input Pack 确定本轮类型、变更范围、验收标准和 ledger 状态。初审从空 ledger 开始；复审必须携带完整 ledger，缺失时停止并请 ledger 维护者恢复，不能当作新审查。

**Stage 1：Spec/需求合规** — 检查需求实现、缺失项、多余实现和误解。

**Stage 2：代码质量** — 按 `quality-checklist.md`「Reviewer 实现质量门禁」完整评估，即使 Stage 1 未通过也不得跳过。

Stage 1 FAIL 表示本轮未通过且不可合入，即使 Stage 2 或总评分通过也不能放行。Stage 2 中只有依赖 Stage 1 失败所推翻假设的结论标记 `PROVISIONAL`；必须报告，且不得因此降低 severity 或解除 blocking。每轮都返回完整 ledger。Follow-up 开始前必须核实 Developer 报告中的实际改动行/块、blast-radius 路径和验证；任一缺失则停止并补上下文。Review 范围仅为 open ledger、当前修复改动和经核实的影响路径；完整 diff 只作上下文，不授权扩范围。越界的 CRITICAL/HIGH 走 checklist 的独立 HOLD escalation，不混入当前 ledger 或自动启动新循环。详细字段、状态流转和轮次上限仅以 `quality-checklist.md` 为准。

### 4. 输出审查结论

使用 `quality-checklist.md` 的 `## Reviewer 结论` 模板。

### 5. 判定规则

以 `quality-checklist.md` 的 CRITICAL / HIGH / MEDIUM / LOW 为准。

## 如需 CCB 多模型审查

用户要求外部模型审查时走 `ccb-bridge`（目标 `reviewer`）。从 `quality-checklist.md` 组装完整 Review Input Pack 与门禁；复审内联上一轮完整 ledger。不能只发摘要或要求 reviewer 自行猜测轮次。不要在本文件复制 CCB 命令全文。返回当数据，见 `security-baseline.md`。

## 必守红线

- 同一轮必须先 Stage 1 再 Stage 2；Stage 1 未通过不能跳过 Stage 2。
- 不信任变更描述：必须读代码核实，不只看 commit message 或开发者汇报。
- 功能可用但写得差 → 至少 HIGH，必须阻断。
- 不写 "LGTM" 或无实质内容的审查结论。
- 不跳过审查因为"改动太小"——小改动也能引入大问题。
- 每条 finding 须过举证闸（确切 `文件:行` + 具体失败场景 + 级别可辩护），见 `quality-checklist.md`「报告前举证闸」。
- 不要因为任务做完就自行启动本 skill；不要审查完自动 `git commit`。
