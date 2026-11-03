#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# CCB Stop — 停止项目或单个/多个 agent
# ============================================================
#
# 用法:
#   ./stop.sh                       停止整个项目（所有 agent + ccbd）
#   ./stop.sh -f                    强制停止整个项目
#   ./stop.sh developer             只停 developer（park: 停止派发,保留面板和队列）
#   ./stop.sh developer tester      同时停多个 agent
#   ./stop.sh developer --clear     park + 清空对话上下文
#   ./stop.sh developer --restart   重启单个 agent 面板（队列不丢）
#   ./stop.sh -h                    帮助
#
# 注意:
#   - park 不会丢任务，只是暂停派发。队列里的任务保留在 ccbd。
#   - 想恢复用 ./start.sh developer （= ccb agent resume developer）。
#   - ccb restart 只重启 tmux 面板,ccbd 检测到后会把队列续投,不等于"停掉任务"。
#   - 想取消某个排队任务: ccb repair ack <agent> <iev_id>
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ── 解析参数 ──
FORCE=false
CLEAR=false
RESTART=false
AGENTS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        -f|--force)
            FORCE=true
            shift
            ;;
        --clear)
            CLEAR=true
            shift
            ;;
        --restart)
            RESTART=true
            shift
            ;;
        -h|--help)
            echo "Usage: $(basename "$0") [OPTIONS] [agent...]"
            echo ""
            echo "停止 CCB 项目或单个 agent。"
            echo ""
            echo "不带 agent 参数: 停止整个项目（所有 agent + ccbd）"
            echo "带 agent 参数:   只停指定 agent（park + 可选 --clear）"
            echo ""
            echo "OPTIONS:"
            echo "  -f, --force     强制停止（仅对全项目停止有效）"
            echo "  --clear         连带清空 agent 对话上下文"
            echo "  --restart       重启面板而非 park（队列续投,不丢任务）"
            echo "  -h, --help       显示帮助"
            echo ""
            echo "EXAMPLES:"
            echo "  ./stop.sh                    # 停止整个项目"
            echo "  ./stop.sh -f                 # 强制停止整个项目"
            echo "  ./stop.sh developer          # 只停 developer"
            echo "  ./stop.sh developer tester   # 同时停多个 agent"
            echo "  ./stop.sh developer --clear  # 停 developer 并清空对话"
            exit 0
            ;;
        *)
            AGENTS+=("$1")
            shift
            ;;
    esac
done

# ── 切换到项目目录 ──
cd "$PROJECT_ROOT"

# ── 前置检查 ──
if ! command -v ccb &> /dev/null; then
    echo -e "${RED}✗ ccb 未安装或不在 PATH 中${NC}" >&2
    exit 1
fi

ccbd_alive() {
    ccb ping ccbd 2>/dev/null | grep -q "pid_alive: True"
}

# ── 模式 A: 停止整个项目 ──
if [[ ${#AGENTS[@]} -eq 0 ]]; then
    if ! ccbd_alive; then
        echo -e "${YELLOW}⚠ ccbd 未运行${NC}"
        echo "  项目: $PROJECT_ROOT"
        # 兜底: 直接查找残留进程
        PIDS=$(ps aux \
            | grep -E 'ccbd/(keeper_main|main)\.py' \
            | grep -F -- "--project ${PROJECT_ROOT}" \
            | grep -v grep \
            | awk '{print $2}' \
            | sort -u)
        if [[ -n "$PIDS" ]]; then
            echo -e "${YELLOW}▶ 发现残留进程，正在清理...${NC}"
            for pid in $PIDS; do
                kill -9 "$pid" 2>/dev/null || true
            done
            echo -e "${GREEN}✓ 残留进程已清理${NC}"
        else
            echo "  无残留进程"
        fi
        exit 0
    fi

    echo -e "${YELLOW}▶ 正在停止整个项目...${NC}"
    echo "  项目: $PROJECT_ROOT"

    if [[ "$FORCE" == true ]]; then
        ccb kill -f
        echo -e "${GREEN}✓ 项目已强制停止（所有 agent + ccbd）${NC}"
    else
        ccb kill
        echo -e "${GREEN}✓ 项目已停止（所有 agent + ccbd）${NC}"
    fi
    exit 0
fi

# ── 模式 B: 停止单个/多个 agent ──
if ! ccbd_alive; then
    echo -e "${RED}✗ ccbd 未运行，无法操作单个 agent${NC}" >&2
    echo "  先执行 ./start.sh 启动项目,或 ./stop.sh 全停"
    exit 1
fi

if [[ "$RESTART" == true ]]; then
    # 重启面板: ccb restart <agent> —— 队列会续投,不等于"停"
    echo -e "${YELLOW}▶ 正在重启面板（队列续投）...${NC}"
    for agent in "${AGENTS[@]}"; do
        echo "  → $agent"
        ccb restart "$agent"
    done
    echo -e "${GREEN}✓ 面板已重启${NC}"
    if [[ "$CLEAR" == true ]]; then
        for agent in "${AGENTS[@]}"; do
            ccb clear "$agent"
        done
        echo -e "${GREEN}✓ 对话上下文已清空${NC}"
    fi
    echo ""
    echo -e "${YELLOW}⚠ 注意: restart 只换了面板进程，队列/任务会续投，不等于停掉任务。${NC}"
    echo -e "${YELLOW}   想真正停止派发请用: ./stop.sh <agent> (不带 --restart)${NC}"
    exit 0
fi

# 单 agent park: 停止派发,保留面板和队列
echo -e "${YELLOW}▶ 正在停止 agent 派发（park）...${NC}"
for agent in "${AGENTS[@]}"; do
    echo "  → $agent"
    ccb agent park "$agent"
done
echo -e "${GREEN}✓ 已停止派发${NC}"
echo "  面板保留，队列中的任务不会丢失。"

if [[ "$CLEAR" == true ]]; then
    for agent in "${AGENTS[@]}"; do
        ccb clear "$agent"
    done
    echo -e "${GREEN}✓ 对话上下文已清空${NC}"
fi

echo ""
echo -e "  恢复派发: ${GREEN}./start.sh ${AGENTS[*]}${NC}"
echo -e "  查看状态: ${GREEN}ccb queue ${AGENTS[0]}${NC}"
