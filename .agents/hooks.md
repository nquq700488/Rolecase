# Hook 接线

> 本文件是 hook **事件 → 脚本 → 配置** 的唯一来源。
> PreToolUse 规则与扩展方式见 `pre-tool-use.md`、`constraints.json`。
> compact / resume 重读提醒正文见 `session-reentry.md`。记忆决策树正文见本仓库 `hooks/memory-write-decision.md`。
> Stop 催办正文见 `memory-stop-nudge.md`。
> 铁律正文只在 `AGENTS.md`，hook 不再重复注入。

脚本失败默认放行（fail-open），不阻断正常编辑和提问。

运行时是 **bash 3.2+** 与 **jq**。macOS / Linux 用系统 bash；Windows 用 Git Bash 或 WSL，不要用纯 PowerShell / cmd 跑这些脚本。`*.sh` 以 LF 入库（见仓库根目录 `.gitattributes`）。`.ccb/*.sh` 同样要求 bash。

先读后写的路径在比较前会把 `C:\` / `C:/` 收成 `/c/...`，避免 Windows 与 Git Bash 路径对不上。

## 事件对照

| 事件 | matcher | 脚本 | 作用 | 输出 |
|------|---------|------|------|------|
| SessionStart | `startup` / `clear` / `resume` | `scripts/pre-edit-guard.sh --init-session` | 初始化写前先读追踪与记忆脏标记 | 无拦截 |
| SessionStart | `startup` / `clear` / `resume` | `scripts/memory-reminder-guard.sh` | 注入本仓库 `memory-write-decision.md` | `hookSpecificOutput`（Claude/Codex） |
| SessionStart | `compact` / `resume` | `scripts/session-reentry-guard.sh` | 注入重读 `AGENTS.md` 提醒 | `hookSpecificOutput`（Claude/Codex） |
| PreToolUse（写入） | 写入工具名 | `scripts/pre-edit-guard.sh --check` | 按 `constraints.json` 拦截违规写入 | Claude/Codex：`{}` 或 `{decision:block}`；Cursor：`permission` |
| PostToolUse（Read） | 读取工具名 | `scripts/pre-edit-guard.sh --record-read` | 记录已读路径，供写前先读检查 | 无拦截 |
| PostToolUse（写入） | 写入工具名 | `scripts/pre-edit-guard.sh --mark-dirty` | 改项目文件则 dirty；写记忆文件则清除 | `{}` |
| Stop | — | `scripts/pre-edit-guard.sh --stop-nudge` | dirty 且本会话未催过 → 催办一次决策树 | Cursor：`followup_message`（`loop_limit: 1`）；Claude/Codex：`{decision:block,reason}` |

`compact` **不**跑 `--init-session`，避免压缩后清空已读记录、制造先读后写误报。`resume` 会重置已读追踪与脏标记（当前窗口未必读过上一会话标记的文件），并注入重读提醒。

不接 `UserPromptSubmit`：铁律以工作区 `AGENTS.md` 为准，周期重复注入会稀释上下文。不用时钟或轮次催记忆。

写入工具匹配：Claude `Write|Edit`；Cursor `Write|StrReplace|Edit|ApplyPatch`；Codex `write|edit|apply_patch`。

记忆脏标记与已读追踪写在同一份运行时 JSON（系统临时目录，不进 git）。`AI_MEMORY.md` / `TASK_MEMORY.md` 不算 dirty。Stop 每会话最多催一次；hook 不代替「当时写入」长期规则，也不自动改记忆文件。

## 各工具配置

| 工具 | 配置文件 | 接线 |
|------|----------|------|
| Claude Code | `.claude/settings.json` | 上表全部（含 compact/resume 重读注入与 Stop 催办） |
| Cursor | `.cursor/hooks.json` | init-session + 写前拦截 + 读记录 + 写后脏标记 + Stop 催办（`loop_limit: 1`）。不注入 `hookSpecificOutput`；压缩后按 `context-compression-guidelines.md` 自行重读 |
| Codex | `.codex/hooks.json` | 与 Claude 相同的 SessionStart 拆分 + 写前拦截 + 读记录 + 脏标记 + Stop |
| Kimi | 无 | 仓库内没有配置，不要当成已接线。生成器打印的片段无 matcher，SessionStart 会三条都跑 |

重新生成接线：`bash scripts/generate-guard-config.sh --tool claude|cursor|codex`。该脚本合并已有 JSON 的 `hooks` 字段，不根据规则列表生成 `constraints.json`。Kimi 仅向终端打印片段，不写入仓库。

## 机检与铁律

- 先读后写：铁律要求先 Read；机检 `read-before-write` 为 **warn**，不阻断写入。
- 语言专属禁令（`any` / `var` / `==` / `console.log` 等）由 PreToolUse 按文件类型拦截，见 `coding-standards/typescript.md`。
