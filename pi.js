const { spawn } = require("child_process");
const path = require("path");
const { createLogger } = require("./utils/logger");

const log = createLogger("pi");

const PROVIDER = process.env.PI_PROVIDER || "deepseek";
const MODEL = process.env.PI_MODEL || "deepseek-v4-pro";
const WORK_DIR = process.env.PI_WORK_DIR || __dirname;
const PI_TIMEOUT_MS = parseInt(process.env.PI_TIMEOUT_MS || "300000", 10); // 5 min

/**
 * Spawn a pi RPC process, send a prompt, and collect the full text response.
 *
 * @param {string} sessionPath - Full path to the session .jsonl file
 * @param {string} prompt      - User prompt to send
 * @param {object} [opts]      - Optional overrides
 * @param {string} [opts.workDir]    - Override working directory
 * @param {number} [opts.timeoutMs]  - Override timeout
 */
function runPiTurn(sessionPath, prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const workDir = opts.workDir || WORK_DIR;
    const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : PI_TIMEOUT_MS;

    const args = [
      "--mode", "rpc",
      "--provider", PROVIDER,
      "--model", MODEL,
      "--session", sessionPath,
    ];

    const sessionLabel = path.basename(sessionPath, ".jsonl");
    const sessionShort = sessionLabel.slice(0, 20);
    log.info({ session: sessionShort, file: sessionPath }, "starting pi turn");

    const turnStart = Date.now();
    const pi = spawn("pi", args, {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let responseText = "";

    let timeout;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        log.warn({ session: sessionShort, timeoutMs }, "timeout, killing pi");
        pi.kill("SIGTERM");
        setTimeout(() => {
          try { pi.kill("SIGKILL"); } catch {}
        }, 2000);
      }, timeoutMs);
    }

    pi.stdout.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_update") {
            const d = event.assistantMessageEvent;
            if (d?.type === "text_delta") {
              responseText += d.delta;
            }
          }
          if (event.type === "agent_end") {
            const elapsed = Date.now() - turnStart;
            log.info(
              { session: sessionShort, chars: responseText.length, elapsed },
              "agent ended"
            );
            pi.stdin.end();
          }
        } catch {
          // skip non-JSON lines
        }
      }
    });

    pi.stderr.on("data", (d) => {
      log.trace({ session: sessionShort, stderr: d.toString().trim() }, "pi stderr");
    });

    pi.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      const level = code === 0 ? "info" : "warn";
      const elapsed = Date.now() - turnStart;
      log[level]({ session: sessionShort, exitCode: code, elapsed }, "pi exited");
      resolve(responseText);
    });

    pi.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      log.error({ session: sessionShort, err }, "pi spawn error");
      reject(err);
    });

    // Give pi a moment to initialise, then send the prompt
    setTimeout(() => {
      pi.stdin.write(
        JSON.stringify({ type: "prompt", message: prompt }) + "\n"
      );
    }, 300);
  });
}

module.exports = { runPiTurn };
