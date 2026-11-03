# CLAUDE.md — Claude Code 专用规范

> 本文档是 `AGENTS.md` 的 **Claude Code 专用补充**，不重复通用规范。
> 通用规范（角色定义、铁律、任务路由、规范导航等）请先阅读 `AGENTS.md`。

---

## 适用范围

- **优先级**：`CLAUDE.md` > `AGENTS.md`
- 若两者冲突，以本文档为准

## Skill

Claude Code 通过 `.claude/commands/{skill-name}.md` 薄路由触发，命令文件正文只指向对应规范：

```text
执行 .agents/skills/{skill-name}/SKILL.md 中定义的流程
```

用户输入 `/{skill-name}`，或命中某个 skill 的 description 时，读取并执行 `.agents/skills/{skill-name}/SKILL.md`。

不要把 `SKILL.md` 正文复制到命令文件里；命令文件只做路由。

## Hooks

项目 hook 配置：`.claude/settings.json`。

| 事件 | matcher | 脚本 | 作用 |
|------|---------|------|------|
| `SessionStart` | `startup\|clear\|resume` | `scripts/pre-edit-guard.sh --init-session` | 初始化写前先读追踪与记忆脏标记 |
| `SessionStart` | `startup\|clear\|resume` | `scripts/memory-reminder-guard.sh` | 注入记忆写入决策树 |
| `SessionStart` | `compact\|resume` | `scripts/session-reentry-guard.sh` | 压缩 / 恢复后重读规范提醒 |
| `PreToolUse` | `Write\|Edit` | `scripts/pre-edit-guard.sh --check` | 写文件前按 `constraints.json` 拦截 |
| `PostToolUse` | `Read` | `scripts/pre-edit-guard.sh --record-read` | 记录已读文件 |
| `PostToolUse` | `Write\|Edit` | `scripts/pre-edit-guard.sh --mark-dirty` | 改项目文件则 dirty；写记忆文件则清除 |
| `Stop` | — | `scripts/pre-edit-guard.sh --stop-nudge` | dirty 时催办一次决策树 |

依赖：`bash` + `jq`。脚本失败默认放行（fail-open）。运行时约定见 `.agents/hooks.md`。

重新生成：`bash scripts/generate-guard-config.sh --tool claude`（只合并 `hooks`，保留 `permissions` 等其余字段）。

## 工具特有检查项

```text
【Claude Code 自检】
✅/❌ 已读取 CLAUDE.md（Claude 专用补充）
✅/❌ Skill 经 .claude/commands/ 薄路由触发，未复制 SKILL.md 正文
✅/❌ 写文件前已按 constraints.json 通过 PreToolUse 拦截
✅/❌ 收尾时按记忆决策树判断是否更新 AI_MEMORY.md / TASK_MEMORY.md
```
