---
name: add-guard-rule
description: >
  向 constraints.json 添加/修改/删除 PreToolUse 写前拦截规则。当用户说"加一条拦截规则"、
  "新增 guard"、"这条也拦截一下"、"加到约束里"、"移除某条规则"时使用。
  改 hook 事件接线、注入脚本或压缩提醒时改 hooks.md / generate-guard-config.sh，不用本 skill。
---

# Add Guard Rule

> 本 skill 只负责操作 `constraints.json` 里的写前拦截规则。
> hook 事件 → 脚本接线见 `.agents/hooks.md`，不要用本 skill 改 SessionStart / compact 注入。

## 必读规范

1. `constraints.json` — 当前已有规则，避免重复
2. `.agents/hooks.md` — 接线总览
3. `.agents/hooks/pre-tool-use.md` — 规则语法

## 执行骨架

### 添加规则

1. **确认需求**：搞清要拦截什么——具体模式？适用文件？阻断还是警告？
2. **读取现有规则**：`jq -r '.rules[] | "\(.id): \(.name)"' constraints.json` — 防止重复。
3. **确定 check.type**：
   - `content-regex-forbidden` — 正则匹配代码内容（最常用）
   - `file-max-lines` — 文件行数限制
   - `read-before-write` — 写前先读（无需 params）
4. **生成规则 JSON**，字段：

   ```jsonc
   {
     "id": "kebab-case-id",          // 唯一，如 "no-eval"
     "name": "中文简称",               // 如 "禁止 eval()"
     "description": "详细说明",
     "severity": "error",             // error=阻断 | warn=警告
     "category": "custom",            // code-quality/security/style/custom...
     "source": "用户要求",
     "check": {
       "type": "content-regex-forbidden",
       "params": { "regex": "正则表达式" }
     },
     "file_patterns": ["<按要拦截的文件类型填写>"],
     "exclude_patterns": ["*.test.*","*.spec.*"],
     "message": "违规时显示的简短消息",
     "suggestion": "给 AI 的修复建议"
   }
   ```

   `file_patterns` 必须按实际拦截的文件填写，不要默认 TypeScript。

5. **插入 constraints.json**：追加到 `rules` 数组末尾（顺序不影响检查）。
6. **告知用户**：规则 id、何时生效（立即，下次 Write 调用即拦截）。

### 修改规则

1. 先 `--list` 找到目标规则的 id。
2. 读取 JSON，定位对应对象，修改字段。
3. 告知变更内容。

### 删除规则

1. `jq --arg rid '<id>' '.rules |= map(select(.id != $rid))' constraints.json > constraints.json.tmp && mv constraints.json.tmp constraints.json`
2. 确认删除结果。

## 正则表达式速查

| 要拦截 | 正则 |
|--------|------|
| `eval()` | `\\beval\\s*\\(` |
| `debugger` | `\\bdebugger\\b` |
| `localStorage.setItem` | `localStorage\\.setItem\\s*\\(` |
| `sessionStorage` | `sessionStorage\\.` |
| `document.write` | `document\\.write\\s*\\(` |
| `with 语句` | `\\bwith\\s*\\(` |
| `new Function` | `new\\s+Function\\s*\\(` |
| `setTimeout 字符串` | `setTimeout\\s*\\(\\s*['\"]` |

## 必守红线

- 规则 id 必须唯一，新增前先查重。
- `severity: "error"` = 阻断写入（AI 被迫修改），`"warn"` = 仅告警（允许写入）。
- 不在 `file_patterns` 中加 `*` 通配除非确实适用所有文件（如密钥检测）。
- 修改后**无需重新生成**——guard 脚本实时读取 constraints.json。
- 不删除用户未确认的规则。
