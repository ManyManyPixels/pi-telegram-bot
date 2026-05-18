const { spawn } = require("child_process");
const path = require("path");

const PROVIDER = process.env.PI_PROVIDER || "deepseek";
const MODEL = process.env.PI_MODEL || "deepseek-v4-pro";
const SESSIONS_DIR = path.resolve(
  process.env.PI_SESSION_DIR || path.join(__dirname, "sessions")
);
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

    console.log(`[pi] Starting for session ${uuid.slice(0, 8)} (file: ${session})`);

    const pi = spawn("pi", args, {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let responseText = "";

    const timeout = setTimeout(() => {
      console.error(`[pi] Timeout after ${PI_TIMEOUT_MS}ms, killing`);
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
            console.log(`[pi] Tool call: ${event.toolName}`);
          }

          if (event.type === "tool_execution_result") {
            const err = event.toolExecutionResult?.isError;
            if (err) {
              console.log(`[pi] Tool error: ${event.toolName}`);
            }
          }

          if (event.type === "agent_end") {
            console.log(
              `[pi] Agent ended for session ${uuid.slice(0, 8)} (${responseText.length} chars)`
            );
            pi.stdin.end();
          }
        } catch {
          // skip non-JSON lines (stderr bleed, etc.)
        }
      }
    });

    pi.stderr.on("data", (d) => {
      console.error(`[pi stderr] ${d.toString().trim()}`);
    });

    pi.on("close", (code) => {
      clearTimeout(timeout);
      console.log(`[pi] Exited with code ${code}`);
      resolve(responseText);
    });

    pi.on("error", (err) => {
      clearTimeout(timeout);
      console.error(`[pi] Spawn error: ${err.message}`);
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
