#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load env
GITHUB_WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-}"
GITHUB_SMEE_URL="${GITHUB_SMEE_URL:-}"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi
WEBHOOK_PORT="${WEBHOOK_PORT:-3001}"

# Kill old processes
fuser -k "${WEBHOOK_PORT}/tcp" 2>/dev/null || true
pkill -f "smee -u" 2>/dev/null || true
sleep 0.5

echo "=== PR Comment Logger ==="
echo "Port: ${WEBHOOK_PORT}"
echo ""

# Start server
cd "$SCRIPT_DIR" && node server.js &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

sleep 1

# Smee proxy
if [ -n "$GITHUB_SMEE_URL" ] && [ -n "$GITHUB_WEBHOOK_SECRET" ]; then
  echo "Starting smee: ${GITHUB_SMEE_URL} -> http://localhost:${WEBHOOK_PORT}/github-webhook"
  smee -u "$GITHUB_SMEE_URL" -t "http://localhost:${WEBHOOK_PORT}/github-webhook" &
  SMEE_PID=$!
fi

echo ""
echo "=== Ready ==="
echo ""

wait $SERVER_PID ${SMEE_PID:-}
