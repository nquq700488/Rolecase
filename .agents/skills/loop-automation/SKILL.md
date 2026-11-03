---
name: loop-automation
description: >
  当用户要求“启动 loop”“自动巡检”“心跳检查”“看门狗”“定时检查”，
  或需要等待外部异步结果并周期性检查时使用。
  适用边界、频率、预算和禁止行为以 contexts/loop-automation.md 为准。不要用 Loop 刷观察项。
---

# Loop Automation

> 本 skill 只负责落地：判断要不要开、找到真实命令、启动并按规范报告。
> 类型、频率、硬性限制、每轮报告格式、禁止行为见 `.agents/contexts/loop-automation.md`，此处不复制。

## 必读规范

1. `AGENTS.md`
2. `.agents/contexts/loop-automation.md`

按场景补读：CI / PR → `.agents/git-workflow.md`；等外部 agent → `.agents/collaboration.md`。

## 执行骨架

1. 按 context「使用 `/loop` 的时机」判断。一次性检查、逻辑未稳定、每轮要人工判断 → 不开。
2. 选定类型（心跳 / 巡逻 / 门狗 / 定时）。频率、预算、退出条件用 context「硬性限制」，不要另造默认值。
3. 发现并确认项目真实命令（`AGENTS.md` / `README.md` / `AI_MEMORY.md`，再 `package.json`、`Makefile`、`justfile`、`scripts/`、CI）。未确认的命令不得写入 Loop。
4. 手动跑通一次检查逻辑。失败来自检查本身或无法执行 → 不启动。
5. 会话级可直接启动；持久化必须用户明确确认。启动前输出：

```text
【Loop 配置】
类型：
频率：
检查动作：
预算：
退出条件：
持久化：否 / 是（已确认）
```

6. 每轮按 context「每轮报告格式」输出。升级人工条件见同一文件。

## 必守红线

- 不套用示例命令；不在 Loop 内做破坏性操作或结构性修复。
- 不用 Loop 定时刷 `AI_MEMORY.md` 观察项。
- 结束时说明轮次、最终状态、退出原因、需要用户决策的事项。
