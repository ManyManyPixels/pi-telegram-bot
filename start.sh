#!/bin/bash
# Start the GitHub pi bot with smee webhook proxy
set -e

# ── Kill previously launched processes ────────────────────────────────
pkill -f "node server.js" 2>/dev/null || true
pkill -f "smee -u" 2>/dev/null || true
sleep 0.5

GITHUB_WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-}"
GITHUB_SMEE_URL="${GITHUB_SMEE_URL:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a
source "$SCRIPT_DIR/.env"
set +a

# ── Working directory ─────────────────────────────────────────────────
# Priority: CLI arg > PI_WORK_DIR from .env > SCRIPT_DIR fallback
PI_WORK_DIR="${1:-${PI_WORK_DIR:-$SCRIPT_DIR}}"
PI_WORK_DIR=$(realpath "$PI_WORK_DIR" 2>/dev/null)
if [ $? -ne 0 ] || [ ! -d "$PI_WORK_DIR" ]; then
  echo "Error: working directory does not exist: $PI_WORK_DIR"
  exit 1
fi
export PI_WORK_DIR

echo "=== GitHub pi Bot ==="
echo "Model:    ${PI_PROVIDER}/${PI_MODEL}"
echo "Port:     ${WEBHOOK_PORT}"
echo "WorkDir:  ${PI_WORK_DIR}"
echo ""

# ── Start the bot server ──────────────────────────────────────────────
echo "Starting bot server..."
cd "$SCRIPT_DIR" && node server.js &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

sleep 1

# ── Start smee proxy (GitHub) ─────────────────────────────────────────
if [ -n "$GITHUB_SMEE_URL" ] && [ -n "$GITHUB_WEBHOOK_SECRET" ]; then
  echo "Starting smee (${GITHUB_SMEE_URL} -> http://localhost:${WEBHOOK_PORT}/github-webhook)..."
  smee -u "$GITHUB_SMEE_URL" -t "http://localhost:${WEBHOOK_PORT}/github-webhook" &
  SMEE_GH_PID=$!
  echo "Smee PID (GitHub):  $SMEE_GH_PID"
fi

echo ""
echo "=== Ready ==="
echo ""

wait $SERVER_PID ${SMEE_GH_PID:-}
