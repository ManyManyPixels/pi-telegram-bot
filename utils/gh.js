const { execFilePromise } = require("./exec");

// ── Issues ───────────────────────────────────────────────────────────

async function addIssueReaction(repo, issueNumber, content) {
  return execFilePromise("gh", [
    "api",
    `repos/${repo}/issues/${issueNumber}/reactions`,
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

async function postComment(repo, issueNumber, body) {
  return execFilePromise("gh", [
    "issue", "comment", String(issueNumber),
    "--repo", repo,
    "--body", body,
  ]);
}

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

async function issueHasLabel(repo, issueNumber, labelName) {
  try {
    const stdout = await execFilePromise("gh", [
      "issue", "view", String(issueNumber),
      "--repo", repo,
      "--json", "labels",
    ]);
    const data = JSON.parse(stdout);
    return (data.labels || []).some((l) => l.name === labelName);
  } catch (err) {
    return false;
  }
}

// ── Pull Requests ────────────────────────────────────────────────────

async function postPrComment(repo, prNumber, body) {
  return execFilePromise("gh", [
    "pr", "comment", String(prNumber),
    "--repo", repo,
    "--body", body,
  ]);
}

async function addPrReaction(repo, prNumber, content) {
  // PR reactions use the issues endpoint (GitHub's API treats PRs as issues)
  return addIssueReaction(repo, prNumber, content);
}

async function addReviewCommentReaction(repo, commentId, content) {
  return execFilePromise("gh", [
    "api",
    `repos/${repo}/pulls/comments/${commentId}/reactions`,
    "-f", `content=${content}`,
    "--silent",
  ]);
}

async function fetchReviewComments(repo, prNumber) {
  const stdout = await execFilePromise("gh", [
    "api",
    `repos/${repo}/pulls/${prNumber}/comments`,
    "-q", ".[] | select(.in_reply_to_id == null) | {id, body, path, line}",
    "--paginate",
  ]);
  const lines = stdout.trim().split("\n").filter(Boolean);
  const comments = [];
  for (const line of lines) {
    try { comments.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return comments;
}

async function replyToReviewComment(repo, prNumber, commentId, body) {
  return execFilePromise("gh", [
    "api",
    `repos/${repo}/pulls/${prNumber}/comments`,
    "-f", `body=${body}`,
    "-f", `in_reply_to_id=${commentId}`,
    "--silent",
  ]);
}

module.exports = {
  addIssueReaction,
  addCommentReaction,
  postComment,
  updateIssueBody,
  removeLabel,
  addLabels,
  issueHasLabel,
  postPrComment,
  addPrReaction,
  addReviewCommentReaction,
  fetchReviewComments,
  replyToReviewComment,
};
