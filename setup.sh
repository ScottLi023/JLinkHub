#!/usr/bin/env bash
# ============================================================
# STM32 J-Link 网页调试控制台 — 环境搭建脚本
#
# 用法:
#   ./setup.sh            # 创建虚拟环境并安装依赖
#
# 依赖前置:
#   - Python 3.9+（apt install python3 python3-venv）
#   - SEGGER J-Link 软件（libjlinkarm.so）
#     https://www.segger.com/downloads/jlink/JLink_Linux_V818_arm64.deb
#     下载后: sudo dpkg -i JLink_Linux_V818_arm64.deb
# ============================================================

set -e  # 任何一步失败立即退出

# 切换到脚本所在目录（保证从任意路径执行都正确）
cd "$(dirname "$0")"

VENV_DIR=".venv"

# ---------- 检查 Python 版本 ----------
PYTHON="${PYTHON:-python3}"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
    echo "错误: 未找到 $PYTHON，请先安装 Python 3.9+"
    echo "  Ubuntu/Debian: sudo apt install python3 python3-venv"
    exit 1
fi
PY_VER="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
echo "Python 版本: $PY_VER"
if [ "$(printf '%s\n' "$PY_VER" "3.9" | sort -V | head -1)" != "3.9" ]; then
    echo "错误: 需要 Python 3.9 及以上，当前 $PY_VER"
    exit 1
fi

# ---------- 创建虚拟环境 ----------
if [ ! -d "$VENV_DIR" ]; then
    echo "=== 创建虚拟环境 $VENV_DIR ==="
    "$PYTHON" -m venv "$VENV_DIR"
else
    echo "=== 虚拟环境 $VENV_DIR 已存在，跳过创建 ==="
fi

# ---------- 激活并安装依赖 ----------
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "=== 升级 pip ==="
pip install --upgrade pip

echo "=== 安装依赖 ==="
pip install pylink-square flask websockets
# 国内网络较慢时可用清华镜像:
#   pip install -i https://pypi.tuna.tsinghua.edu.cn/simple pylink-square flask websockets

# ---------- 完成提示 ----------
echo ""
echo "============================================"
echo " 环境搭建完成！"
echo ""
echo " 启动服务:"
echo "   source $VENV_DIR/bin/activate"
echo "   python3 web_console.py"
echo ""
echo " 浏览器打开: http://127.0.0.1:8080"
echo "============================================"
