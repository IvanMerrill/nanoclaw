#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /Users/ivan/nanoclaw-sandbox-5296/nanoclaw.pid)

set -euo pipefail

cd "/Users/ivan/nanoclaw-sandbox-5296"

# Stop existing instance if running
if [ -f "/Users/ivan/nanoclaw-sandbox-5296/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/Users/ivan/nanoclaw-sandbox-5296/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/usr/bin/node" "/Users/ivan/nanoclaw-sandbox-5296/dist/index.js" \
  >> "/Users/ivan/nanoclaw-sandbox-5296/logs/nanoclaw.log" \
  2>> "/Users/ivan/nanoclaw-sandbox-5296/logs/nanoclaw.error.log" &

echo $! > "/Users/ivan/nanoclaw-sandbox-5296/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /Users/ivan/nanoclaw-sandbox-5296/logs/nanoclaw.log"
