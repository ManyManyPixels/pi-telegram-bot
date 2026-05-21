const gh = require("../utils/gh");
const { agentRunner } = require("../lib/runner");
const { register } = require("../lib/registry");
const { issueSessionPath } = require("../sessions");

const TARGET_REPO = (process.env.GITHUB_ISSUE_REPO || "alexfi/flow").trim();
const BOT_USERNAME = (process.env.GITHUB_BOT_USERNAME || "").trim();

register("issue-comment", matches, handler);

function matches(payload, eventType) {
  if (eventType !== "issue_comment") return false;
  if (payload.action !== "created") return false;

  const repo = payload.repository?.full_name;
  if (repo !== TARGET_REPO) return false;

  // Skip PR comments
  if (payload.issue?.pull_request) return false;

  // Skip bot's own comments
  const author = payload.comment?.user?.login || "";
  if (BOT_USERNAME && author === BOT_USERNAME) return false;

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
