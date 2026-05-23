const gh = require("../utils/gh");
const { agentRunner } = require("../lib/runner");
const { register } = require("../lib/registry");
const { prSessionPath } = require("../sessions");
const { matchesPrComment, isCommandComment } = require("../lib/command-utils");

register("pr-comment", matches, handler);

function matches(payload, eventType) {
  if (!matchesPrComment(payload, eventType)) return false;

  // Don't handle command comments (those are routed to quick-fix etc.)
  if (isCommandComment(payload)) return false;

  return true;
}

async function handler(payload) {
  const repo = payload.repository.full_name;
  const prNumber = payload.issue.number;
  const commentId = payload.comment.id;

  const sessionPath = prSessionPath(prNumber);
  const userComment = payload.comment.body || "";

  const prompt = `You are an AI coding assistant working on a Pull Request.

Repository: ${repo}
PR: #${prNumber}

You have full access to the repository — read the PR diff, review the code,
and implement changes directly. Write actual code, don't just describe what
should be done.

User's comment:
---
${userComment}
---`;

  await agentRunner({
    sessionPath,
    prompt,
    gh,
    postTo: { type: "pr", repo, number: prNumber },
    reactTo: { type: "comment", repo, id: commentId },
    providerEnv: "PI_ISSUE",
    timeoutMs: 5 * 60 * 1000,
  });
}
