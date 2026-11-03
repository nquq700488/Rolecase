#!/usr/bin/env bash
# ==============================================================================
# memory-reminder-guard.sh — SessionStart：注入本仓库记忆决策树
# 只读项目内 .agents/hooks/memory-write-decision.md；不存在则跳过（fail-open）。
# ==============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null)" || { echo '{}'; exit 0; }
NOTICE_FILE="$SCRIPT_DIR/../.agents/hooks/memory-write-decision.md"
LOG_FILE="$SCRIPT_DIR/../.hook-execution.log"

log() { printf "[%s] [%-20s] %s\n" "$(date +'%H:%M:%S')" "memory-reminder" "$*" >> "$LOG_FILE"; }

if [[ ! -f "$NOTICE_FILE" ]] || ! command -v jq >/dev/null 2>&1; then
    log "⚠ 跳过（本仓库无 memory-write-decision.md 或 jq 不可用）"
    echo '{}'
    exit 0
fi

CTX=$(jq -Rs 'gsub("\n";" ")' "$NOTICE_FILE" 2>/dev/null)
if [[ -z "${CTX:-}" ]]; then
    echo '{}'
    exit 0
fi

jq -n --arg ctx "$CTX" '{
    hookSpecificOutput:{
        hookEventName:"SessionStart",
        additionalContext:("有实质性改动时过本仓库记忆决策树：\n\n" + $ctx)
    }
}' 2>/dev/null && { log "✓ 已注入本仓库决策树"; exit 0; }

echo '{}'
