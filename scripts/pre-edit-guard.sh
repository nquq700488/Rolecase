#!/usr/bin/env bash
# ==============================================================================
# pre-edit-guard.sh — PreToolUse hook：AI 写文件前拦截检查
#
# 【触发时机】AI 调用 Write/Edit 工具之前，Claude Code/Codex/Kimi/Cursor 自动执行本脚本。
# 【作用】读取 constraints.json 中定义的所有规则，逐条检查 AI 要写入的代码。
#         违规 → Claude/Kimi/Codex: {"decision":"block","reason":"..."}；Cursor: {"permission":"deny","agent_message":"..."}
#         合规 → Claude: {}；Cursor: {"permission":"allow"}
#         脚本自身出错 → fail-open，放行（不阻断正常开发）。
#
# 【怎么改规则】编辑 constraints.json，无需修改本脚本。
# ==============================================================================

# ---- 安全模式：任何未捕获的错误立即退出，使用未定义变量也退出 ----
set -euo pipefail

VERSION="1.0.0"

OUTPUT_FORMAT="claude"
POSITIONAL=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --output-format)
            OUTPUT_FORMAT="${2:-claude}"
            shift 2
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done
if ((${#POSITIONAL[@]})); then
    set -- "${POSITIONAL[@]}"
else
    set --
fi

# Windows 路径（C:\foo 或 C:/foo）收到正斜杠 /c/foo，避免读写追踪对不上。
norm_path() {
    local p="${1:-}"
    p=$(printf '%s' "$p" | tr '\\' '/')
    while [[ ${#p} -gt 1 && "$p" == */ ]]; do
        p="${p%/}"
    done
    if [[ "$p" =~ ^[A-Za-z]:/ ]]; then
        local d
        d=$(printf '%s' "${p:0:1}" | tr 'A-Z' 'a-z')
        p="/${d}${p:2}"
    fi
    printf '%s' "$p"
}

guard_tmp() {
    local t="${TMPDIR:-${TEMP:-${TMP:-/tmp}}}"
    norm_path "$t"
}

# ---- 路径解析 ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(norm_path "$(cd "$SCRIPT_DIR/.." && pwd)")"
CF="$PROJECT_DIR/constraints.json"
LOG_FILE="$PROJECT_DIR/.hook-execution.log"

log() { printf "[%s] [%-20s] %s\n" "$(date +'%H:%M:%S')" "pre-edit" "$*" >> "$LOG_FILE"; }

# ---- ANSI 颜色代码（用于 stderr 诊断输出）----
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'  # 重置颜色

# ==============================================================================
# 工具函数
# ==============================================================================

# 获取会话状态文件路径（每个项目一个独立文件）
# 内容示例：{"session_start":"...","project":"...","reads":["/path/to/file.ts"],"memory_dirty":false,"memory_nudged":false}
gtf() {
    local h t
    h=$(printf '%s' "$PROJECT_DIR" | tr '/. ' '___' | cut -c1-16 || echo "d")
    t="$(guard_tmp)"
    echo "${t}/ai-guard-reads-${h}.json"
}

ensure_tf() {
    local tf n
    tf=$(gtf)
    if [[ ! -f "$tf" ]]; then
        n=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
        jq -n --arg n "$n" --arg p "$PROJECT_DIR" \
            '{session_start:$n, project:$p, reads:[], memory_dirty:false, memory_nudged:false}' \
            > "$tf" 2>/dev/null || printf '{"session_start":"%s","project":"%s","reads":[],"memory_dirty":false,"memory_nudged":false}\n' "$n" "$PROJECT_DIR" > "$tf"
    fi
    printf '%s' "$tf"
}

is_memory_md() {
    local b
    b=$(basename "${1:-}")
    [[ "$b" == "AI_MEMORY.md" || "$b" == "TASK_MEMORY.md" ]]
}

extract_hook_path() {
    jq -r '.tool_input.file_path // .tool_input.path // .file_path // .path // .arguments.filePath // .parameters.path // ""' 2>/dev/null
}

# 输出「放行」JSON（Claude 空对象 = 允许；Cursor 用 permission.allow）
allow() {
    if [[ "$OUTPUT_FORMAT" == "cursor" ]]; then
        printf '{"permission":"allow"}\n'
    else
        printf '{}\n'
    fi
}

# 输出「拒绝」JSON 决策
# $* = 拒绝原因（中文），会显示给 AI 看
deny() {
    local reason="$*"
    if [[ "$OUTPUT_FORMAT" == "cursor" ]]; then
        jq -n --arg reason "$reason" '{
            permission: "deny",
            agent_message: $reason
        }'
    else
        jq -n --arg reason "$reason" '{
            decision: "block",
            reason: $reason
        }'
    fi
}

# ==============================================================================
# 模式分发（通过第一个参数区分）
# ==============================================================================

# ---- --version：输出版本号 ----
[[ "${1:-}" == "--version" ]] && { echo "pre-edit-guard.sh v$VERSION"; exit 0; }

# ---- --init-session：初始化本次会话的读追踪与记忆脏标记 ----
# 由 SessionStart（startup|clear|resume）调用；compact 不清已读追踪
if [[ "${1:-}" == "--init-session" ]]; then
    TF=$(gtf)
    n=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
    jq -n --arg n "$n" --arg p "$PROJECT_DIR" \
        '{session_start:$n, project:$p, reads:[], memory_dirty:false, memory_nudged:false}' \
        > "$TF" 2>/dev/null || printf '{"session_start":"%s","project":"%s","reads":[],"memory_dirty":false,"memory_nudged":false}\n' "$n" "$PROJECT_DIR" > "$TF"
    echo -e "${GREEN}✓${NC} init done" >&2
    log "✓ SessionStart 初始化完成"
    exit 0
fi

# ---- --record-read：记录 AI 读取了某个文件 ----
# 由 Claude Code/Codex PostToolUse(Read) hook 调用
# stdin 接收 Read 工具的调用 JSON，从中提取文件路径
if [[ "${1:-}" == "--record-read" ]]; then
    TF=$(gtf)
    [[ ! -f "$TF" ]] && exit 0          # 追踪文件不存在则跳过
    # 从 stdin JSON 中提取文件路径（兼容 Claude/Kimi/Codex 三种格式）
    fp=$(cat | extract_hook_path)
    [[ -n "${2:-}" ]] && fp="$2"        # 命令行第二个参数也可直接指定路径
    fp="$(norm_path "$fp")"
    if [[ -n "$fp" && "$fp" != "null" ]]; then
        # 加入 reads 数组并去重
        jq --arg f "$fp" '.reads += [$f] | .reads |= unique' "$TF" > "${TF}.tmp" 2>/dev/null && mv "${TF}.tmp" "$TF" || true
    fi
    exit 0
fi

# ---- --mark-dirty：写入成功后更新记忆脏标记（PostToolUse 写入工具）----
# 改 AI_MEMORY.md / TASK_MEMORY.md → 清除 dirty；改其他项目文件 → 置 dirty
if [[ "${1:-}" == "--mark-dirty" ]]; then
    echo '{}'
    TF=$(ensure_tf) || exit 0
    fp=$(cat | extract_hook_path || true)
    fp="$(norm_path "${fp:-}")"
    [[ -z "$fp" || "$fp" == "null" ]] && exit 0
    if is_memory_md "$fp"; then
        jq '.memory_dirty = false' "$TF" > "${TF}.tmp" 2>/dev/null && mv "${TF}.tmp" "$TF" || true
        log "✓ 记忆文件已写，清除 dirty | $fp"
    else
        jq '.memory_dirty = true' "$TF" > "${TF}.tmp" 2>/dev/null && mv "${TF}.tmp" "$TF" || true
        log "✓ 置 dirty | $fp"
    fi
    exit 0
fi

# ---- --stop-nudge：会话将结束时，若仍 dirty 且本会话未催过，则催办一次 ----
# Cursor：followup_message（loop_limit: 1）；Claude/Codex：decision=block
if [[ "${1:-}" == "--stop-nudge" ]]; then
    TF=$(gtf)
    if [[ ! -f "$TF" ]]; then
        echo '{}'
        exit 0
    fi
    dirty=$(jq -r '.memory_dirty // false' "$TF" 2>/dev/null || echo false)
    nudged=$(jq -r '.memory_nudged // false' "$TF" 2>/dev/null || echo false)
    if [[ "$dirty" != "true" || "$nudged" == "true" ]]; then
        echo '{}'
        exit 0
    fi
    NOTICE="$SCRIPT_DIR/../.agents/hooks/memory-stop-nudge.md"
    msg=$(tr '\n' ' ' < "$NOTICE" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//' || true)
    [[ -z "$msg" ]] && msg="请过 .agents/hooks/memory-write-decision.md。命中则写记忆；否则回复「无需落盘」。不要再改业务代码。"
    jq '.memory_nudged = true' "$TF" > "${TF}.tmp" 2>/dev/null && mv "${TF}.tmp" "$TF" || true
    if [[ "$OUTPUT_FORMAT" == "cursor" ]]; then
        jq -n --arg m "$msg" '{followup_message: $m}' 2>/dev/null || echo '{}'
    else
        jq -n --arg m "$msg" '{decision:"block", reason:$m}' 2>/dev/null || echo '{}'
    fi
    log "✓ Stop 催办一次记忆决策树"
    exit 0
fi

# ==============================================================================
# --check（默认模式）：PreToolUse 写入前拦截检查
# ==============================================================================

# ---- 步骤 1：读取 stdin JSON（AI 要执行的工具调用信息）----
# Claude Code 格式：{"tool_name":"Write","tool_input":{"file_path":"...","content":"..."}}
# Cursor 格式：     {"hook_event_name":"preToolUse","tool_name":"Write","tool_input":{"path":"...","contents":"..."}}
# Kimi 格式：      {"tool":"write_to_file","arguments":{"filePath":"...","content":"..."}}
# Codex 格式：     {"tool_name":"write","parameters":{"path":"...","content":"..."}}
SJ=$(cat)
if echo "$SJ" | jq -e '.hook_event_name == "preToolUse"' >/dev/null 2>&1; then
    OUTPUT_FORMAT="cursor"
fi
TN=""   # 工具名（Tool Name）
FP=""   # 文件路径（File Path）
CT=""   # 文件内容（Content）
OS=""   # 旧文本（Edit 的 old_string）
NS=""   # 新文本（Edit 的 new_string）

# ---- 步骤 2：识别工具格式，提取关键字段 ----
if echo "$SJ" | jq -e '.tool_name and .tool_input' >/dev/null 2>&1; then
    # Claude Code / Kimi v2 格式
    TN=$(echo "$SJ" | jq -r '.tool_name // ""')
    FP=$(echo "$SJ" | jq -r '.tool_input.file_path // .tool_input.path // ""')
    CT=$(echo "$SJ" | jq -r '.tool_input.content // .tool_input.contents // ""')
    OS=$(echo "$SJ" | jq -r '.tool_input.old_string // ""')
    NS=$(echo "$SJ" | jq -r '.tool_input.new_string // ""')
elif echo "$SJ" | jq -e '.tool and .arguments' >/dev/null 2>&1; then
    # Kimi 格式
    TN=$(echo "$SJ" | jq -r '.tool // ""')
    FP=$(echo "$SJ" | jq -r '.arguments.filePath // .arguments.path // ""')
    CT=$(echo "$SJ" | jq -r '.arguments.content // ""')
    OS=$(echo "$SJ" | jq -r '.arguments.old_str // ""')
    NS=$(echo "$SJ" | jq -r '.arguments.new_str // ""')
elif echo "$SJ" | jq -e '.tool_name and .parameters' >/dev/null 2>&1; then
    # Codex 格式
    TN=$(echo "$SJ" | jq -r '.tool_name // ""')
    FP=$(echo "$SJ" | jq -r '.parameters.path // ""')
    CT=$(echo "$SJ" | jq -r '.parameters.content // ""')
    OS=$(echo "$SJ" | jq -r '.parameters.old_string // ""')
    NS=$(echo "$SJ" | jq -r '.parameters.new_string // ""')
else
    echo -e "${YELLOW}!${NC} unknown format" >&2
    allow
    exit 0
fi

FP="$(norm_path "$FP")"

# ---- 步骤 3：快速放行（非写入操作 / 无文件路径 / 规则文件缺失）----
# 非写入工具（如 Read、Bash）→ 不检查，直接放行
! echo "$TN" | grep -qiE 'write|edit|apply_patch|replace|create_file|Write|Edit|WriteFile|StrReplaceFile|StrReplace|write_to_file|replace_in_file' && { allow; exit 0; }
# 无法确定文件路径 → 放行
[[ -z "$FP" || "$FP" == "null" ]] && { allow; exit 0; }
# constraints.json 不存在 → 放行（不阻断正常开发）
[[ ! -f "$CF" ]] && { echo -e "${YELLOW}!${NC} no constraints.json" >&2; allow; exit 0; }

# ---- 步骤 4：准备检查 ----
FB=$(basename "$FP")     # 文件名（用于 glob 匹配，如 "app.ts"）
VE=()                    # 阻断级违规 ID 列表（error severity）
VW=()                    # 警告级违规 ID 列表（warn severity）
REASONS=()               # 对应的修复建议

# ---- 工具函数 ----

# glob_match：文件名通配匹配（如 "*.ts" 匹配 "app.ts"）
gm() {
    local pattern="$1" filename="$2"
    local regex
    regex=$(echo "$pattern" | sed 's/\./\\./g; s/\*/.*/g; s/\?/./g')
    echo "$filename" | grep -qE "^${regex}$"
}

# should_check：判断某条规则是否适用于当前文件
# 检查规则的 file_patterns（白名单）和 exclude_patterns（黑名单）
sc() {
    local rj="$1" fn="$2" m=false   # rj=规则JSON, fn=文件名
    local ps xs

    # 提取白名单：规则只适用于这些文件类型
    ps=$(echo "$rj" | jq -r '.file_patterns // [] | .[]?')
    if [[ -z "$ps" ]]; then
        m=true                        # 无白名单 → 适用所有文件
    else
        while IFS= read -r p; do
            [[ -z "$p" ]] && continue
            gm "$p" "$fn" && { m=true; break; }
        done <<< "$ps"
    fi
    [[ "$m" != "true" ]] && return 1   # 文件名不匹配白名单 → 跳过此规则

    # 提取黑名单：测试文件、声明文件等不受此规则约束
    xs=$(echo "$rj" | jq -r '.exclude_patterns // [] | .[]?')
    [[ -n "$xs" ]] && {
        while IFS= read -r p; do
            [[ -z "$p" ]] && continue
            gm "$p" "$fn" && return 1   # 命中黑名单 → 跳过此规则
        done <<< "$xs"
    }
    return 0
}

# get_check_content：获取待检查的内容
# Write 操作 → 从 stdin JSON 中取 content
# Edit 操作 → 读取磁盘文件，用纯 bash 替换 old_string → new_string 后输出新内容预览
gcc() {
    [[ -n "$CT" && "$CT" != "null" ]] && { echo "$CT"; return 0; }
    if [[ -n "$OS" && "$OS" != "null" && -f "$FP" ]]; then
        local content
        content=$(<"$FP")
        # ${var/"$old"/"$new"} — 引号包裹 = 字面量替换（不做 glob），仅替换首次出现
        # old_string 不存在于文件时原样返回
        echo "${content/"$OS"/"$NS"}"
        return 0
    fi
    return 1
}

# 记录一条阻断级违规
add_err() {
    VE+=("$1")            # 规则 ID
    REASONS+=("$2")       # 修复建议
}

# ---- 步骤 5：获取待检查代码内容 ----
CC=""   # Check Content
gcc >/dev/null 2>&1 && CC=$(gcc) || true

# ---- 步骤 6：加载约束规则，逐条检查 ----
RC=$(jq '.rules | length' "$CF" 2>/dev/null || echo 0)   # 规则总数

for ((i = 0; i < RC; i++)); do
    rj=$(jq -c ".rules[$i]" "$CF")                        # 当前规则 JSON
    rid=$(echo "$rj" | jq -r '.id')                       # 规则 ID，如 "no-console-log"
    sev=$(echo "$rj" | jq -r '.severity')                 # 级别：error 阻断 / warn 警告
    ct=$(echo "$rj" | jq -r '.check.type')                # 检查类型

    # 文件名不匹配此规则的适用范围 → 跳过
    sc "$rj" "$FB" || continue

    # 按检查类型分发到对应的检查函数
    case "$ct" in
        # --- 文件行数检查 ---
        file-max-lines)
            ml=$(echo "$rj" | jq -r '.check.params.max_lines')   # 最大行数
            al=""                                                # 实际行数
            [[ -n "$CC" ]] && al=$(echo "$CC" | wc -l | tr -d ' ') || \
                { [[ -f "$FP" ]] && al=$(wc -l < "$FP" | tr -d ' ') || continue; }
            (( al > ml )) && {
                echo -e "  ${RED}✗${NC} file $FP: $al lines > $ml" >&2
                sg=$(echo "$rj" | jq -r '.suggestion // ""')
                add_err "$rid" "$sg"
            } || true
            ;;

        # --- 正则匹配检查（最常用的检查类型）---
        content-regex-forbidden)
            rx=$(echo "$rj" | jq -r '.check.params.regex')       # 正则表达式
            [[ -z "$CC" ]] && continue                            # 无内容可检查 → 跳过
            mc=0                                                 # 匹配计数
            # 逐行扫描，最多报告 3 处匹配
            while IFS= read -r hit; do
                [[ -z "$hit" ]] && continue
                (( mc < 3 )) && {
                    ln=$(echo "$hit" | cut -d: -f1)                # 行号
                    echo -e "  ${RED}✗${NC} ${FP}:${ln}: ${rid}" >&2
                }
                (( mc++ )) || true
            done < <(echo "$CC" | grep -nE "$rx" 2>/dev/null || true)

            if (( mc > 0 )); then
                (( mc > 3 )) && echo -e "  ${YELLOW}!${NC} ...+$((mc - 3))" >&2
                if [[ "$sev" == "warn" ]]; then
                    VW+=("$rid")                                   # 警告级 → 不阻断
                else
                    sg=$(echo "$rj" | jq -r '.suggestion // ""')
                    add_err "$rid" "$sg"                           # 阻断级 → 记录
                fi
            fi
            ;;

        # --- 写前先读检查 ---
        read-before-write)
            TF=$(gtf)
            [[ ! -f "$TF" ]] && continue                          # 追踪文件不存在 → 跳过
            wr=$(jq --arg f "$FP" '.reads | index($f)' "$TF" 2>/dev/null || echo "null")
            # index() 返回数字 = 已读过，null = 未读过
            [[ "$wr" != "null" && -n "$wr" ]] && continue          # 已读 → 放行
            echo -e "  ${YELLOW}!${NC} file not read: $FP" >&2
            VW+=("read-before-write")                              # 未读 → 警告（不阻断）
            ;;
    esac
done

# ---- 步骤 7：输出决策 ----
E=${#VE[@]}   # 阻断数
W=${#VW[@]}   # 警告数

if (( E > 0 )); then
    # 有阻断级违规 → 拒绝写入
    echo -e "\n${RED}=== GUARD BLOCKED ===${NC}" >&2
    log "✗ BLOCKED: ${E} errors | ${FP} | ${VE[*]}"
    echo -e "${RED}${E} errors${NC}" >&2
    # 把多条建议用分号拼接成一条原因
    reason=$(IFS='; '; echo "${REASONS[*]}")
    deny "$reason"
    exit 0
fi

# 仅有警告 → 放行（不阻断，但 stderr 会提示）
(( W > 0 )) && { echo -e "\n${YELLOW}=== GUARD WARN: ${W} ===${NC}\n" >&2; log "⚠ WARN: ${W} warnings | ${FP} | ${VW[*]}"; }

# 全部通过 → 放行
allow
exit 0
