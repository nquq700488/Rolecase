#!/usr/bin/env bash
# ==============================================================================
# session-reentry-guard.sh — SessionStart（compact|resume）：注入重读规范提醒
# 正文定义在 .agents/hooks/session-reentry.md，改内容无需改脚本。
# 任何异常都兜底输出 {}（无操作），绝不阻塞会话启动。
# ==============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null)" || { echo '{}'; exit 0; }
NOTICE_FILE="$SCRIPT_DIR/../.agents/hooks/session-reentry.md"
LOG_FILE="$SCRIPT_DIR/../.hook-execution.log"

log() { printf "[%s] [%-20s] %s\n" "$(date +'%H:%M:%S')" "session-reentry" "$*" >> "$LOG_FILE"; }

if [[ ! -f "$NOTICE_FILE" ]] || ! command -v jq >/dev/null 2>&1; then
    log "⚠ 跳过（本仓库无 session-reentry.md 或 jq 不可用）"
    echo '{}'
    exit 0
fi

CTX=$(cat "$NOTICE_FILE" 2>/dev/null) || { echo '{}'; exit 0; }
if [[ -z "${CTX// }" ]]; then
    echo '{}'
    exit 0
fi

jq -n --arg ctx "$CTX" '{
    hookSpecificOutput:{
        hookEventName:"SessionStart",
        additionalContext:$ctx
    }
}' 2>/dev/null && { log "✓ 已注入压缩/恢复后重读提醒"; exit 0; }

echo '{}'
