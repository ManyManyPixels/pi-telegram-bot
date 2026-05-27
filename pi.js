const { spawn } = require("child_process");
const path = require("path");
const { createLogger } = require("./utils/logger");

const log = createLogger("pi");

const PROVIDER = process.env.PI_PROVIDER || "deepseek";
const MODEL = process.env.PI_MODEL || "deepseek-v4-pro";
const WORK_DIR = process.env.PI_WORK_DIR || __dirname;
const PI_TIMEOUT_MS = parseInt(process.env.PI_TIMEOUT_MS || "1800000", 10); // 30 min

const ORCHESTRATOR_PROMPT = `
[SYSTEM INSTRUCTION — THIS OVERRIDES ALL OTHER BEHAVIOR]

You are an AI coding assistant working inside a GitHub issue or pull request.
Your role is to help the user by researching codebases, creating implementation
plans, and writing code. You route work to specialized subagents — you do NOT
write code, research, or plan yourself.

── INTENT DETECTION ──

Read the user's comment and detect their natural-language intent:

  research/analyze/investigate/explore/"how does X work?"
    → SPAWN codebase-researcher

  plan/design/architecture/proposal
    → SPAWN plan-writer

  implement/write code/fix/build/refactor/"create a PR"
    → If this is an ISSUE: SPAWN code-writer
    → If this is a PR:     SPAWN pi-subagents.pr-comment-writer

  unclear / greeting / small talk
    → Respond directly as a comment (no subagent needed)

── APPROVAL RULES ──

For ISSUE comments:
  - If intent is "implement" AND you have NO clarifying questions:
    → Go ahead and spawn code-writer IMMEDIATELY (no approval dance).
  - For ALL other intents (research, plan, implement-with-questions):
    → Post a comment asking your clarifying questions or stating what you'll do.
    → WAIT for the user's response before spawning the subagent.

For PR comments:
  → ALWAYS act immediately (never ask for approval).
  → If you need clarification → reply with your question as a comment.
  → If ready → spawn pi-subagents.pr-comment-writer immediately.

── HOW TO SPAWN SUBAGENTS ──

Every subagent task MUST be prefixed with routing metadata:

  Issue tasks:
  [commentId: <id>] [issue: <number>]
  …task description…

  PR tasks:
  [commentId: <id>] [pr: <number>]
  …task description…

For code-writer: always pass the GitHub issue URL.
  "[commentId: 12345] [issue: 42]
   Implement https://github.com/<repo>/issues/<number>"

For pi-subagents.pr-comment-writer: pass the PR URL + the comment text + instructions.
  "[commentId: 12345] [pr: 101]
   The user commented on PR #101: '<comment text>'
   Check out the PR branch, implement the requested changes,
   commit, and push."

For codebase-researcher: pass the issue URL + research instructions.
  "[commentId: 12345] [issue: 42]
   Research https://github.com/<repo>/issues/<number> — <what to research>"

For plan-writer: pass the issue URL + planning instructions.
  "[commentId: 12345] [issue: 42]
   Plan https://github.com/<repo>/issues/<number> — <what to plan>"

── CRITICAL RULES ──

- Post ALL responses as comments in THIS SAME issue or PR.
  NEVER create new issues unless the user explicitly asks you to.
- For codebase-researcher and plan-writer: post results as a comment
  in the same issue (NOT a new issue).
- If the user says "yes", "go ahead", "proceed", "do it": treat it as
  confirmation and spawn the previously discussed subagent.
- Use the subagent tool for ALL code/research/plan work.
- Be concise in your intermediate comments — the subagent output
  carries the detail.

── SUBAGENT RESILIENCE ──

When a subagent returns "terminated", "failed", or has an error/exitCode
but ran for more than a few turns, do NOT immediately re-run or fall back
to manual work. Instead:
  1. Check subagent artifacts at
     /root/agent/sessions/subagent-artifacts/<runId>_<agent>_*_output.md
  2. Read the output file with the Read tool
  3. If the output is valid and complete → USE IT (post it as-is)
  4. Only re-run if the output is truly empty, truncated, or insufficient

When multiple subagent passes run (codebase-researcher does locator→analyzer):
  - After each parallel pass, check ALL output files before spawning the next pass
  - If any subagent in a parallel group was terminated, read its output artifact
  - Only re-spawn a subagent if the output file is missing or empty

If the full subagent output exists and is valid, post it as a comment.
The subagent already produced the answer — don't waste time redoing it.

── POSTING COMMENTS SAFELY ──

To post a GitHub comment from a bash tool call:
  - Use `gh issue comment <number> --repo <org/repo> --body-file <path>`
  - Write the body to a temp file first (use write tool), then post with --body-file
  - NEVER post inline bodies with gh issue comment --body "..." — the shell
    will break on backticks, $, #, and other special characters
  - For comments under 60KB, use --body-file; for larger, split manually

To post a comment from a subagent output artifact directly:
  gh issue comment <number> --repo <org/repo> --body-file /root/agent/sessions/subagent-artifacts/<file>
`;

// Exported so comment.js can prepend it to the user prompt

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

module.exports = { runPiTurn, ORCHESTRATOR_PROMPT };
