#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# CCB Start — 启动项目或恢复单个/多个 agent
# ============================================================
#
# 用法:
#   ./start.sh                       启动整个项目（ccbd + 所有 agent 面板）
#   ./start.sh developer             恢复被 park 的 developer（= ccb agent resume）
#   ./start.sh developer tester      同时恢复多个 agent
#   ./start.sh developer --restart   重启 agent 面板（park 过的也可以用这个恢复）
#   ./start.sh -h                    帮助
#
# 与 stop.sh 的对应关系:
#   stop.sh <agent>      → park, 停派发
#   start.sh <agent>     → resume, 恢复派发
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ── 解析参数 ──
RESTART=false
AGENTS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --restart)
            RESTART=true
            shift
            ;;
        -h|--help)
            echo "Usage: $(basename "$0") [OPTIONS] [agent...]"
            echo ""
            echo "启动 CCB 项目或恢复单个 agent。"
            echo ""
            echo "不带 agent 参数: 启动整个项目（ccbd + 所有 agent 面板）"
            echo "带 agent 参数:   恢复被 park 的 agent 派发"
            echo ""
            echo "OPTIONS:"
            echo "  --restart   重启面板（而非 resume,用于面板卡死时）"
            echo "  -h, --help  显示帮助"
            echo ""
            echo "EXAMPLES:"
            echo "  ./start.sh                  # 启动整个项目"
            echo "  ./start.sh developer        # 恢复 developer 派发"
            echo "  ./start.sh developer tester # 恢复多个 agent"
            echo "  ./start.sh developer --restart  # 重启 developer 面板"
            exit 0
            ;;
        *)
            AGENTS+=("$1")
            shift
            ;;
    esac
done

# ── 前置检查 ──
if ! command -v ccb &> /dev/null; then
    echo -e "${RED}✗ ccb 未安装或不在 PATH 中${NC}" >&2
    exit 1
fi

cd "$PROJECT_ROOT"

# ── 修正 Node 版本（codex 等 Node 系 provider 需要 Node >= 16）──
# 本项目 .nvmrc 是 v14，从项目目录的终端启动会把 v14 带进 daemon 继承的
# PATH，导致 codex 以 Node 14 启动后崩溃（ERR_UNSUPPORTED_ESM_URL_SCHEME）。
# 把 nvm 的 default 版本提到 PATH 最前；不写死版本号，换机器也能用。
if [[ -n "${NVM_DIR:-}" && -r "$NVM_DIR/alias/default" ]]; then
    _alias="$(cat "$NVM_DIR/alias/default")"
    case "$_alias" in v*) ;; *) _alias="v$_alias" ;; esac
    _bin="$NVM_DIR/versions/node/$_alias/bin"
    [[ -d "$_bin" ]] || _bin="$(ls -d "$NVM_DIR"/versions/node/"$_alias".*/bin 2>/dev/null | sort -V | tail -n1 || true)"
    if [[ -d "$_bin" ]]; then
        export PATH="$_bin:$PATH"
        case "$("$_bin/node" --version 2>/dev/null)" in
            v1[0-5].*|v[0-9].*) echo -e "${YELLOW}⚠ nvm default 是低版本 Node，codex 需要 >= 16${NC}" >&2 ;;
        esac
    fi
    unset _alias _bin
fi

ccbd_alive() {
    ccb ping ccbd 2>/dev/null | grep -q "pid_alive: True"
}

# ── 模式 A: 启动整个项目 ──
if [[ ${#AGENTS[@]} -eq 0 ]]; then
    if ccbd_alive; then
        echo -e "${GREEN}✓ CCB 已运行${NC}"
        echo "  项目: $PROJECT_ROOT"
        exit 0
    fi

    echo -e "${YELLOW}▶ CCB 未运行，正在启动...${NC}"
    echo "  项目: $PROJECT_ROOT"

    # exec 接管当前终端显示 tmux 界面
    exec ccb "$@"
fi

# ── 模式 B: 恢复/重启单个 agent ──
if ! ccbd_alive; then
    echo -e "${RED}✗ ccbd 未运行，无法操作单个 agent${NC}" >&2
    echo "  请先执行 ./start.sh 启动项目"
    exit 1
fi

if [[ "$RESTART" == true ]]; then
    echo -e "${YELLOW}▶ 正在重启面板...${NC}"
    for agent in "${AGENTS[@]}"; do
        echo "  → $agent"
        ccb restart "$agent"
    done
    echo -e "${GREEN}✓ 面板已重启${NC}"
    exit 0
fi

# resume
echo -e "${YELLOW}▶ 正在恢复 agent 派发...${NC}"
for agent in "${AGENTS[@]}"; do
    echo "  → $agent"
    ccb agent resume "$agent"
done
echo -e "${GREEN}✓ 派发已恢复${NC}"
