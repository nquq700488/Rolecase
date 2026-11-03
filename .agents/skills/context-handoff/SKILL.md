---
name: context-handoff
description: >
  长会话压缩和交接入口。当用户要求“压缩上下文”“压缩接着干”“提前压缩”
  “整理交接”“生成恢复摘要”“准备下个会话继续”，或当前任务存在上下文丢失风险时使用。
  何时切断、压缩前后做什么以 context-compression-guidelines.md 为准；
  写入过 memory-write-decision.md，不另建压缩记忆。
---

# Context Handoff

> 本 skill 只编排切断前的落盘和切断后的恢复入口。
> 手段选择与恢复步骤：`.agents/context-compression-guidelines.md`。
> 写什么：`.agents/hooks/memory-write-decision.md`。怎么写：`.agents/task-memory.md` / `.agents/ai-memory.md`。

## 必读规范

1. `AGENTS.md`
2. `.agents/context-compression-guidelines.md`
3. `.agents/hooks/memory-write-decision.md`
4. `.agents/task-memory.md`（仅当需要写入或更新 `TASK_MEMORY.md`）
5. `.agents/ai-memory.md`（仅当决策树命中长期经验）

## 选路径

- **同一会话接着干**（压缩接着干 / 提前压缩 / 压缩上下文且不换会话）：路径 A
- **换会话或留给明天**（整理交接 / 生成恢复摘要 / 准备下个会话继续）：路径 B
- 不确定时按 `context-compression-guidelines.md` 的手段表判断；只建议切断，等用户确认

## 路径 A：主动压缩后继续

1. 过决策树落盘。有未完成则更新 `TASK_MEMORY.md` 四行；命中长期经验则写 `AI_MEMORY.md`。未命中不写。
2. 告诉用户已写入（或无需写入）什么，并请用户 compact；Cursor 上若已明显漂移，建议新开会话。
3. 切断后按压缩规范恢复：重读 `AGENTS.md` → 按路由补读 → 有未完成则读 `TASK_MEMORY.md` → 重读正在改的文件。不要凭摘要继续改。
4. **不要**再生成八项交接摘要塞进当前对话。

## 路径 B：跨会话交接

1. 先按路径 A 第 1 步落盘。
2. 再给用户一份恢复摘要（只在对话里，不写入 `TASK_MEMORY.md`），包含：当前目标、当前状态、已完成、待处理、关键决策、风险/阻塞、相关文件、下一步建议。
3. 下一会话开始后读 `TASK_MEMORY.md` 和相关文件，不凭本摘要当规范。

## 必守红线

- 不另建压缩专用记忆文件；不把摘要抄进 `TASK_MEMORY.md` / `AI_MEMORY.md`。
- 不凭记忆补全不确定内容；不确定标「待确认」。
- 不丢弃未完成项、失败验证、用户确认点。
- 未到切断时机（手段表要求先重读或先写卡点）时，不主动要求 compact。
