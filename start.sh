#!/usr/bin/env bash
# 启动 claude-sessions 网页界面（默认 http://127.0.0.1:9999）
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-9999}"

if ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q .; then
  echo "端口 $PORT 已在监听——服务可能已经在运行： http://127.0.0.1:$PORT"
  exit 0
fi

exec ./claude-sessions web --port "$PORT"
