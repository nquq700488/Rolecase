# CURSOR.md — Cursor 专用规范

> 本文档是 `AGENTS.md` 的 **Cursor 专用补充**，不重复通用规范。
> 通用规范（角色定义、铁律、任务路由、规范导航等）请先阅读 `AGENTS.md`。

---

## 适用范围

- **优先级**：`CURSOR.md` > `AGENTS.md`
- 若两者冲突，以本文档为准

## Skill

Cursor 会自动发现项目内 `.agents/skills/*/SKILL.md`，**不要**再复制一份到 `.cursor/rules/`。

用户说 `/{skill-name}` 或命中 skill description 时，读取并执行对应 `SKILL.md`。

## Hooks

项目 hook 配置：`.cursor/hooks.json`。

| 事件 | 脚本 | 作用 |
|------|------|------|
| `sessionStart` | `scripts/pre-edit-guard.sh --init-session` | 初始化写前先读追踪与记忆脏标记 |
| `preToolUse` | `scripts/pre-edit-guard.sh --check --output-format cursor` | 写文件前按 `constraints.json` 拦截 |
| `postToolUse`（Read） | `scripts/pre-edit-guard.sh --record-read` | 记录已读文件 |
| `postToolUse`（写入） | `scripts/pre-edit-guard.sh --mark-dirty` | 改项目文件则 dirty；写记忆文件则清除 |
| `stop` | `scripts/pre-edit-guard.sh --stop-nudge --output-format cursor` | dirty 时催办一次决策树（`loop_limit: 1`） |

依赖：`bash` + `jq`（Windows 用 Git Bash 或 WSL）。脚本失败默认放行（fail-open）。运行时约定见 `.agents/hooks.md`。

重新生成：`bash scripts/generate-guard-config.sh --tool cursor`

Claude 风格的 `hookSpecificOutput` 注入在 Cursor 中不接（含 compact / resume 重读提醒）。铁律以 `AGENTS.md` 为准；压缩或恢复后按 `.agents/context-compression-guidelines.md` 自行重读规范。记忆催办走 `stop`，不灌铁律。接线总览见 `.agents/hooks.md`。
