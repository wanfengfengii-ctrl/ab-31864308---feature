#!/bin/sh
# verify.sh — 验收脚本：算法/解析层自动测试 +（可选）对已启动的静态服务做健康检查。
# 由 docker compose 的 verify 服务执行；也可在本机直接运行：sh tests/verify.sh
set -e

cd "$(dirname "$0")/.."

echo "== [1/2] 运行算法与解析验收测试（精确有理数 / 树度量 / 重建 / 路径核算） =="
node --test tests/*.test.mjs

if [ -n "$WEB_URL" ]; then
  echo "== [2/2] 检查静态服务 $WEB_URL =="
  # node:alpine 自带 busybox wget
  health="$(wget -qO- "$WEB_URL/healthz" || true)"
  if [ "$health" != "ok" ]; then
    echo "健康检查失败：$WEB_URL/healthz 返回 '$health'" >&2
    exit 1
  fi
  echo "健康检查通过：/healthz -> ok"

  index="$(wget -qO- "$WEB_URL/" || true)"
  case "$index" in
    *"无源光纤监测网"*"隐藏拓扑重建工作台"*) echo "首页内容检查通过。" ;;
    *) echo "首页内容检查失败。" >&2; exit 1 ;;
  esac
  for asset in js/app.js js/metric.js js/fraction.js js/treeview.js css/styles.css; do
    code="$(wget -qS -O /dev/null "$WEB_URL/$asset" 2>&1 | awk '/HTTP\//{print $2; exit}')"
    if [ "$code" != "200" ]; then
      echo "静态资源 $asset 返回 $code" >&2
      exit 1
    fi
  done
  echo "全部静态资源可访问。"
else
  echo "== [2/2] 未设置 WEB_URL，跳过在线健康检查 =="
fi

echo ""
echo "✔ 验收全部通过。"
