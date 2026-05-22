const gh = require("../utils/gh");
const { agentRunner } = require("../lib/runner");
const { register } = require("../lib/registry");
const { issueSessionPath } = require("../sessions");
const { matchesIssueComment, isCommandComment } = require("../lib/command-utils");

register("issue-comment", matches, handler);

function matches(payload, eventType) {
  if (!matchesIssueComment(payload, eventType)) return false;

  // Don't handle command comments (those are routed to issue-command-comment)
  if (isCommandComment(payload)) return false;

  return true;
}

async function handler(payload) {
  const repo = payload.repository.full_name;
  const issueNumber = payload.issue.number;
  const commentId = payload.comment.id;

  // Only process issues that have the "has-agent" label
  const hasAgent = await gh.issueHasLabel(repo, issueNumber, "has-agent");
  if (!hasAgent) return;

  const sessionPath = issueSessionPath(issueNumber);
  const prompt = payload.comment.body || "";

  await agentRunner({
    sessionPath,
    prompt,
    gh,
    postTo: { type: "issue", repo, number: issueNumber },
    reactTo: { type: "comment", repo, id: commentId },
    providerEnv: "PI_ISSUE",
    timeoutMs: 5 * 60 * 1000,
  });
}
