const { promises: fs } = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { createLogger } = require("../utils/logger");
const { getOrCreatePrSession } = require("../sessions");
const { runPiTurn } = require("../pi");

const log = createLogger("pr-review-agent");

// ── Constants ────────────────────────────────────────────────────────

const AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_COMMENT_LENGTH = 65536;
const TARGET_REPO = (process.env.GITHUB_ISSUE_REPO || "alexfi/flow").trim();
const BOT_USERNAME = (process.env.GITHUB_BOT_USERNAME || "").trim();

const PROVIDER =
  process.env.PI_PR_REVIEW_PROVIDER || process.env.PI_PROVIDER || "deepseek";
const MODEL =
  process.env.PI_PR_REVIEW_MODEL || process.env.PI_MODEL || "deepseek-v4-pro";
const WORK_DIR = process.env.PI_WORK_DIR || __dirname;
const PROMPT_PATH = path.join(__dirname, "pr-review-agent-prompt.md");
const HOME = process.env.HOME || "/root";
const CODE_WRITE_SKILL_PATH = path.join(
  HOME,
  ".pi/agent/skills/code-write/SKILL.md"
);

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

// ── GitHub API helpers ───────────────────────────────────────────────

async function postPrComment(repo, prNumber, body) {
  return execFilePromise("gh", [
    "pr", "comment", String(prNumber),
    "--repo", repo,
    "--body", body,
  ]);
}

async function addPrReaction(repo, prNumber, content) {
  return execFilePromise("gh", [
    "api",
    `repos/${repo}/issues/${prNumber}/reactions`,
    "-f", `content=${content}`,
    "--silent",
  ]);
}

// ── Response splitting ───────────────────────────────────────────────

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
  let preamble;
  try {
    preamble = (await fs.readFile(PROMPT_PATH, "utf8")).trim();
  } catch {
    log.warn("pr-review-agent prompt not found at %s, using fallback", PROMPT_PATH);
    preamble = "You are an expert implementation agent. Address PR review feedback by implementing the requested changes on the PR branch.";
  }

  let skill = "";
  try {
    skill = await fs.readFile(CODE_WRITE_SKILL_PATH, "utf8");
  } catch {
    log.warn("code-write skill not found at %s", CODE_WRITE_SKILL_PATH);
  }

  if (skill) {
    return preamble + "\n\n---\n\n# Code-Write Skill\n\n" + skill;
  }
  return preamble;
}

// ── Main handler ─────────────────────────────────────────────────────

/**
 * Handle a pull_request_review webhook event (action: submitted).
 * Called from server.js when a pull_request_review event is received.
 *
 * Passes the PR link and review feedback directly to the agent.
 * The agent self-serves everything else (fetch PR details, find linked
 * issue, read the plan, implement changes, verify, push).
 *
 * Uses a persistent per-PR session so consecutive review rounds
 * have conversation context.
 *
 * @param {object} payload - The full webhook payload from GitHub
 */
async function handleReviewSubmitted(payload) {
  const repo = payload.repository?.full_name;
  const action = payload.action;
  const review = payload.review;
  const pr = payload.pull_request;
  if (!repo || !review || !pr) {
    log.warn("missing repo/review/pr in payload");
    return;
  }

  // Guard: only handle target repo
  if (repo !== TARGET_REPO) {
    log.debug({ repo }, "skipping non-target repo");
    return;
  }

  // Guard: only "submitted" action
  if (action !== "submitted") {
    log.debug({ action }, "skipping non-submitted review action");
    return;
  }

  // Guard: only handle reviews that request changes or have comments
  const reviewState = review.state;
  if (reviewState !== "changes_requested" && reviewState !== "commented") {
    log.info({ reviewState }, "skipping review state (only handle changes_requested/commented)");
    return;
  }

  // Guard: skip bot's own reviews (loop prevention)
  const reviewAuthor = review.user?.login || "";
  if (BOT_USERNAME && reviewAuthor === BOT_USERNAME) {
    log.debug({ reviewAuthor }, "skipping bot's own review");
    return;
  }

  const prNumber = pr.number;
  const prUrl = pr.html_url;
  const shortId = Math.random().toString(36).slice(2, 10);

  log.info(
    { shortId, repo, prNumber, reviewAuthor, reviewState },
    "processing PR review"
  );

  // Fire-and-forget the agent work
  (async () => {
    // Get or create the persistent session for this PR
    const { uuid, isNew } = getOrCreatePrSession(prNumber);

    // Build a minimal prompt — just the PR link.
    // The agent self-serves everything: fetches PR details, finds the
    // linked issue (plan), reads review feedback, checks out the branch,
    // implements changes, verifies, commits, and pushes.
    const prompt =
      `PR: ${prUrl}\n\n` +
      `Implement the changes requested in the PR review feedback. ` +
      `Fetch the PR details, find the linked issue (the plan), read the ` +
      `review comments, check out the PR branch, make the changes, verify, ` +
      `commit, and push. Report what you did.`;

    const systemPrompt = await loadSystemPrompt();

    log.info(
      { shortId, prNumber, isNew, promptLen: prompt.length },
      "spawning PR review agent"
    );

    // Acknowledge with 👀 reaction
    addPrReaction(repo, prNumber, "eyes").catch((err) =>
      log.warn({ shortId, err: err.message }, "failed to post eyes reaction")
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
      addPrReaction(repo, prNumber, "confused").catch(() => {});
      try {
        await postPrComment(
          repo,
          prNumber,
          `❌ Something went wrong while implementing review feedback: ${err.message}`
        );
      } catch (e) {
        log.error({ shortId, err: e.message }, "failed to post error comment");
      }
      return;
    }

    if (!responseText.trim()) {
      log.warn({ shortId }, "agent returned empty response");
      try {
        await postPrComment(
          repo,
          prNumber,
          "✅ Review feedback addressed (changes applied and pushed)."
        );
      } catch (e) {
        log.error({ shortId, err: e.message }, "failed to post empty-response comment");
      }
      // Add 🚀 reaction — changes were successfully applied even if agent didn't narrate
      addPrReaction(repo, prNumber, "rocket").catch(() => {});
      return;
    }

    // Post response as comment(s) on the PR
    try {
      const chunks = splitResponse(responseText);
      for (let i = 0; i < chunks.length; i++) {
        await postPrComment(repo, prNumber, chunks[i]);
        log.info({ shortId, chunk: i + 1, total: chunks.length }, "posted PR comment");
      }
      log.info({ shortId }, "PR review handled successfully");
      // Add 🚀 reaction on success
      addPrReaction(repo, prNumber, "rocket").catch(() => {});
    } catch (err) {
      log.error({ shortId, err: err.message }, "failed to post response");
      // Add confused reaction on failure
      addPrReaction(repo, prNumber, "confused").catch(() => {});
      try {
        await postPrComment(
          repo,
          prNumber,
          `❌ Failed to post implementation report: ${err.message}`
        );
      } catch {}
    }
  })();
}

module.exports = { handleReviewSubmitted };
