---
name: memory-update
description: >
  当用户说"记录一下"、"更新记忆"、"写入 TASK_MEMORY"、"写入 AI_MEMORY"，
  或任务收尾需要沉淀决策、风险、长期经验、观察中模式时使用。
  会话结束走 memory-reminder；压缩交接走 context-handoff。
---

# Memory Update

> 本 skill 只负责判断和执行记忆落盘；写入触发、格式、精简规则统一维护在 `.agents/task-memory.md` 与 `.agents/ai-memory.md`。
> 观察信号升级见 `.agents/continuous-learning.md`，不要在本文件复制阈值表。
> 会话收尾由 `memory-reminder` 调用本 skill，不要在那边再写一套决策树。
> 决策树正文：本仓库 `.agents/hooks/memory-write-decision.md`。

## 必读规范

1. `AGENTS.md`
2. `.agents/hooks/memory-write-decision.md`
3. `.agents/task-memory.md`（写入或更新 `TASK_MEMORY.md` 时）
4. `.agents/ai-memory.md`（命中长期经验时）
5. `.agents/continuous-learning.md`（仅当有可计数重复信号或达阈值时）

## 执行骨架

1. 先过 `.agents/hooks/memory-write-decision.md`。咨询 / 无实质性改动 / 未命中 → 不写，说明「无需落盘」。
2. 查重：检索整份 `AI_MEMORY.md`（含架构地图 / 链路 / 规则 / 观察中）与 `TASK_MEMORY.md`。
3. 未完成、下回要接着干 → `TASK_MEMORY.md`（四行）。
4. 仅当能压成 `**[坑位|约束|事实|平台]**` ≤2 句时写入 `AI_MEMORY.md`；普通修 bug、决策/验证过程、实现步骤一律不写。
5. 疑似重复且还不能写成规则 → 按 `continuous-learning.md` 计数；达阈值问用户。
6. 收尾 / 压缩前按 `ai-memory.md` 删除门槛清理存量。
7. 向用户说明写入目标或「无需落盘」；多数收尾应为后者。

## 观察项维护

只在决策树前置门通过、且出现 `continuous-learning.md` 所列信号时做。轻量收尾不要为凑 `【模式回顾】` 去读观察章节。

达阈值 → 通知区 + 当面问用户。固化方式见 `continuous-learning.md`，阈值表不要在本 skill 再写一遍。

## 必守红线

- 不把验证过程、方案对比、复盘叙事写入 `AI_MEMORY.md`。
- 不把单次任务流水、实现步骤、大段代码写入记忆。
- 不重复写已有内容；跨章节查重后合并或跳过。
- 不把未达阈值的观察项直接固化为长期规则。
- 达阈值后先问用户；未确认不改规范、不新建 Skill。
- 任何人改 `AI_MEMORY.md` 都遵守同一格式与删除门槛。
- 不默认读取 `TASK_MEMORY.md`；只有用户要求、恢复上下文或查重时读取。
