const { execFile } = require("child_process");
const { createLogger } = require("../utils/logger");
const { prSessionPath } = require("../sessions");
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
const WORK_DIR = process.env.PI_WORK_DIR || process.cwd();

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

async function addCommentReaction(repo, commentId, content) {
  return execFilePromise("gh", [
    "api",
    `repos/${repo}/issues/comments/${commentId}/reactions`,
    "-f", `content=${content}`,
    "--silent",
  ]);
}

async function addReviewCommentReaction(repo, commentId, content) {
  return execFilePromise("gh", [
    "api",
    `repos/${repo}/pulls/comments/${commentId}/reactions`,
    "-f", `content=${content}`,
    "--silent",
  ]);
}

/**
 * Fetch all review comments on a PR and post 👀 reactions to each
 * unresolved one. Handles both inline review comments and top-level
 * issue comments.
 */
async function reactToUnresolvedComments(repo, prNumber) {
  try {
    const stdout = await execFilePromise("gh", [
      "api",
      `repos/${repo}/pulls/${prNumber}/comments`,
      "-q", ".[] | select(.in_reply_to_id == null) | {id, body, path, line}",
      "--paginate",
    ]);
    // gh api with -q returns JSON lines when paginating without --jq
    const lines = stdout.trim().split("\n").filter(Boolean);
    let count = 0;
    for (const line of lines) {
      try {
        const c = JSON.parse(line);
        await addReviewCommentReaction(repo, c.id, "eyes");
        count++;
        log.debug({ prNumber, commentId: c.id, path: c.path, line: c.line }, "reacted to review comment");
      } catch { /* skip malformed lines */ }
    }
    if (count > 0) {
      log.info({ prNumber, count }, "reacted to review comments");
    }
  } catch (err) {
    log.warn({ prNumber, err: err.message }, "failed to fetch/react to review comments");
  }
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
    // Persistent session for this PR
    const sessionPath = prSessionPath(prNumber);

    // Launch default pi with /code-write prefix so it auto-loads the code-write skill.
    const prompt =
      `/code-write ${prUrl} get linked issue, get pr comments, ` +
      `implement changes requested in those comments if they are appropriate. ` +
      `Before you begin say thank you for the review, I'll go through them and ` +
      `try to address the comments. after you finish write a comment with summary. ` +
      `if you think that some comments are irrelevant or needs clarification reply to them.`;

    log.info(
      { shortId, prNumber, promptLen: prompt.length },
      "spawning PR review agent"
    );

    // Acknowledge with 👀 reaction
    addPrReaction(repo, prNumber, "eyes").catch((err) =>
      log.warn({ shortId, err: err.message }, "failed to post eyes reaction")
    );

    let responseText;
    try {
      responseText = await runPiTurn(sessionPath, prompt, {
        extensions: true,
        provider: PROVIDER,
        model: MODEL,
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

// ── PR Comment handler ────────────────────────────────────────────────

/**
 * Handle an issue_comment webhook event on a pull request.
 * Called from server.js when an issue_comment event is received and
 * the issue is actually a PR (issue.pull_request exists).
 *
 * Treats the comment as an implementation request — same as a review
 * requesting changes, but prompted from the comment body instead of
 * review feedback.
 *
 * @param {object} payload - The full issue_comment webhook payload
 */
async function handlePrComment(payload) {
  const repo = payload.repository?.full_name;
  const action = payload.action;
  const issue = payload.issue;
  const comment = payload.comment;
  if (!repo || !issue || !comment) {
    log.warn("missing repo/issue/comment in pr comment payload");
    return;
  }

  // Guard: only handle target repo
  if (repo !== TARGET_REPO) {
    log.debug({ repo }, "skipping non-target repo (pr comment)");
    return;
  }

  // Guard: only "created" actions (not edited/deleted)
  if (action !== "created") {
    log.debug({ action }, "skipping non-created pr comment action");
    return;
  }

  // Guard: skip bot's own comments (loop prevention)
  const commentAuthor = comment.user?.login || "";
  if (BOT_USERNAME && commentAuthor === BOT_USERNAME) {
    log.debug({ commentAuthor }, "skipping bot's own pr comment");
    return;
  }

  const prNumber = issue.number;
  const prUrl = issue.html_url || issue.pull_request?.html_url;
  const commentBody = comment.body || "";
  const shortId = Math.random().toString(36).slice(2, 10);

  log.info(
    { shortId, repo, prNumber, author: commentAuthor },
    "processing PR comment as implementation request"
  );

  // Post 👀 reaction on the triggering comment
  addCommentReaction(repo, comment.id, "eyes").catch((err) =>
    log.warn({ shortId, err: err.message }, "failed to post eyes reaction on pr comment")
  );

  // React to all unresolved review comments on the PR
  reactToUnresolvedComments(repo, prNumber);

  // Fire-and-forget the agent work
  (async () => {
    const sessionPath = prSessionPath(prNumber);

    // Launch default pi with /code-write prefix so it auto-loads the code-write skill.
    // Include the comment body so the agent knows what to implement.
    const prompt =
      `/code-write ${prUrl} get linked issue, get pr comments, implement changes ` +
      `requested in those comments if they are appropriate. The contributor said: ` +
      `"${commentBody.replace(/"/g, "'")}". Before you begin say thank you for the ` +
      `review, I'll go through them and try to address the comments. after you finish ` +
      `write a comment with summary. if you think that some comments are irrelevant ` +
      `or needs clarification reply to them.`;

    log.info(
      { shortId, prNumber, promptLen: prompt.length },
      "spawning PR comment agent"
    );

    let responseText;
    try {
      responseText = await runPiTurn(sessionPath, prompt, {
        extensions: true,
        provider: PROVIDER,
        model: MODEL,
        workDir: WORK_DIR,
        timeoutMs: AGENT_TIMEOUT_MS,
      });
    } catch (err) {
      log.error({ shortId, err: err.message }, "pr comment agent failed");
      addPrReaction(repo, prNumber, "confused").catch(() => {});
      try {
        await postPrComment(
          repo,
          prNumber,
          `❌ Something went wrong while implementing: ${err.message}`
        );
      } catch (e) {
        log.error({ shortId, err: e.message }, "failed to post error comment");
      }
      return;
    }

    if (!responseText.trim()) {
      log.warn({ shortId }, "pr comment agent returned empty response");
      try {
        await postPrComment(
          repo,
          prNumber,
          "✅ Changes applied and pushed."
        );
      } catch (e) {
        log.error({ shortId, err: e.message }, "failed to post empty-response comment");
      }
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
      log.info({ shortId }, "PR comment handled successfully");
      addPrReaction(repo, prNumber, "rocket").catch(() => {});
    } catch (err) {
      log.error({ shortId, err: err.message }, "failed to post pr comment response");
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

module.exports = { handleReviewSubmitted, handlePrComment };
