const { spawn } = require("child_process");
const path = require("path");
const { createLogger } = require("./utils/logger");

const log = createLogger("pi");

const PROVIDER = process.env.PI_PROVIDER || "deepseek";
const MODEL = process.env.PI_MODEL || "deepseek-v4-pro";
const SESSIONS_DIR = path.resolve(
  process.env.PI_SESSION_DIR || path.join(__dirname, "sessions")
);
const WORK_DIR = process.env.PI_WORK_DIR || __dirname;
const PI_TIMEOUT_MS = parseInt(process.env.PI_TIMEOUT_MS || "300000", 10); // 5 min

function sessionPath(uuid) {
  return path.join(SESSIONS_DIR, `chat-${uuid}.jsonl`);
}

/**
 * Spawn a pi RPC process, send a prompt, and collect the full text response.
 * Returns the accumulated assistant text.
 */
function runPiTurn(uuid, prompt) {
  return new Promise((resolve, reject) => {
    const session = sessionPath(uuid);
    const args = [
      "--mode", "rpc",
      "--provider", PROVIDER,
      "--model", MODEL,
      "--session", session,
      "--no-extensions",
    ];

    const sessionShort = uuid.slice(0, 8);
    log.info({ session: sessionShort, file: session }, "starting pi turn");

    const turnStart = Date.now();
    log.debug({ workDir: WORK_DIR }, "pi working directory");
    const pi = spawn("pi", args, {
      cwd: WORK_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let responseText = "";

    const timeout = setTimeout(() => {
      log.warn({ session: sessionShort, timeoutMs: PI_TIMEOUT_MS }, "timeout, killing pi");
      pi.kill("SIGTERM");
      // Give it a moment, then force kill
      setTimeout(() => {
        try { pi.kill("SIGKILL"); } catch {}
      }, 2000);
    }, PI_TIMEOUT_MS);

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

          if (event.type === "tool_execution_start") {
            log.info({ session: sessionShort, tool: event.toolName }, "tool call");
          }

          if (event.type === "tool_execution_result") {
            const err = event.toolExecutionResult?.isError;
            if (err) {
              log.warn({ session: sessionShort, tool: event.toolName }, "tool error");
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
          // skip non-JSON lines (stderr bleed, etc.)
        }
      }
    });

    pi.stderr.on("data", (d) => {
      log.trace({ session: sessionShort, stderr: d.toString().trim() }, "pi stderr");
    });

    pi.on("close", (code) => {
      clearTimeout(timeout);
      const level = code === 0 ? "info" : "warn";
      const elapsed = Date.now() - turnStart;
      log[level]({ session: sessionShort, exitCode: code, elapsed }, "pi exited");
      resolve(responseText);
    });

    pi.on("error", (err) => {
      clearTimeout(timeout);
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
