const gh = require("../utils/gh");
const { agentRunner } = require("../lib/runner");
const { register } = require("../lib/registry");
const { prSessionPath } = require("../sessions");

const TARGET_REPO = (process.env.GITHUB_ISSUE_REPO || "alexfi/flow").trim();
const BOT_USERNAME = (process.env.GITHUB_BOT_USERNAME || "").trim();

register("pr-review-agent", matches, handler);

function matches(payload, eventType) {
  const repo = payload.repository?.full_name;
  if (repo !== TARGET_REPO) return false;

  // PR review submitted
  if (eventType === "pull_request_review") {
    if (payload.action !== "submitted") return false;
    const reviewState = payload.review?.state;
    if (reviewState !== "changes_requested" && reviewState !== "commented") return false;
    const author = payload.review?.user?.login || "";
    if (BOT_USERNAME && author === BOT_USERNAME) return false;
    return true;
  }

  // PR comment
  if (eventType === "issue_comment") {
    if (payload.action !== "created") return false;
    if (!payload.issue?.pull_request) return false;
    const author = payload.comment?.user?.login || "";
    if (BOT_USERNAME && author === BOT_USERNAME) return false;
    return true;
  }

  return false;
}

async function handler(payload) {
  const repo = payload.repository.full_name;

  // Determine which type of event
  if (payload.pull_request_review || payload.review) {
    return handleReviewSubmitted(payload, repo);
  }
  if (payload.comment && payload.issue?.pull_request) {
    return handlePrComment(payload, repo);
  }
}

// ── PR review submitted ──────────────────────────────────────────────

async function handleReviewSubmitted(payload, repo) {
  const pr = payload.pull_request;
  const prNumber = pr.number;
  const prUrl = pr.html_url;

  const sessionPath = prSessionPath(prNumber);
  const prompt =
    `/code-write ${prUrl} get linked issue, get pr comments, ` +
    `implement changes requested in those comments if they are appropriate. ` +
    `Before you begin say thank you for the review, I'll go through them and ` +
    `try to address the comments. after you finish write a comment with summary. ` +
    `if you think that some comments are irrelevant or needs clarification reply to them.`;

  await agentRunner({
    sessionPath,
    prompt,
    gh,
    postTo: { type: "pr", repo, number: prNumber },
    reactTo: { type: "pr", repo, number: prNumber },
    providerEnv: "PI_PR_REVIEW",
    timeoutMs: 10 * 60 * 1000,
  });
}

// ── PR comment ───────────────────────────────────────────────────────

async function handlePrComment(payload, repo) {
  const prNumber = payload.issue.number;
  const prUrl = payload.issue.html_url || payload.issue.pull_request?.html_url;
  const commentBody = (payload.comment?.body || "").replace(/"/g, "'");
  const commentId = payload.comment.id;

  // React to all unresolved review comments
  reactToUnresolvedComments(repo, prNumber);

  const sessionPath = prSessionPath(prNumber);
  const prompt =
    `/code-write ${prUrl} get linked issue, get pr comments, implement changes ` +
    `requested in those comments if they are appropriate. The contributor said: ` +
    `"${commentBody}". Before you begin say thank you for the review, ` +
    `I'll go through them and try to address the comments. after you finish ` +
    `write a comment with summary. if you think that some comments are irrelevant ` +
    `or needs clarification reply to them.`;

  await agentRunner({
    sessionPath,
    prompt,
    gh,
    postTo: { type: "pr", repo, number: prNumber },
    reactTo: { type: "comment", repo, id: commentId },
    providerEnv: "PI_PR_REVIEW",
    timeoutMs: 10 * 60 * 1000,
  });
}

// ── React to unresolved review comments ──────────────────────────────

async function reactToUnresolvedComments(repo, prNumber) {
  try {
    const comments = await gh.fetchReviewComments(repo, prNumber);
    for (const c of comments) {
      gh.addReviewCommentReaction(repo, c.id, "eyes").catch(() => {});
    }
  } catch {
    // best-effort
  }
}
