const { spawn, execFile } = require("child_process");
const { promises: fs } = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createLogger } = require("../utils/logger");

const log = createLogger("research");

// ── Constants ────────────────────────────────────────────────────────

const MAX_RUNNING_PER_CHAT = 5;
const MAX_COMPLETED_HISTORY = 10;
const RESEARCH_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const HOME = process.env.HOME || "/root";
const SKILL_PATH = path.join(
  HOME,
  ".pi/agent/skills/research-codebase/SKILL.md"
);
const RESEARCH_BASE = path.join(HOME, "research");

const PROVIDER =
  process.env.PI_RESEARCH_PROVIDER || process.env.PI_PROVIDER || "deepseek";
const MODEL =
  process.env.PI_RESEARCH_MODEL || process.env.PI_MODEL || "deepseek-v4-pro";
const WORK_DIR = process.env.PI_WORK_DIR || __dirname;

// ── Tracking ─────────────────────────────────────────────────────────
// Map<taskId, { chatId, query, startTime, endTime?, status, childProcess,
//               researchDir, outputFile?, issueUrl?, errorReason? }>

const tasks = new Map(); // taskId -> entry (all)
let completedOrder = []; // FIFO order of completed taskIds

function runningCount(chatId) {
  let n = 0;
  for (const e of tasks.values()) {
    if (e.chatId === chatId && e.status === "running") n++;
  }
  return n;
}

function evictCompleted() {
  while (completedOrder.length > MAX_COMPLETED_HISTORY) {
    const id = completedOrder.shift();
    tasks.delete(id);
  }
}

// ── Git helpers ──────────────────────────────────────────────────────

/**
 * Parse owner/repo from a git remote URL.
 * Handles: git@github.com:owner/repo.git, https://github.com/owner/repo.git, https://github.com/owner/repo
 */
function parseOwnerRepo(url) {
  const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

async function getOwnerRepo() {
  try {
    const stdout = await execFilePromise("git", [
      "remote",
      "get-url",
      "origin",
    ], { cwd: WORK_DIR, timeout: 5000 });
    return parseOwnerRepo(stdout.trim());
  } catch {
    return null;
  }
}

// ── Exec helpers ─────────────────────────────────────────────────────

function execFilePromise(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        reject(
          new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`)
        );
      } else {
        resolve(stdout);
      }
    });
  });
}

// ── System prompt builder ────────────────────────────────────────────

async function buildSystemPrompt(researchDir) {
  // Read preamble
  const preamblePath = path.join(__dirname, "research-agent-prompt.md");
  const preamble = await fs.readFile(preamblePath, "utf8");

  // Read research-codebase skill
  let skill = "";
  try {
    skill = await fs.readFile(SKILL_PATH, "utf8");
  } catch {
    log.warn("research-codebase skill not found at %s", SKILL_PATH);
  }

  // Remove the interactive handshake section
  skill = skill.replace(
    /## Initial Setup:[\s\S]*?Then wait for the user's research query\.\s*/,
    "## Initial Setup\n\nThe research topic is provided in the user message. Begin immediately.\n\n"
  );

  // Remove "Ask if they have follow-up questions" in step 8
  skill = skill.replace(
    /- Ask if they have follow-up questions or need clarification\n?/g,
    ""
  );

  // Replace output directory references
  skill = skill.replace(/~\/(?:Desktop\/research|Desktop)/g, researchDir);

  const prompt = preamble.replace("{{RESEARCH_DIR}}", researchDir);

  if (skill) {
    return prompt + "\n\n---\n\n# Research Procedure\n\n" + skill;
  }
  return prompt;
}

// ── Output file discovery ────────────────────────────────────────────

async function findResearchOutput(researchDir, sinceTime) {
  try {
    const files = await fs.readdir(researchDir);
    const candidates = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const fp = path.join(researchDir, f);
      const stat = await fs.stat(fp);
      if (stat.birthtimeMs >= sinceTime) {
        candidates.push({ path: fp, name: f, mtime: stat.mtimeMs });
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0] || null;
  } catch {
    return null;
  }
}

async function extractTitle(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const match = content.match(/^# Research:?\s*(.+)$/m);
    if (match) return match[1].trim();
    // Fallback: filename without date prefix
    const basename = path.basename(filePath, ".md");
    return basename.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " ");
  } catch {
    return null;
  }
}

// ── GitHub issue creation ────────────────────────────────────────────

async function createGitHubIssue(ownerRepo, title, bodyFile) {
  // Try with label first
  try {
    const stdout = await execFilePromise("gh", [
      "issue",
      "create",
      "--repo",
      ownerRepo,
      "--title",
      title,
      "--body-file",
      bodyFile,
      "--label",
      "research",
    ]);
    return stdout.trim(); // the issue URL
  } catch (err) {
    log.warn({ err: err.message }, "gh issue create with label failed, retrying without");
    // Retry without label
    const stdout = await execFilePromise("gh", [
      "issue",
      "create",
      "--repo",
      ownerRepo,
      "--title",
      title,
      "--body-file",
      bodyFile,
    ]);
    return stdout.trim();
  }
}

// ── Spawn research agent ─────────────────────────────────────────────

async function spawnResearch(taskId, chatId, query, ownerRepo, telegram) {
  // Ensure research directories exist
  await fs.mkdir(RESEARCH_BASE, { recursive: true });
  const researchDir = path.join(RESEARCH_BASE, ownerRepo);
  await fs.mkdir(researchDir, { recursive: true });

  const systemPrompt = await buildSystemPrompt(researchDir);

  const args = [
    "--mode", "rpc",
    "--provider", PROVIDER,
    "--model", MODEL,
    "--no-session",
    "--system-prompt", systemPrompt,
  ];

  const shortId = taskId.slice(0, 8);
  log.info(
    { taskId: shortId, chatId, ownerRepo, provider: PROVIDER, model: MODEL, researchDir, workDir: WORK_DIR },
    "spawning research agent"
  );

  const startTime = Date.now();
  const pi = spawn("pi", args, {
    cwd: WORK_DIR,
    stdio: ["pipe", "pipe", "pipe"],
  });
  log.info({ taskId: shortId, pid: pi.pid }, "research agent pid");

  // Track the entry
  const entry = {
    taskId,
    chatId,
    query,
    startTime,
    status: "running",
    childProcess: pi,
    researchDir,
    outputFile: null,
    issueUrl: null,
    errorReason: null,
  };
  tasks.set(taskId, entry);

  // Timeout
  const timeout = setTimeout(() => {
    log.warn({ taskId: taskId.slice(0, 8) }, "research timeout, killing");
    entry.errorReason = "timeout";
    pi.kill("SIGTERM");
    setTimeout(() => {
      try { pi.kill("SIGKILL"); } catch {}
    }, 2000);
  }, RESEARCH_TIMEOUT_MS);

  // Log stderr at info level for visibility
  let stderrBuf = "";
  pi.stderr.on("data", (d) => {
    const text = d.toString().trim();
    stderrBuf += text + "\n";
    if (stderrBuf.length > 5000) stderrBuf = stderrBuf.slice(-3000);
    if (text) log.info({ taskId: shortId, stderr: text.slice(0, 300) }, "pi stderr");
  });

  // Parse RPC events for progress logging
  let stdoutBuf = "";
  let lineBuf = ""; // accumulates partial lines across chunks

  pi.stdout.on("data", (d) => {
    const chunk = d.toString();
    stdoutBuf += chunk;
    if (stdoutBuf.length > 10000) {
      stdoutBuf = stdoutBuf.slice(-5000);
    }

    // Buffer-aware JSON-line parsing: split by newlines, carry partial line to next chunk
    lineBuf += chunk;
    const lines = lineBuf.split("\n");
    // Last element is either empty (if chunk ended with \n) or a partial line
    lineBuf = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        if (event.type === "message_update") {
          const d = event.assistantMessageEvent;
          if (d?.type === "text_delta" && d.delta) {
            log.trace({ taskId: shortId, text: d.delta.slice(0, 200) }, "research text");
          }
        }

        if (event.type === "tool_execution_start") {
          log.info({ taskId: shortId, tool: event.toolName }, "research tool call");
        }

        if (event.type === "tool_execution_result") {
          const err = event.toolExecutionResult?.isError;
          if (err) {
            log.warn({ taskId: shortId, tool: event.toolName }, "research tool error");
          } else {
            log.debug({ taskId: shortId, tool: event.toolName }, "research tool result");
          }
        }

        if (event.type === "agent_end") {
          log.info({ taskId: shortId }, "research agent_end event, closing stdin to trigger shutdown");
          // RPC mode runs forever waiting for stdin; closing stdin triggers graceful shutdown
          try { pi.stdin.end(); } catch {}
        }
      } catch {
        // skip non-JSON lines (stderr bleed, partial chunks)
      }
    }
  });

  pi.on("error", (err) => {
    clearTimeout(timeout);
    log.error({ taskId: shortId, err: err.message, stack: err.stack }, "pi spawn error");
  });

  // 'exit' fires before 'close' — use as backup signal
  pi.on("exit", (code, signal) => {
    log.info({ taskId: shortId, exitCode: code, signal }, "research agent exit event");
  });

  pi.on("close", async (code, signal) => {
    clearTimeout(timeout);

    const elapsed = Date.now() - startTime;
    log.info(
      { taskId: shortId, exitCode: code, signal, elapsed, stdoutLen: stdoutBuf.length, stderrLen: stderrBuf.length },
      "research agent closed"
    );

    try {
      // Check if already marked as failed (timeout)
      if (entry.errorReason) {
        await finalizeFailure(taskId, entry, telegram);
        return;
      }

      if (code !== 0 || signal) {
        entry.errorReason = signal ? `signal_${signal}` : `exit_code_${code}`;
        await finalizeFailure(taskId, entry, telegram);
        return;
      }

      // Find output file
      const output = await findResearchOutput(researchDir, startTime);
      if (!output) {
        log.warn({ taskId: shortId, researchDir }, "no research output file found in dir");
        // List directory for debugging
        try {
          const ls = await fs.readdir(researchDir);
          log.warn({ taskId: shortId, dirContents: ls }, "research dir contents");
        } catch {}
        entry.errorReason = "no_output";
        await finalizeFailure(taskId, entry, telegram);
        return;
      }

      log.info({ taskId: shortId, outputFile: output.path, outputSize: (await fs.stat(output.path)).size }, "found research output");

      entry.outputFile = output.path;

      // Extract title
      const title = (await extractTitle(output.path)) || query;

      // Create GitHub issue
      try {
        const issueUrl = await createGitHubIssue(ownerRepo, title, output.path);
        entry.issueUrl = issueUrl;
        log.info({ taskId: shortId, issueUrl }, "github issue created");

        entry.status = "done";
        entry.endTime = Date.now();
        completedOrder.push(taskId);
        evictCompleted();

        await telegram.sendResponse(
          chatId,
          `✅ Research complete: ${title}\n🐙 ${issueUrl}`
        );
      } catch (err) {
        log.error({ taskId: shortId, err: err.message }, "failed to create github issue");
        entry.errorReason = "issue_failed";
        entry.status = "failed";
        entry.endTime = Date.now();
        completedOrder.push(taskId);
        evictCompleted();

        await telegram.sendResponse(
          chatId,
          `✅ Research complete: ${title}\n⚠️ Could not create GitHub issue: ${err.message}`
        );
      }
    } catch (closeErr) {
      log.error({ taskId: shortId, err: closeErr.message, stack: closeErr.stack }, "close handler error");
      try {
        entry.errorReason = `close_handler_error`;
        entry.status = "failed";
        entry.endTime = Date.now();
        completedOrder.push(taskId);
        evictCompleted();
        await telegram.sendResponse(chatId, `❌ Research failed (internal error)`);
      } catch {}
    }
  });

  // Send the prompt
  setTimeout(() => {
    pi.stdin.write(
      JSON.stringify({ type: "prompt", message: query }) + "\n"
    );
  }, 300);
}

async function finalizeFailure(taskId, entry, telegram) {
  entry.status = "failed";
  entry.endTime = Date.now();
  completedOrder.push(taskId);
  evictCompleted();

  const reason = entry.errorReason || "unknown";
  let msg = `❌ Research failed (${reason})`;
  if (entry.outputFile) {
    msg += `\nPartial output: ${entry.outputFile}`;
  }
  await telegram.sendResponse(entry.chatId, msg);
}

// ── Formatting helpers ───────────────────────────────────────────────

function formatElapsed(ms) {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m`;
  return `${secs}s`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ── Command handlers ─────────────────────────────────────────────────

/**
 * /research <query> — spawn a detached research agent
 */
async function research(chatId, args, ctx) {
  const query = args.trim();
  if (!query) {
    return "Usage: /research <topic>\nStart a codebase research task on the given topic.";
  }

  // Check per-chat limit
  if (runningCount(chatId) >= MAX_RUNNING_PER_CHAT) {
    return `⚠️ Already running ${MAX_RUNNING_PER_CHAT} researches. Wait for one to complete or use /research-list to check.`;
  }

  // Resolve owner/repo from git
  const ownerRepo = await getOwnerRepo();
  if (!ownerRepo) {
    return "⚠️ Could not determine GitHub repository from git remote. Ensure PI_WORK_DIR is a git repo with an origin remote.";
  }

  const taskId = crypto.randomUUID();
  const shortId = taskId.slice(0, 8);

  // Fire and forget — spawn runs in background
  spawnResearch(taskId, chatId, query, ownerRepo, ctx.telegram);

  return `🔍 ${shortId} | Researching: "${query}"...`;
}

/**
 * /research-list — show active and recent researches
 */
function researchList(chatId, _args, _ctx) {
  const all = Array.from(tasks.values()).filter((e) => e.chatId === chatId);

  const running = all.filter((e) => e.status === "running");
  const completed = all
    .filter((e) => e.status !== "running")
    .sort((a, b) => (b.endTime || 0) - (a.endTime || 0))
    .slice(0, MAX_COMPLETED_HISTORY);

  if (running.length === 0 && completed.length === 0) {
    return "No active or recent researches. Start one with /research <topic>.";
  }

  const lines = [];

  if (running.length > 0) {
    lines.push(`🔬 Active researches (${running.length}):`);
    for (const e of running) {
      const id = e.taskId ? e.taskId.slice(0, 8) : "?";
      const elapsed = formatElapsed(Date.now() - e.startTime);
      lines.push(`• ${id} | running ${elapsed} | "${e.query}"`);
    }
  }

  if (completed.length > 0) {
    if (running.length > 0) lines.push("");
    lines.push(`✅ Recent (max ${MAX_COMPLETED_HISTORY}):`);
    for (const e of completed) {
      const id = e.taskId ? e.taskId.slice(0, 8) : "?";
      if (e.status === "done") {
        const time = e.endTime ? formatTime(e.endTime) : "?";
        const url = e.issueUrl ? ` | ${e.issueUrl}` : "";
        lines.push(`• ${id} | done ${time} | "${e.query}"${url}`);
      } else {
        const reason = e.errorReason || "unknown";
        lines.push(`• ${id} | failed (${reason}) | "${e.query}"`);
      }
    }
  }

  return lines.join("\n");
}

module.exports = { research, researchList, tasks };
