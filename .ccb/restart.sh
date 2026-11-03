#!/usr/bin/env bash
set -euo pipefail

# 自动推断项目根目录（脚本位于 .ccb/restart.sh，项目根是其父目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 检查 ccb 是否已安装
if ! command -v ccb &> /dev/null; then
    echo -e "${RED}✗ ccb 未安装或不在 PATH 中${NC}" >&2
    exit 1
fi

# 检查 ccb 是否已在运行（需确认进程实际存活，而非仅项目已注册）
if ccb --project "$PROJECT_ROOT" ping ccbd 2>/dev/null | grep -q "pid_alive: True"; then
    echo -e "${YELLOW}↻ ccb 已在运行，执行重启...${NC}"
    echo "  项目: $PROJECT_ROOT"
else
    echo -e "${YELLOW}▶ ccb 未运行，直接启动...${NC}"
    echo "  项目: $PROJECT_ROOT"
fi

# 解析参数（与 stop.sh/start.sh 保持一致）
STOP_ARGS=()
START_ARGS=()
FORCE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -f|--force)
            FORCE=true
            STOP_ARGS+=("-f")
            shift
            ;;
        -s|--safe)
            START_ARGS+=("-s")
            shift
            ;;
        -n|--new)
            START_ARGS+=("-n")
            shift
            ;;
        -h|--help)
            echo "Usage: $(basename "$0") [-f] [-s] [-n]"
            echo "  -f, --force  强制清理后重启"
            echo "  -s, --safe   安全模式启动"
            echo "  -n, --new    重建后启动"
            exit 0
            ;;
        *)
            START_ARGS+=("$1")
            shift
            ;;
    esac
done

# 先停止（无论是否已在运行，都会执行 stop 以确保干净的重启状态）
"$SCRIPT_DIR/stop.sh" "${STOP_ARGS[@]}"

# 再启动
exec "$SCRIPT_DIR/start.sh" "${START_ARGS[@]}"