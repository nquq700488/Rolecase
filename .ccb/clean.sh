#!/usr/bin/env bash
set -euo pipefail

# 自动推断项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 解析参数
DRY_RUN=false
FORCE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            echo "Usage: $(basename "$0") [-f|--force] [-n|--dry-run]"
            echo "  -f, --force   强制停止 CCB 守护进程后清理"
            echo "  -n, --dry-run 只列出将被删除的内容，不实际删除"
            exit 0
            ;;
        -f|--force)
            FORCE=true
            shift
            ;;
        -n|--dry-run)
            DRY_RUN=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use -h for help"
            exit 1
            ;;
    esac
done

# 需要保留的文件和目录（白名单）
declare -A KEEP=(
    ["ccb.config"]=1
    ["ccb-compact.config"]=1
    ["ccb-multi.config"]=1
    ["ccb_memory.md"]=1
    ["README.md"]=1
    ["restart.sh"]=1
    ["start.sh"]=1
    ["stop.sh"]=1
    ["clean.sh"]=1
)

echo -e "${YELLOW}▶ 清理 .ccb 运行时文件...${NC}"
echo "  项目: $PROJECT_ROOT"
echo ""

# ── 先停止 CCB 守护进程，否则删除后文件会被恢复 ──
if command -v ccb &> /dev/null; then
    if ccb --project "$PROJECT_ROOT" ping ccbd 2>/dev/null | grep -q "pid_alive: True"; then
        echo -e "${YELLOW}⚠ 检测到 CCB 守护进程仍在运行，先停止...${NC}"
        cd "$PROJECT_ROOT"
        if [[ "$FORCE" == true ]]; then
            ccb --project "$PROJECT_ROOT" kill -f
        else
            ccb --project "$PROJECT_ROOT" kill
        fi
        echo -e "${GREEN}✓ CCB 守护进程已停止${NC}"
        sleep 1
        echo ""
    fi
else
    echo -e "${YELLOW}⚠ ccb 命令未找到，跳过守护进程检查${NC}"
    echo "   （若守护进程仍在运行，删除的文件可能会被自动恢复）"
    echo ""
fi

# 检查哪些将被删除
shopt -s dotglob nullglob
TO_DELETE=()
TO_KEEP=()
for item in "$SCRIPT_DIR"/*; do
    name="$(basename "$item")"

    # 跳过 . 和 ..
    [[ "$name" == "." || "$name" == ".." ]] && continue

    if [[ -n "${KEEP[$name]:-}" ]]; then
        TO_KEEP+=("$item")
    else
        TO_DELETE+=("$item")
    fi
done
shopt -u dotglob nullglob

# 列出将被删除的内容
if [[ ${#TO_DELETE[@]} -eq 0 ]]; then
    echo -e "${GREEN}✓ 没有需要清理的运行时文件${NC}"
    exit 0
fi

echo -e "${YELLOW}将被删除：${NC}"
for item in "${TO_DELETE[@]}"; do
    size=$(du -sh "$item" 2>/dev/null | cut -f1 || echo "-")
    echo "  $size  $item"
done
echo ""

total_size=$(du -sh "$SCRIPT_DIR" 2>/dev/null | cut -f1 || echo "-")
echo "当前目录总大小: $total_size"

if [[ "$DRY_RUN" == true ]]; then
    echo -e "${YELLOW}[dry-run] 未实际删除${NC}"
    exit 0
fi

# 删除
echo ""
echo -e "${YELLOW}正在删除...${NC}"
for item in "${TO_DELETE[@]}"; do
    rm -rf "$item"
    echo "  ✓ $item"
done

remaining_size=$(du -sh "$SCRIPT_DIR" 2>/dev/null | cut -f1 || echo "-")
echo ""
echo -e "${GREEN}✓ 清理完成${NC}"
echo "  剩余大小: $remaining_size"
