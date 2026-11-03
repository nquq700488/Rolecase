#!/usr/bin/env bash
# ==============================================================================
# generate-guard-config.sh — 生成各工具 hook 接线（SessionStart / PreToolUse 等）
#
# 使用方式：
#   bash scripts/generate-guard-config.sh              → 所有已支持写入仓库的工具
#   bash scripts/generate-guard-config.sh --tool claude → 仅 Claude Code
#   bash scripts/generate-guard-config.sh --tool kimi   → 仅向终端打印（不写入仓库）
#   bash scripts/generate-guard-config.sh --tool codex  → 仅 Codex
#   bash scripts/generate-guard-config.sh --tool cursor → 仅 Cursor
#
# 不根据 constraints.json 的 rules 生成规则；只读取 tool_matchers 并写入 hook 事件接线。
# Claude / Codex / Cursor：合并已有 JSON 的 hooks 字段。
# Kimi：无仓库配置，只打印供本机手动合并。
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONSTRAINTS_FILE="$PROJECT_DIR/constraints.json"

CLAUDE_CONFIG="$PROJECT_DIR/.claude/settings.json"
CODEX_CONFIG="$PROJECT_DIR/.codex/hooks.json"
CURSOR_CONFIG="$PROJECT_DIR/.cursor/hooks.json"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

TOOL="${1:-all}"
if [[ "$TOOL" == "--tool" ]]; then
    TOOL="${2:-all}"
fi

if [[ ! -f "$CONSTRAINTS_FILE" ]]; then
    echo -e "${RED}✗${NC} constraints.json 不存在，请先创建" >&2
    exit 1
fi

if ! jq -e '.rules' "$CONSTRAINTS_FILE" >/dev/null 2>&1; then
    echo -e "${RED}✗${NC} constraints.json 格式无效" >&2
    exit 1
fi

RULE_COUNT=$(jq '.rules | length' "$CONSTRAINTS_FILE")
echo -e "${GREEN}✓${NC} 从 constraints.json 读取 ${RULE_COUNT} 条规则"

merge_json_key() {
    local output="$1"
    local key="$2"
    local value="$3"
    local dir
    dir=$(dirname "$output")
    mkdir -p "$dir"

    if [[ -f "$output" ]] && jq -e 'type == "object"' "$output" >/dev/null 2>&1; then
        jq --argjson val "$value" ".$key = \$val" "$output" > "${output}.tmp" && mv "${output}.tmp" "$output"
    else
        jq -n --arg key "$key" --argjson val "$value" '{($key): $val}' > "$output"
    fi
}

# ---- 生成 Claude Code 配置 ----------------------------------------------------
generate_claude() {
    local output="$CLAUDE_CONFIG"
    local write_matcher read_matcher hooks
    write_matcher=$(jq -r '.tool_matchers.claude_code.write // "Write|Edit"' "$CONSTRAINTS_FILE")
    read_matcher=$(jq -r '.tool_matchers.claude_code.read // "Read"' "$CONSTRAINTS_FILE")

    hooks=$(jq -n --arg wm "$write_matcher" --arg rm "$read_matcher" \
      --arg init 'bash "${CLAUDE_PROJECT_DIR}/scripts/pre-edit-guard.sh" --init-session' \
      --arg memory 'bash "${CLAUDE_PROJECT_DIR}/scripts/memory-reminder-guard.sh"' \
      --arg reentry 'bash "${CLAUDE_PROJECT_DIR}/scripts/session-reentry-guard.sh"' \
      --arg check 'bash "${CLAUDE_PROJECT_DIR}/scripts/pre-edit-guard.sh" --check' \
      --arg record 'bash "${CLAUDE_PROJECT_DIR}/scripts/pre-edit-guard.sh" --record-read' \
      --arg dirty 'bash "${CLAUDE_PROJECT_DIR}/scripts/pre-edit-guard.sh" --mark-dirty' \
      --arg nudge 'bash "${CLAUDE_PROJECT_DIR}/scripts/pre-edit-guard.sh" --stop-nudge' \
      '{
      SessionStart: [
        {
          matcher: "startup|clear|resume",
          hooks: [
            {type:"command", command:$init},
            {type:"command", command:$memory}
          ]
        },
        {
          matcher: "compact|resume",
          hooks: [
            {type:"command", command:$reentry}
          ]
        }
      ],
      PreToolUse: [
        {
          matcher: $wm,
          hooks: [
            {type:"command", command:$check}
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: $rm,
          hooks: [
            {type:"command", command:$record}
          ]
        },
        {
          matcher: $wm,
          hooks: [
            {type:"command", command:$dirty}
          ]
        }
      ],
      Stop: [
        {
          hooks: [
            {type:"command", command:$nudge}
          ]
        }
      ]
    }')

    merge_json_key "$output" "hooks" "$hooks"
    echo -e "  ${GREEN}✓${NC} Claude Code: ${output}（已合并 hooks，保留其余字段）"
}

# ---- 生成 Kimi 配置 -----------------------------------------------------------
generate_kimi() {
    local write_matcher read_matcher
    write_matcher=$(jq -r '.tool_matchers.kimi.write // "write_to_file|replace_in_file|WriteFile|StrReplaceFile"' "$CONSTRAINTS_FILE")
    read_matcher=$(jq -r '.tool_matchers.kimi.read // "read_file|ReadFile"' "$CONSTRAINTS_FILE")

    echo ""
    echo -e "${YELLOW}======== Kimi 配置（手动合并到 ~/.kimi/config.toml）========${NC}"
    echo ""
    cat <<TOML_CONFIG
# === PreToolUse Guard ===
# 无 matcher：无法把 init 从 compact 拆开；session-reentry 在 startup 也会跑（可接受）。
[[hooks]]
event = "SessionStart"
command = "bash scripts/pre-edit-guard.sh --init-session"

[[hooks]]
event = "SessionStart"
command = "bash scripts/memory-reminder-guard.sh"

[[hooks]]
event = "SessionStart"
command = "bash scripts/session-reentry-guard.sh"

[[hooks]]
event = "PreToolUse"
matcher = "${write_matcher}"
command = "bash scripts/pre-edit-guard.sh --check"
timeout = 10

[[hooks]]
event = "PostToolUse"
matcher = "${read_matcher}"
command = "bash scripts/pre-edit-guard.sh --record-read"
timeout = 5

[[hooks]]
event = "PostToolUse"
matcher = "${write_matcher}"
command = "bash scripts/pre-edit-guard.sh --mark-dirty"
timeout = 5

[[hooks]]
event = "Stop"
command = "bash scripts/pre-edit-guard.sh --stop-nudge"
TOML_CONFIG
    echo ""
    echo -e "${YELLOW}==============================================================${NC}"
    echo -e "  ${YELLOW}↑ 复制以上内容到 ~/.kimi/config.toml（替换 hooks = []）${NC}"
}

# ---- 生成 Codex 配置 ----------------------------------------------------------
generate_codex() {
    local output="$CODEX_CONFIG"
    local write_matcher read_matcher hooks
    write_matcher=$(jq -r '.tool_matchers.codex.write // "write|edit|apply_patch"' "$CONSTRAINTS_FILE")
    read_matcher=$(jq -r '.tool_matchers.codex.read // "read_file|Read"' "$CONSTRAINTS_FILE")

    hooks=$(jq -n --arg wm "$write_matcher" --arg rm "$read_matcher" '{
      SessionStart: [
        {
          matcher: "startup|clear|resume",
          hooks: [
            {type:"command", command:"bash scripts/pre-edit-guard.sh --init-session"},
            {type:"command", command:"bash scripts/memory-reminder-guard.sh"}
          ]
        },
        {
          matcher: "compact|resume",
          hooks: [
            {type:"command", command:"bash scripts/session-reentry-guard.sh"}
          ]
        }
      ],
      PreToolUse: [
        {
          matcher: $wm,
          hooks: [
            {type:"command", command:"bash scripts/pre-edit-guard.sh --check", timeout: 10}
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: $rm,
          hooks: [
            {type:"command", command:"bash scripts/pre-edit-guard.sh --record-read", timeout: 5}
          ]
        },
        {
          matcher: $wm,
          hooks: [
            {type:"command", command:"bash scripts/pre-edit-guard.sh --mark-dirty", timeout: 5}
          ]
        }
      ],
      Stop: [
        {
          hooks: [
            {type:"command", command:"bash scripts/pre-edit-guard.sh --stop-nudge"}
          ]
        }
      ]
    }')

    merge_json_key "$output" "hooks" "$hooks"
    echo -e "  ${GREEN}✓${NC} Codex: $output"
}

# ---- 生成 Cursor 配置 ---------------------------------------------------------
generate_cursor() {
    local output="$CURSOR_CONFIG"
    local hooks
    hooks=$(jq -n '{
      sessionStart: [
        {command: "bash scripts/pre-edit-guard.sh --init-session"}
      ],
      preToolUse: [
        {
          command: "bash scripts/pre-edit-guard.sh --check --output-format cursor",
          matcher: "Write|StrReplace|Edit|ApplyPatch"
        }
      ],
      postToolUse: [
        {
          command: "bash scripts/pre-edit-guard.sh --record-read",
          matcher: "Read"
        },
        {
          command: "bash scripts/pre-edit-guard.sh --mark-dirty",
          matcher: "Write|StrReplace|Edit|ApplyPatch"
        }
      ],
      stop: [
        {
          command: "bash scripts/pre-edit-guard.sh --stop-nudge --output-format cursor",
          loop_limit: 1
        }
      ]
    }')

    local dir
    dir=$(dirname "$output")
    mkdir -p "$dir"

    if [[ -f "$output" ]] && jq -e 'type == "object"' "$output" >/dev/null 2>&1; then
        jq --argjson hooks "$hooks" '.hooks = $hooks | .version = (.version // 1)' "$output" > "${output}.tmp" && mv "${output}.tmp" "$output"
    else
        jq -n --argjson hooks "$hooks" '{version: 1, hooks: $hooks}' > "$output"
    fi
    echo -e "  ${GREEN}✓${NC} Cursor: $output"
}

# ---- 执行生成 ----------------------------------------------------------------
case "${TOOL:-all}" in
    claude|Claude|CLAUDE)
        generate_claude
        ;;
    kimi|Kimi|KIMI)
        generate_kimi
        ;;
    codex|Codex|CODEX)
        generate_codex
        ;;
    cursor|Cursor|CURSOR)
        generate_cursor
        ;;
    all|"")
        generate_claude
        generate_kimi
        generate_codex
        generate_cursor
        ;;
    *)
        echo -e "${RED}✗${NC} 未知工具: $TOOL，支持: claude, kimi, codex, cursor, all" >&2
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}═══════════════════════════════════${NC}"
echo -e "${GREEN}生成完成！${NC}"
echo ""
case "${TOOL:-all}" in
    claude|Claude|CLAUDE)
        echo -e "  Claude Code: ${GREEN}.claude/settings.json${NC}（已合并 hooks）"
        ;;
    codex|Codex|CODEX)
        echo -e "  Codex:       ${GREEN}.codex/hooks.json${NC}（已写入，首次需 /hooks 信任）"
        ;;
    cursor|Cursor|CURSOR)
        echo -e "  Cursor:      ${GREEN}.cursor/hooks.json${NC}"
        ;;
    kimi|Kimi|KIMI)
        echo -e "  Kimi:        ${YELLOW}复制上方输出到 ~/.kimi/config.toml${NC} (替换 hooks = []）"
        ;;
    *)
        echo -e "  Claude Code: ${GREEN}.claude/settings.json${NC}（已合并 hooks）"
        echo -e "  Codex:       ${GREEN}.codex/hooks.json${NC}"
        echo -e "  Cursor:      ${GREEN}.cursor/hooks.json${NC}"
        echo -e "  Kimi:        ${YELLOW}复制上方输出到 ~/.kimi/config.toml${NC}"
        ;;
esac
echo -e "${GREEN}═══════════════════════════════════${NC}"
