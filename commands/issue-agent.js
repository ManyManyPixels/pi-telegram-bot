const { promises: fs } = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { createLogger } = require("../utils/logger");
const { getOrCreateIssueSession } = require("../sessions");
const { runPiTurn } = require("../pi");

const log = createLogger("issue-agent");

// ── Constants ────────────────────────────────────────────────────────

const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_COMMENT_LENGTH = 65536;
const TARGET_REPO = (process.env.GITHUB_ISSUE_REPO || "alexfi/flow").trim();
const BOT_USERNAME = (process.env.GITHUB_BOT_USERNAME || "").trim();

const PROVIDER =
  process.env.PI_ISSUE_PROVIDER || process.env.PI_PROVIDER || "deepseek";
const MODEL =
  process.env.PI_ISSUE_MODEL || process.env.PI_MODEL || "deepseek-v4-pro";
const WORK_DIR = process.env.PI_WORK_DIR || __dirname;
const PROMPT_PATH = path.join(__dirname, "issue-agent-prompt.md");

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

// ── GitHub API helpers via gh CLI ────────────────────────────────────

async function addReaction(repo, commentId, content) {
  return execFilePromise("gh", [
    "api",
    `repos/${repo}/issues/comments/${commentId}/reactions`,
    "-f", `content=${content}`,
    "--silent",
  ]);
}

async function postComment(repo, issueNumber, body) {
  return execFilePromise("gh", [
    "issue", "comment", String(issueNumber),
    "--repo", repo,
    "--body", body,
  ]);
}

async function fetchIssue(repo, issueNumber) {
  const stdout = await execFilePromise("gh", [
    "issue", "view", String(issueNumber),
    "--repo", repo,
    "--json", "title,body,labels",
  ]);
  return JSON.parse(stdout);
}

/**
 * Check whether an issue has the "has-agent" label.
 * Returns true if the label is present, false otherwise.
 */
async function issueHasAgentLabel(repo, issueNumber) {
  try {
    const stdout = await execFilePromise("gh", [
      "issue", "view", String(issueNumber),
      "--repo", repo,
      "--json", "labels",
    ]);
    const data = JSON.parse(stdout);
    return (data.labels || []).some((l) => l.name === "has-agent");
  } catch (err) {
    log.warn({ issueNumber, err: err.message }, "failed to check has-agent label, allowing through");
    // If we can't check, err on the side of processing (don't silently drop)
    return true;
  }
}

// ── Response splitting ───────────────────────────────────────────────

/**
 * Split a long response into chunks that fit within GitHub's comment limit.
 * Tries to split at paragraph boundaries (double newline), then at sentence
 * boundaries, then falls back to hard cuts.
 */
function splitResponse(text) {
  if (text.length <= MAX_COMMENT_LENGTH) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n\n+/);

  let current = "";
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > MAX_COMMENT_LENGTH) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      // If a single paragraph is too long, split further
      if (para.length > MAX_COMMENT_LENGTH) {
        let remaining = para;
        while (remaining.length > MAX_COMMENT_LENGTH) {
          const slice = remaining.slice(0, MAX_COMMENT_LENGTH - 100);
          const lastDot = slice.lastIndexOf(". ");
          const cutPoint =
            lastDot > MAX_COMMENT_LENGTH / 2 ? lastDot + 1 : MAX_COMMENT_LENGTH - 100;
          chunks.push(remaining.slice(0, cutPoint).trim());
          remaining = remaining.slice(cutPoint).trim();
        }
        if (remaining) current = remaining;
      } else {
        current = para;
      }
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Add continuation markers
  if (chunks.length > 1) {
    const total = chunks.length;
    return chunks.map((c, i) => {
      if (i === 0) return c + `\n\n---\n*(continued in next comment...)*`;
      if (i === total - 1) return `*(...continuation)*\n\n` + c;
      return `*(...continued)*\n\n` + c + `\n\n---\n*(continued...)*`;
    });
  }

  return chunks;
}

// ── System prompt ────────────────────────────────────────────────────

async function loadSystemPrompt() {
  try {
    const raw = await fs.readFile(PROMPT_PATH, "utf8");
    return raw.trim();
  } catch {
    log.warn("issue-agent prompt not found at %s, using fallback", PROMPT_PATH);
    return "You are a helpful coding assistant responding to GitHub issues.";
  }
}

// ── Prompt building ──────────────────────────────────────────────────

/**
 * Build the user prompt for the agent turn.
 * On the first turn (isNew), seed with issue title and body so the agent
 * has context before the session history is established.
 */
function buildPrompt(commentBody, issueData, isNew) {
  if (!isNew) return commentBody;

  const title = issueData.title || "Untitled";
  const body = issueData.body || "";

  let msg = `[ISSUE CONTEXT]\nTitle: ${title}\n`;
  if (body) {
    msg += `Body: ${body}\n`;
  }
  msg += `[/ISSUE CONTEXT]\n\n${commentBody}`;

  return msg;
}

// ── Main handler ─────────────────────────────────────────────────────

/**
 * Handle an issue_comment webhook event.
 * Called from server.js when an issue_comment event is received.
 *
 * Every user comment triggers an agent turn using a persistent per-issue
 * session. The agent remembers conversation history across turns via its
 * session .jsonl file. No context rebuilding, no mention gating.
 *
 * @param {object} payload - The full webhook payload from GitHub
 */
async function handleIssueComment(payload) {
  const repo = payload.repository?.full_name;
  const action = payload.action;
  const issue = payload.issue;
  const comment = payload.comment;
  if (!repo || !issue || !comment) {
    log.warn("missing repo/issue/comment in payload");
    return;
  }

  // Guard: only handle target repo
  if (repo !== TARGET_REPO) {
    log.debug({ repo }, "skipping non-target repo");
    return;
  }

  // Guard: only "created" actions (not edited/deleted)
  if (action !== "created") {
    log.debug({ action }, "skipping non-created action");
    return;
  }

  // Guard: skip bot's own comments (loop prevention)
  const commentAuthor = comment.user?.login || "";
  if (BOT_USERNAME && commentAuthor === BOT_USERNAME) {
    log.debug({ commentAuthor }, "skipping bot's own comment");
    return;
  }

  const issueNumber = issue.number;

  // Guard: only process comments on issues that have the "has-agent" label
  const hasAgent = await issueHasAgentLabel(repo, issueNumber);
  if (!hasAgent) {
    log.info({ issueNumber }, "issue does not have has-agent label, skipping");
    return;
  }
  const commentId = comment.id;
  const commentBody = comment.body || "";
  const shortId = Math.random().toString(36).slice(2, 10);

  log.info(
    { shortId, repo, issueNumber, commentId, author: commentAuthor },
    "processing issue comment"
  );

  // Post 👀 reaction to acknowledge
  try {
    await addReaction(repo, commentId, "eyes");
    log.info({ shortId, commentId }, "posted 👀 reaction");
  } catch (err) {
    log.warn({ shortId, commentId, err: err.message }, "failed to post 👀 reaction");
  }

  // Fire-and-forget the agent work
  (async () => {
    // Get or create the persistent session for this issue
    const { uuid, isNew } = getOrCreateIssueSession(issueNumber);

    // Fetch issue data (only needed for first-turn seeding)
    let issueData = { title: "", body: "" };
    if (isNew) {
      try {
        issueData = await fetchIssue(repo, issueNumber);
      } catch (err) {
        log.warn({ shortId, err: err.message }, "failed to fetch issue data for seeding");
        // Continue without seeding — agent can self-serve via gh CLI
      }
    }

    const prompt = buildPrompt(commentBody, issueData, isNew);
    const systemPrompt = await loadSystemPrompt();

    log.info(
      { shortId, issueNumber, isNew, promptLen: prompt.length },
      "spawning issue agent"
    );

    let responseText;
    try {
      responseText = await runPiTurn(uuid, prompt, {
        extensions: true,
        provider: PROVIDER,
        model: MODEL,
        systemPrompt,
        workDir: WORK_DIR,
        timeoutMs: AGENT_TIMEOUT_MS,
      });
    } catch (err) {
      log.error({ shortId, err: err.message }, "agent failed");
      try {
        await addReaction(repo, commentId, "confused");
        await postComment(
          repo,
          issueNumber,
          `❌ Something went wrong: ${err.message}`
        );
      } catch (e) {
        log.error({ shortId, err: e.message }, "failed to post error comment");
      }
      return;
    }

    if (!responseText.trim()) {
      log.warn({ shortId }, "agent returned empty response");
      try {
        await addReaction(repo, commentId, "confused");
        await postComment(
          repo,
          issueNumber,
          "❌ I generated an empty response — something may have gone wrong."
        );
      } catch (e) {
        log.error({ shortId, err: e.message }, "failed to post empty-response comment");
      }
      return;
    }

    // Post response as comment(s)
    try {
      const chunks = splitResponse(responseText);
      for (let i = 0; i < chunks.length; i++) {
        await postComment(repo, issueNumber, chunks[i]);
        log.info({ shortId, chunk: i + 1, total: chunks.length }, "posted comment");
      }

      // Add 🚀 reaction on success
      try {
        await addReaction(repo, commentId, "rocket");
      } catch {}

      log.info({ shortId }, "issue comment handled successfully");
    } catch (err) {
      log.error({ shortId, err: err.message }, "failed to post response");
      try {
        await addReaction(repo, commentId, "confused");
      } catch {}
    }
  })();
}

module.exports = { handleIssueComment };
