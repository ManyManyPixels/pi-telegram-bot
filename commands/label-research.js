const { spawn, execFile } = require("child_process");
const { promises: fs } = require("fs");
const path = require("path");
const { createLogger } = require("../utils/logger");

const log = createLogger("label-research");

// ── Constants ────────────────────────────────────────────────────────

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
const TARGET_REPO = (process.env.GITHUB_ISSUE_REPO || "").trim();

// ── Running tracker ──────────────────────────────────────────────────
// Key: "owner/repo#123" — prevents duplicate research on same issue
const running = new Map();

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

// ── Git helpers ──────────────────────────────────────────────────────

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

// ── System prompt ────────────────────────────────────────────────────

async function buildSystemPrompt(researchDir) {
  const preamblePath = path.join(__dirname, "research-agent-prompt.md");
  const preamble = await fs.readFile(preamblePath, "utf8");

  let skill = "";
  try {
    skill = await fs.readFile(SKILL_PATH, "utf8");
  } catch {
    log.warn("research-codebase skill not found at %s", SKILL_PATH);
  }

  // Remove interactive handshake section
  skill = skill.replace(
    /## Initial Setup:[\s\S]*?Then wait for the user's research query\.\s*/,
    "## Initial Setup\n\nThe research topic is provided in the user message. Begin immediately.\n\n"
  );

  // Remove follow-up question prompt
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

// ── GitHub helpers ───────────────────────────────────────────────────

async function updateIssueBody(repo, issueNumber, bodyFile) {
  return execFilePromise("gh", [
    "issue", "edit", String(issueNumber),
    "--repo", repo,
    "--body-file", bodyFile,
  ]);
}

async function removeLabel(repo, issueNumber, label) {
  return execFilePromise("gh", [
    "issue", "edit", String(issueNumber),
    "--repo", repo,
    "--remove-label", label,
  ]);
}

async function addLabels(repo, issueNumber, labels) {
  return execFilePromise("gh", [
    "issue", "edit", String(issueNumber),
    "--repo", repo,
    "--add-label", labels,
  ]);
}

async function addComment(repo, issueNumber, body) {
  return execFilePromise("gh", [
    "issue", "comment", String(issueNumber),
    "--repo", repo,
    "--body", body,
  ]);
}

// ── Research spawn ───────────────────────────────────────────────────

async function spawnLabelResearch(repo, issueNumber, title, body, ownerRepoDir) {
  const issueKey = `${repo}#${issueNumber}`;
  const researchDir = path.join(RESEARCH_BASE, ownerRepoDir);
  await fs.mkdir(researchDir, { recursive: true });

  const systemPrompt = await buildSystemPrompt(researchDir);

  // Combine title + body as the research query
  const query = body ? `${title}\n\n${body}` : title;

  const args = [
    "--mode", "rpc",
    "--provider", PROVIDER,
    "--model", MODEL,
    "--no-session",
    "--system-prompt", systemPrompt,
  ];

  log.info(
    { issueKey, repo, issueNumber, researchDir, provider: PROVIDER, model: MODEL },
    "spawning research agent"
  );

  const startTime = Date.now();
  const pi = spawn("pi", args, {
    cwd: WORK_DIR,
    stdio: ["pipe", "pipe", "pipe"],
  });
  log.info({ issueKey, pid: pi.pid }, "research agent pid");

  // Track running
  running.set(issueKey, { repo, issueNumber, startTime, pid: pi.pid });

  // Timeout
  const timeout = setTimeout(() => {
    log.warn({ issueKey }, "research timeout, killing");
    pi.kill("SIGTERM");
    setTimeout(() => {
      try { pi.kill("SIGKILL"); } catch {}
    }, 2000);
  }, RESEARCH_TIMEOUT_MS);

  // Log stderr
  let stderrBuf = "";
  pi.stderr.on("data", (d) => {
    const text = d.toString().trim();
    stderrBuf += text + "\n";
    if (stderrBuf.length > 5000) stderrBuf = stderrBuf.slice(-3000);
    if (text) log.info({ issueKey, stderr: text.slice(0, 300) }, "pi stderr");
  });

  // Parse RPC events
  let stdoutBuf = "";
  let lineBuf = "";

  pi.stdout.on("data", (d) => {
    const chunk = d.toString();
    stdoutBuf += chunk;
    if (stdoutBuf.length > 10000) {
      stdoutBuf = stdoutBuf.slice(-5000);
    }

    lineBuf += chunk;
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        if (event.type === "tool_execution_start") {
          log.info({ issueKey, tool: event.toolName }, "research tool call");
        }

        if (event.type === "tool_execution_result") {
          const err = event.toolExecutionResult?.isError;
          if (err) {
            log.warn({ issueKey, tool: event.toolName }, "research tool error");
          } else {
            log.debug({ issueKey, tool: event.toolName }, "research tool result");
          }
        }

        if (event.type === "agent_end") {
          log.info({ issueKey }, "research agent_end, closing stdin");
          try { pi.stdin.end(); } catch {}
        }
      } catch {
        // skip non-JSON lines
      }
    }
  });

  pi.on("error", (err) => {
    clearTimeout(timeout);
    log.error({ issueKey, err: err.message }, "pi spawn error");
    running.delete(issueKey);
  });

  pi.on("exit", (code, signal) => {
    log.info({ issueKey, exitCode: code, signal }, "research agent exit event");
  });

  pi.on("close", async (code, signal) => {
    clearTimeout(timeout);
    running.delete(issueKey);

    const elapsed = Date.now() - startTime;
    log.info(
      { issueKey, exitCode: code, signal, elapsed },
      "research agent closed"
    );

    try {
      if (code !== 0 || signal) {
        const reason = signal ? `signal_${signal}` : `exit_code_${code}`;
        await handleFailure(repo, issueNumber, reason);
        return;
      }

      // Find output file
      const output = await findResearchOutput(researchDir, startTime);
      if (!output) {
        log.warn({ issueKey, researchDir }, "no research output file found");
        await handleFailure(repo, issueNumber, "no_output");
        return;
      }

      log.info(
        { issueKey, outputFile: output.path, outputSize: (await fs.stat(output.path)).size },
        "found research output"
      );

      // Replace issue body with research results
      try {
        await updateIssueBody(repo, issueNumber, output.path);
        log.info({ issueKey }, "issue body updated with research");

        // Remove needs-research label, add research + has-agent labels
        await removeLabel(repo, issueNumber, "needs-research");
        await addLabels(repo, issueNumber, "research,has-agent");
        log.info({ issueKey }, "labels updated: removed needs-research, added research + has-agent");
      } catch (err) {
        log.error({ issueKey, err: err.message }, "failed to update issue");
        await handleFailure(repo, issueNumber, `update_failed: ${err.message}`);
      }
    } catch (closeErr) {
      log.error({ issueKey, err: closeErr.message }, "close handler error");
      try {
        await handleFailure(repo, issueNumber, "internal_error");
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

async function handleFailure(repo, issueNumber, reason) {
  try {
    await addComment(
      repo,
      issueNumber,
      `❌ Research failed: \`${reason}\``
    );
    log.info({ repo, issueNumber, reason }, "posted failure comment");
  } catch (err) {
    log.error({ repo, issueNumber, reason, err: err.message }, "failed to post failure comment");
  }

  try {
    await removeLabel(repo, issueNumber, "needs-research");
    log.info({ repo, issueNumber }, "removed needs-research label after failure");
  } catch (err) {
    log.error({ repo, issueNumber, err: err.message }, "failed to remove label after failure");
  }
}

// ── Webhook handler ──────────────────────────────────────────────────

/**
 * Handle an issues webhook event that has the needs-research label.
 * Called from server.js for:
 *   - issues labeled "needs-research"
 *   - issues opened with "needs-research" in labels
 *
 * @param {object} payload - Full webhook payload
 */
async function handleLabelEvent(payload) {
  const repo = payload.repository?.full_name;
  const issue = payload.issue;
  if (!repo || !issue) {
    log.warn("missing repo/issue in payload");
    return;
  }

  // Verify repo matches PI_WORK_DIR
  const ownerRepo = await getOwnerRepo();
  if (!ownerRepo) {
    log.warn("could not determine owner/repo from git remote");
    return;
  }
  if (repo !== ownerRepo) {
    log.debug({ webhookRepo: repo, workDirRepo: ownerRepo }, "repo mismatch, skipping");
    return;
  }

  const issueNumber = issue.number;
  const issueKey = `${repo}#${issueNumber}`;

  // Dedup: skip if already running
  if (running.has(issueKey)) {
    log.info({ issueKey }, "research already running for this issue, skipping");
    return;
  }

  const title = issue.title || "Untitled";
  const body = issue.body || "";

  log.info({ issueKey, title }, "starting research");

  // Fire and forget
  spawnLabelResearch(repo, issueNumber, title, body, ownerRepo);
}

module.exports = { handleLabelEvent };
