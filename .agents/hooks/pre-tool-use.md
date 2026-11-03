# Hook: PreToolUse Guard — 写前拦截

> 接线总览（事件、脚本、各工具配置）见 [hooks.md](../hooks.md)。
> 本文件只说明 **PreToolUse 写前检查**：规则定义、检查类型、如何加规则。

触发时机：AI 调用 Write / Edit / StrReplace 等写入工具之前。
违规则阻止写入；脚本自身出错则放行（fail-open）。

---

## 工作原理

```text
AI 准备写入文件
        │
        ▼
┌──────────────────────────────┐
│  pre-edit-guard.sh --check   │
│  1. 读取 stdin JSON          │
│  2. 识别工具格式              │
│  3. 匹配 constraints.json    │
│  4. 放行或阻断                │
└──────────────────────────────┘
```

Claude / Codex 阻断：`{"decision":"block","reason":"..."}`  
Cursor 阻断：`{"permission":"deny","agent_message":"..."}`

---

## 系统组成

| 组件 | 路径 | 职责 |
|------|------|------|
| 接线 | `.agents/hooks.md` | 事件 → 脚本 → 配置 |
| 规则定义 | `constraints.json` | 可机检规则的唯一定义点 |
| 拦截脚本 | `scripts/pre-edit-guard.sh` | `--check` / `--record-read` / `--init-session` |
| 配置生成 | `scripts/generate-guard-config.sh` | 写入各工具 hook 配置 |
| 本文档 | `.agents/hooks/pre-tool-use.md` | 规则语法与扩展 |

---

## 扩展规则

编辑 `constraints.json` 的 `rules` 数组。也可用 `/add-guard-rule`。

```jsonc
{
  "id": "my-new-rule",
  "name": "规则中文名",
  "severity": "error",           // error=阻断 | warn=警告
  "category": "code-quality",
  "source": ".agents/xxx.md",
  "check": {
    "type": "content-regex-forbidden",
    "params": { "regex": "..." }
  },
  "file_patterns": ["*.ts"],
  "exclude_patterns": [],
  "message": "违规描述",
  "suggestion": "修复建议"
}
```

`check.type`：

- `file-max-lines`：文件行数
- `content-regex-forbidden`：正则禁用
- `read-before-write`：写前是否已读（当前为 warn，不阻断）

---

## 设计原则

- Fail-open：脚本出错不阻断编辑
- 同一套 `pre-edit-guard.sh`，按 stdin 识别工具格式
- 路径比较前规范化斜杠（Windows `C:\` 与 Git Bash `/c/` 视为同一路径）
- 只改 `constraints.json` 即可加规则，不必改脚本
