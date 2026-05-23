const gh = require("../utils/gh");
const { agentRunner } = require("../lib/runner");
const { register } = require("../lib/registry");
const { prSessionPath } = require("../sessions");
const {
  matchesCommandOnPr,
  matchesCommandOnReview,
  parseCommand,
  parseReviewCommand,
  extractPrNumber,
} = require("../lib/command-utils");

register("quick-fix", matches, handler);

function matches(payload, eventType) {
  return (
    matchesCommandOnPr(payload, eventType, "quick-fix") ||
    matchesCommandOnReview(payload, eventType, "quick-fix")
  );
}

async function handler(payload) {
  const repo = payload.repository.full_name;

  // Determine event type from payload shape
  const isReviewComment = !!(payload.pull_request && !payload.issue);
  const evtType = isReviewComment ? "pull_request_review_comment" : "issue_comment";

  const prNumber = extractPrNumber(payload, evtType);

  if (!prNumber) {
    // Shouldn't happen if matches returned true, but be safe
    return;
  }

  // Parse the command based on event type
  const { prompt } = isReviewComment
    ? parseReviewCommand(payload)
    : parseCommand(payload);

  const commentId = payload.comment.id;
  const sessionPath = prSessionPath(`${prNumber}-quickfix`);

  // Build the target objects for posting and reacting
  const reactTo = isReviewComment
    ? { type: "review-comment", repo, id: commentId }
    : { type: "comment", repo, id: commentId };

  const postTo = isReviewComment
    ? { type: "review-comment", repo, number: prNumber, commentId }
    : { type: "pr", repo, number: prNumber };

  const fullPrompt = `Invoke the quick-fix subagent to handle this PR quick-fix request. The
subagent runs with the fast model and will evaluate the request, then either
ask clarifying questions or implement the fix.

Pass this task to the subagent tool:

Repository: ${repo}
PR: #${prNumber}
Comment ID: ${commentId}
User request: ${prompt || "(no additional details provided)"}

Get the PR, linked issues, and the trigger comment. Evaluate the quick-fix
request and act on it. Return a concise report.`;

  await agentRunner({
    sessionPath,
    prompt: fullPrompt,
    gh,
    postTo,
    reactTo,
    providerEnv: "PI_QUICKFIX",
    timeoutMs: 10 * 60 * 1000, // 10 minutes
  });
}
