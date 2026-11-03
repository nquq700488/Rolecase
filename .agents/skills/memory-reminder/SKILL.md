---
name: memory-reminder
description: >
  当用户说"结束"、"退出"、"收尾"、"关闭会话"、"完了"、"就这样"、
  "可以结束了"、"/exit"时使用。主动写入记忆用 memory-update；压缩交接用 context-handoff。
---

# Memory Reminder

> 会话收尾入口。记忆落盘委托 `memory-update`（决策树见本仓库 `.agents/hooks/memory-write-decision.md`）。
> 不替代 `workflow.md` 的收尾要求。

## 执行骨架

1. **记忆**：按 `memory-update` 过决策树并落盘，或声明无需落盘及原因。不要在本 skill 再写一套决策树。
2. **清理**：按仓库已有语言和规范检查临时调试代码、未处理 TODO、mock 兜底；不要套用其他语言的检查命令。
3. **验证**：列出已跑的 lint / 类型检查 / 测试；未运行说明原因。
4. **输出**：

```text
【交付检查】
改动文件：[列表 / 无]
验证结果：[通过 / 未运行及原因]
记忆落盘：[AI_MEMORY.md / TASK_MEMORY.md / 无需]
遗留事项：[无 / 列出]
```

完成后声明：「收尾完成，可以关闭会话」——不再做其他操作。不要 `git commit`。

## 必守红线

- ❌ 禁止跳过记忆落盘检查直接声明"可以结束了"
- ❌ 禁止在收尾时 `git commit` / `git push`（用户要提交须另说）
- ❌ 禁止在未完成交付检查前执行其他编码任务
- ❌ 禁止用模糊表述（"看起来没问题"、"应该都好了"）
- ✅ 先检查，再声明完成
