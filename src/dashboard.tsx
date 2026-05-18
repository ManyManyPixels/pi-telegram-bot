/**
 * pi Telegram Bot Dashboard
 *
 * Full-screen terminal dashboard using terminui.
 *   pnpm dashboard          – launch interactive dashboard
 *   pnpm dashboard status   – one-shot CLI status
 *   pnpm dashboard start    – start bot in background
 *   pnpm dashboard stop     – stop bot
 *   pnpm dashboard restart  – restart bot
 */
/** @jsxRuntime automatic */
/** @jsxImportSource terminui */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import readline from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTerminal, terminalResize, createSize, Color, fillConstraint, lengthConstraint } from 'terminui';
import {
  Column,
  Row,
  Panel,
  Text,
  Label,
  terminalDrawJsx,
} from 'terminui/jsx';

import { createAnsiBackend } from './ansi-backend.js';

// ── Paths ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const PID_FILE = '/tmp/pi-telegram-bot.pid';
const LOG_FILE = '/tmp/pi-telegram-bot.log';
const SERVICE_NAME = 'pi-telegram-bot';

// ── State helpers ─────────────────────────────────────────────────────

function isRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  const pid = readFileSync(PID_FILE, 'utf8').split('\n')[0]?.trim();
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function getPid(): string {
  if (!existsSync(PID_FILE)) return '—';
  const pid = readFileSync(PID_FILE, 'utf8').split('\n')[0]?.trim();
  return pid || '—';
}

function getUptime(): string {
  if (!isRunning()) return '—';
  try {
    const pid = getPid();
    const out = execSync(`ps -o etimes= -p ${pid} 2>/dev/null || echo 0`, {
      encoding: 'utf8',
    }).trim();
    const sec = Number(out) || 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  } catch {
    return '—';
  }
}

function isAutostartEnabled(): boolean {
  try {
    execSync(`systemctl is-enabled ${SERVICE_NAME}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getLogTail(lines: number): string[] {
  if (!existsSync(LOG_FILE)) return [];
  try {
    const content = readFileSync(LOG_FILE, 'utf8');
    const all = content.split('\n').filter(Boolean);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

// ── Actions ───────────────────────────────────────────────────────────

function actionStart(): void {
  if (isRunning()) return;
  try {
    execSync(`bash "${ROOT}/dashboard.sh" start`, {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env },
    });
  } catch {
    // ignore
  }
}

function actionStop(): void {
  if (!isRunning()) return;
  try {
    execSync(`bash "${ROOT}/dashboard.sh" stop`, {
      cwd: ROOT,
      stdio: 'ignore',
    });
  } catch {
    // ignore
  }
}

function actionRestart(): void {
  actionStop();
  setTimeout(() => actionStart(), 500);
}

function actionToggleAutostart(): void {
  if (isAutostartEnabled()) {
    try {
      execSync(`systemctl disable ${SERVICE_NAME}`, { stdio: 'ignore' });
      execSync('systemctl daemon-reload', { stdio: 'ignore' });
    } catch { /* ignore */ }
  } else {
    const serviceFile = `/etc/systemd/system/${SERVICE_NAME}.service`;
    const unit = `[Unit]
Description=Telegram pi Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=${process.env.USER ?? 'root'}
WorkingDirectory=${ROOT}
EnvironmentFile=${ROOT}/.env
ExecStart=${ROOT}/dashboard.sh start
ExecStop=${ROOT}/dashboard.sh stop
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
    try {
      execSync(`tee ${serviceFile} > /dev/null`, { input: unit, stdio: 'pipe' });
      execSync('systemctl daemon-reload', { stdio: 'ignore' });
      execSync(`systemctl enable ${SERVICE_NAME}`, { stdio: 'ignore' });
    } catch { /* ignore */ }
  }
}

// ── Terminal UI ───────────────────────────────────────────────────────

async function runDashboard(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.log('This dashboard requires an interactive terminal.');
    process.exit(1);
  }

  const backend = createAnsiBackend();
  const terminal = createTerminal(backend);

  let shuttingDown = false;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const cleanup = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (renderTimer) clearTimeout(renderTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    stdout.off('resize', onResize);
    stdin.off('keypress', onKeypress);
    try { stdin.setRawMode(false); } catch { /* ignore */ }
    stdout.write('\u001B[0m\u001B[?25h');
    stdout.write('\u001B[?1049l');
    stdout.write('\u001B[2J\u001B[3J\u001B[H');
  };

  const requestRender = (): void => {
    if (shuttingDown || renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      renderNow();
    }, 16);
  };

  const renderNow = (): void => {
    if (shuttingDown) return;

    const running = isRunning();
    const pid = getPid();
    const uptime = getUptime();
    const auto = isAutostartEnabled();

    const logLines = getLogTail(30);
    const statusColor = running ? Color.LightGreen : Color.LightRed;
    const statusIcon = running ? '●' : '○';
    const statusText = running ? 'RUNNING' : 'STOPPED';

    terminalDrawJsx(terminal, (frame) => {
      const frameW = frame.area.width;
      return (
        <Column constraints={[lengthConstraint(3), fillConstraint(1), lengthConstraint(1)]} gap={0}>
          {/* ── Header ─────────────────────────────────────────── */}
          <Panel title="pi Telegram Bot Dashboard" p={1} fg={Color.LightCyan}>
            <Row constraints={[fillConstraint(1), lengthConstraint(20)]}>
              <Label text=" " />
              <Label
                text={`${statusIcon} ${statusText}`}
                fg={statusColor}
                bold
                align="right"
              />
            </Row>
          </Panel>

          {/* ── Body ──────────────────────────────────────────── */}
          <Column constraints={[lengthConstraint(3), lengthConstraint(3), fillConstraint(1)]} gap={0}>
            {/* Status row */}
            <Panel title="Status" p={1}>
              <Row constraints={[fillConstraint(1), fillConstraint(1), fillConstraint(1)]} gap={2}>
                <Label
                  text={`PID:    ${pid}`}
                  fg={Color.LightCyan}
                />
                <Label
                  text={`Uptime: ${uptime}`}
                  fg={Color.LightYellow}
                />
                <Label
                  text={`Autostart: ${auto ? '[X] ON' : '[ ] OFF'}`}
                  fg={auto ? Color.LightGreen : Color.Gray}
                />
              </Row>
            </Panel>

            {/* Controls */}
            <Panel title="Controls" p={1}>
              <Row constraints={[fillConstraint(1), fillConstraint(1), fillConstraint(1), fillConstraint(1), fillConstraint(1)]} gap={1}>
                <Label
                  text="[S] Start"
                  fg={Color.LightGreen}
                  bold
                />
                <Label
                  text="[K] Kill"
                  fg={Color.LightRed}
                  bold
                />
                <Label
                  text="[R] Restart"
                  fg={Color.LightYellow}
                  bold
                />
                <Label
                  text={auto ? '[A] Autostart ON' : '[A] Autostart OFF'}
                  fg={auto ? Color.LightGreen : Color.Gray}
                  bold
                />
                <Label
                  text="[Q] Quit"
                  fg={Color.Gray}
                  bold
                />
              </Row>
            </Panel>

            {/* Log viewer */}
            <Panel title={`Log  (${LOG_FILE})`} p={0} fg={Color.LightCyan}>
              <Text
                text={logLines.length > 0 ? logLines.join('\n') : '(no log entries yet)'}
                wrap={{ trim: true }}
                fg={Color.Gray}
              />
            </Panel>
          </Column>

          {/* ── Status bar ─────────────────────────────────────── */}
          <Panel p={0}>
            <Row constraints={[fillConstraint(1), lengthConstraint(20)]}>
              <Label
                text={` ${statusIcon} ${statusText}  |  S:start  K:kill  R:restart  A:autostart  Q:quit`}
                fg={Color.Gray}
              />
              <Label
                text={`${frameW}x${frame.area.height}`}
                fg={Color.DarkGray}
                align="right"
              />
            </Row>
          </Panel>
        </Column>
      );
    });
  };

  const onResize = (): void => {
    terminalResize(terminal, createSize(backend.size().width, backend.size().height));
    renderNow();
  };

  const onKeypress = (
    _str: string | undefined,
    key: readline.Key | undefined,
  ): void => {
    if (shuttingDown) return;

    if (key?.ctrl && key.name === 'c') {
      cleanup();
      process.exit(0);
      return;
    }

    switch (key?.name ?? _str?.toLowerCase()) {
      case 's':
        actionStart();
        break;
      case 'k':
        actionStop();
        break;
      case 'r':
        actionRestart();
        break;
      case 'a':
        actionToggleAutostart();
        break;
      case 'q':
      case 'escape':
        cleanup();
        process.exit(0);
        return;
    }

    requestRender();
  };

  // ── Setup terminal ────────────────────────────────────────────
  stdout.write('\u001B[?1049h'); // alternate screen
  stdout.write('\u001B[2J\u001B[3J\u001B[H'); // clear
  stdout.write('\u001B[?25l'); // hide cursor

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  stdin.on('keypress', onKeypress);
  stdout.on('resize', onResize);
  heartbeatTimer = setInterval(() => requestRender(), 1_000);
  onResize();

  process.on('exit', () => cleanup());
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
}

// ── CLI mode ──────────────────────────────────────────────────────────

function cliStatus(): void {
  const running = isRunning();
  const icon = running ? '●' : '○';
  const label = running ? 'RUNNING' : 'STOPPED';
  console.log(`${icon} ${label}  PID=${getPid()}  Uptime=${getUptime()}`);
  console.log(`Autostart: ${isAutostartEnabled() ? 'ON' : 'OFF'}`);
}

// ── Entry point ───────────────────────────────────────────────────────

const cmd = process.argv[2];

switch (cmd) {
  case 'status':
    cliStatus();
    break;
  case 'start':
    actionStart();
    console.log('Bot started.');
    break;
  case 'stop':
    actionStop();
    console.log('Bot stopped.');
    break;
  case 'restart':
    actionStop();
    setTimeout(() => { actionStart(); console.log('Bot restarted.'); }, 500);
    break;
  default:
    runDashboard();
}
