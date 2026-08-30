#!/usr/bin/env bash
#
# pi config — 新机器一键初始化脚本
#
# 作用：
#   1. 把本仓库的配置就位（若本仓库不在 ~/.pi/agent，则复制过去）
#   2. 安装 npm 扩展依赖
#   3. 可选安装 browser 扩展所需的 Chromium
#   4. 检查并提示 API key 配置方式
#
# 用法（在克隆下来的仓库里运行）：
#   cd ~/.pi/agent && ./install.sh
#   或者指定目标目录：  PI_DIR=~/.pi ./install.sh
#
set -euo pipefail

# 本仓库所在目录（脚本位置）
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# pi 配置目标目录（默认 ~/.pi/agent）
PI_DIR="${PI_DIR:-$HOME/.pi/agent}"

echo "==> pi config bootstrap"
echo "    source : $REPO_DIR"
echo "    target : $PI_DIR"
echo ""

# ---------- 1) 配置就位 ----------
# 若仓库位置 == pi 配置目录，则直接使用；否则复制可移植配置过去。
if [ "$REPO_DIR" != "$PI_DIR" ]; then
  echo "==> 复制配置到 $PI_DIR"
  mkdir -p "$PI_DIR"
  for item in settings.json models-store.json agents extensions skills npm; do
    if [ -e "$REPO_DIR/$item" ]; then
      # 用 -R 复制目录；cp 会跳过已存在且内容相同的（不覆盖本地 auth.json / sessions）
      cp -R "$REPO_DIR/$item" "$PI_DIR/"
    fi
  done
else
  echo "==> 仓库即配置目录（$PI_DIR），无需复制"
fi
echo ""

# ---------- 2) npm 扩展依赖 ----------
echo "==> 安装扩展依赖 (npm)"
if [ -f "$PI_DIR/npm/package.json" ]; then
  echo "    - npm/ (子代理、网页访问)"
  (cd "$PI_DIR/npm" && npm install --silent) \
    || echo "    !! npm/ 依赖安装失败，可稍后手动重试"
fi

if [ -f "$PI_DIR/extensions/browser/package.json" ]; then
  echo "    - extensions/browser"
  (cd "$PI_DIR/extensions/browser" && npm install --silent) \
    || echo "    !! browser 依赖安装失败，可稍后手动重试"
  if command -v npx >/dev/null 2>&1; then
    echo "    - 安装 Chromium (browser 扩展用，约 150MB，可跳过)"
    (cd "$PI_DIR/extensions/browser" && npx playwright install chromium) \
      || echo "    !! Chromium 安装跳过/失败（用到 browser 扩展时再装）"
  fi
fi
echo ""

# ---------- 3) API key 检查 ----------
echo "==> 检查 API key"
if [ -f "$PI_DIR/auth.json" ]; then
  echo "    ✅ 检测到 auth.json（key 只在本机，不入仓库）"
elif [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  echo "    ✅ 环境变量 DEEPSEEK_API_KEY 已设置"
else
  echo "    !! 未检测到 API key，请任选一种方式配置："
  echo "       1) export DEEPSEEK_API_KEY=sk-...    # 加入 ~/.zshrc / ~/.bashrc"
  echo "       2) 运行 pi 后执行  /login deepseek   # key 写入本地 auth.json"
  echo ""
  echo "       对应 provider 的环境变量名见 pi 文档 providers.md。"
fi
echo ""

echo "==> 完成 ✅  运行 'pi' 开始使用。"
