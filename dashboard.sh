#!/bin/bash
# ── Telegram pi Bot Dashboard ─────────────────────────────────────────
# Full-screen terminal dashboard with live status + log viewer.
#
#   ./dashboard.sh           – launch dashboard
#   ./dashboard.sh status    – one-shot CLI status
#   ./dashboard.sh start     – start in background (CLI)
#   ./dashboard.sh stop      – stop (CLI)
#   ./dashboard.sh restart   – restart (CLI)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="/tmp/pi-telegram-bot.pid"
LOG_FILE="/tmp/pi-telegram-bot.log"
SERVICE_NAME="pi-telegram-bot"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# ── State helpers ─────────────────────────────────────────────────────

running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid; pid=$(head -n1 "$PID_FILE" 2>/dev/null || true)
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

pid_str() {
  if running; then head -n1 "$PID_FILE"; else echo "—"; fi
}

uptime_str() {
  if ! running; then echo "—"; return; fi
  local pid; pid=$(head -n1 "$PID_FILE")
  local e; e=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ') || true
  if [[ -z "$e" ]]; then echo "—"; return; fi
  local h=$((e / 3600)) m=$(((e % 3600) / 60)) s=$((e % 60))
  printf "%dh%02dm%02ds" "$h" "$m" "$s"
}

autostart_enabled() {
  [[ -f "$SERVICE_FILE" ]] && systemctl is-enabled "$SERVICE_NAME" &>/dev/null
}

# ── Actions ───────────────────────────────────────────────────────────

action_start() {
  if running; then return; fi
  cd "$SCRIPT_DIR"
  set -a; source .env 2>/dev/null; set +a

  curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN:-}/setWebhook" \
    -F "url=${SMEE_URL:-}" -F "secret_token=${WEBHOOK_SECRET:-}" > /dev/null 2>&1 || true

  nohup node server.js >> "$LOG_FILE" 2>&1 & local sp=$!
  echo "$sp" > "$PID_FILE"
  nohup smee -u "${SMEE_URL:-}" -t "http://localhost:${WEBHOOK_PORT:-3001}/webhook" >> "$LOG_FILE" 2>&1 & local smp=$!
  echo "$smp" >> "$PID_FILE"
  echo "[$(date '+%H:%M:%S')] Bot started (server=$sp smee=$smp)" >> "$LOG_FILE"
}

action_stop() {
  if ! running; then return; fi
  while read -r pid; do
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || continue
    kill "$pid" 2>/dev/null || true
    pkill -P "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  sleep 0.5
  while read -r pid; do
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
  echo "[$(date '+%H:%M:%S')] Bot stopped" >> "$LOG_FILE"
}

action_toggle_autostart() {
  if autostart_enabled; then
    systemctl disable "$SERVICE_NAME" &>/dev/null || true
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload &>/dev/null || true
    echo "[$(date '+%H:%M:%S')] Autostart DISABLED" >> "$LOG_FILE"
  else
    cat > "$SERVICE_FILE" << SERVICE_EOF
[Unit]
Description=Telegram pi Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=$(whoami)
WorkingDirectory=$SCRIPT_DIR
EnvironmentFile=$SCRIPT_DIR/.env
ExecStart=$SCRIPT_DIR/dashboard.sh start
ExecStop=$SCRIPT_DIR/dashboard.sh stop
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE_EOF
    systemctl daemon-reload &>/dev/null || true
    systemctl enable "$SERVICE_NAME" &>/dev/null || true
    echo "[$(date '+%H:%M:%S')] Autostart ENABLED" >> "$LOG_FILE"
  fi
}

# ── TUI rendering ────────────────────────────────────────────────────

RED=$(tput setaf 1 2>/dev/null || echo '')
GREEN=$(tput setaf 2 2>/dev/null || echo '')
YELLOW=$(tput setaf 3 2>/dev/null || echo '')
CYAN=$(tput setaf 6 2>/dev/null || echo '')
BOLD=$(tput bold 2>/dev/null || echo '')
DIM=$(tput dim 2>/dev/null || echo '')
RESET=$(tput sgr0 2>/dev/null || echo '')
REVERSE=$(tput rev 2>/dev/null || echo '')

hline() {
  local w=${1:-80} c=${2:-"─"}
  local i
  for ((i=0; i<w; i++)); do printf '%s' "$c"; done
}

draw() {
  local running_col pid uptime auto auto_col

  if running; then
    running_col="$GREEN"
    pid="$(pid_str)" uptime="$(uptime_str)"
  else
    running_col="$RED"
    pid="—" uptime="—"
  fi

  if autostart_enabled; then
    auto="[X] ON" auto_col="$GREEN"
  else
    auto="[ ] OFF" auto_col="$DIM"
  fi

  local cols lines
  cols=$(tput cols 2>/dev/null || echo 80)
  lines=$(tput lines 2>/dev/null || echo 24)

  # ── Layout ──────────────────────────────────────────────────────
  local header_h=2 status_h=5 ctrl_h=2 log_hdr_h=3
  local log_h=$(( lines - header_h - status_h - ctrl_h - log_hdr_h ))
  [[ $log_h -lt 3 ]] && log_h=3

  # Clear + home
  tput clear 2>/dev/null

  # ── Header ──────────────────────────────────────────────────────
  echo -n "${REVERSE}${BOLD}"
  printf "  pi Telegram Bot Dashboard"
  # pad to fill the rest of the line
  local pad1=$(( cols - 30 ))
  [[ $pad1 -gt 0 ]] && printf '%*s' "$pad1" ''
  echo "${RESET}"
  echo ""

  # ── Status ──────────────────────────────────────────────────────
  echo "${BOLD}Status${RESET}"
  echo -n "${running_col}${BOLD}"
  if running; then
    echo -n "  ●  RUNNING"
  else
    echo -n "  ○  STOPPED"
  fi
  echo -n "${RESET}    "
  echo -n "PID: ${CYAN}${pid}${RESET}    "
  echo -n "Uptime: ${YELLOW}${uptime}${RESET}    "
  echo "Boot: ${auto_col}${auto}${RESET}"
  echo -n "${DIM}"; hline "$cols"; echo "${RESET}"

  # ── Controls ────────────────────────────────────────────────────
  echo -n "${BOLD}"
  echo -n "  [${GREEN}S${RESET}${BOLD}]tart   "
  echo -n "[${RED}K${RESET}${BOLD}]ill    "
  echo -n "[${YELLOW}R${RESET}${BOLD}]estart  "
  echo -n "[${CYAN}A${RESET}${BOLD}]utostart "
  echo "[${DIM}Q${RESET}${BOLD}]uit${RESET}"
  echo -n "${DIM}"; hline "$cols"; echo "${RESET}"

  # ── Log header ──────────────────────────────────────────────────
  echo "${BOLD}Log  (${LOG_FILE})${RESET}"
  echo -n "${DIM}"; hline "$cols"; echo "${RESET}"

  # ── Log content ─────────────────────────────────────────────────
  if [[ -f "$LOG_FILE" ]]; then
    tail -n "$log_h" "$LOG_FILE" 2>/dev/null
    # Pad if log is shorter than panel
    local lc
    lc=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
    local pad2=$(( log_h - lc ))
    if [[ $pad2 -gt 0 ]]; then
      for ((i=0; i<pad2; i++)); do echo ""; done
    fi
  else
    for ((i=0; i<log_h; i++)); do echo ""; done
  fi
}

# ── Main TUI loop ────────────────────────────────────────────────────

tui() {
  # Save terminal state
  local saved_stty
  saved_stty=$(stty -g)
  tput civis   # hide cursor
  tput smcup   # save screen + switch to alt buffer

  # Cleanup on exit
  cleanup() {
    tput rmcup   # restore screen
    tput cnorm   # show cursor
    stty "$saved_stty"
    exit 0
  }
  trap cleanup EXIT INT TERM

  # Disable input buffering + echo
  stty -echo -icanon time 0 min 0

  local last_draw=0
  draw

  while true; do
    local now
    now=$(date +%s)

    # Re-draw every second
    if (( now - last_draw >= 1 )); then
      draw
      last_draw=$now
    fi

    # Read key (non-blocking)
    local key
    key=$(dd bs=1 count=1 2>/dev/null) || true

    case "$key" in
      s|S) action_start ;;
      k|K) action_stop ;;
      r|R) action_stop; sleep 0.5; action_start ;;
      a|A) action_toggle_autostart ;;
      q|Q) break ;;
      $'\x03') break ;;  # Ctrl-C
    esac

    if [[ -n "$key" ]]; then
      draw
      last_draw=$now
    fi

    sleep 0.1
  done
}

# ── CLI mode ──────────────────────────────────────────────────────────

cli_status() {
  if running; then
    printf "%s● RUNNING%s  PID=%s  Uptime=%s\n" "$GREEN$BOLD" "$RESET" "$(pid_str)" "$(uptime_str)"
  else
    printf "%s○ STOPPED%s\n" "$RED$BOLD" "$RESET"
  fi
  if autostart_enabled; then echo "Autostart: ON"; else echo "Autostart: OFF"; fi
}

# ── Entry point ───────────────────────────────────────────────────────

case "${1:-}" in
  status)   cli_status ;;
  start)    action_start ;;
  stop)     action_stop ;;
  restart)  action_stop; sleep 0.5; action_start ;;
  *)        tui ;;
esac
