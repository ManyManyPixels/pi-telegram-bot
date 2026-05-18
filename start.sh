#!/bin/bash
# Start the Telegram pi bot with smee webhook proxy
set -e

# ── Kill previously launched processes ────────────────────────────────
pkill -f "node server.js" 2>/dev/null || true
pkill -f "smee -u" 2>/dev/null || true
sleep 0.5

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a
source "$SCRIPT_DIR/.env"
set +a

echo "=== Telegram pi Bot ==="
echo "Model:    ${PI_PROVIDER}/${PI_MODEL}"
echo "Port:     ${WEBHOOK_PORT}"
echo "Smee:     ${SMEE_URL}"
echo ""

# ── Register webhook with Telegram ────────────────────────────────────
echo "Setting Telegram webhook..."
WEBHOOK_RESP=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -F "url=${SMEE_URL}" \
  -F "secret_token=${WEBHOOK_SECRET}")
echo "Telegram: $WEBHOOK_RESP"
echo ""

# ── Start the bot server ──────────────────────────────────────────────
echo "Starting bot server..."
cd "$SCRIPT_DIR" && node server.js &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

sleep 1

# ── Start smee proxy ──────────────────────────────────────────────────
echo "Starting smee (${SMEE_URL} -> http://localhost:${WEBHOOK_PORT}/webhook)..."
smee -u "$SMEE_URL" -t "http://localhost:${WEBHOOK_PORT}/webhook" &
SMEE_PID=$!
echo "Smee PID: $SMEE_PID"

echo ""
echo "=== Ready ==="
echo "Send messages to your bot on Telegram!"
echo "Commands: /reset /id"
echo ""

wait $SERVER_PID $SMEE_PID
