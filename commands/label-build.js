const gh = require("../utils/gh");
const { agentRunner } = require("../lib/runner");
const { register } = require("../lib/registry");
const { issueSessionPath } = require("../sessions");

const TARGET_REPO = (process.env.GITHUB_ISSUE_REPO || "alexfi/flow").trim();

// Prevent duplicate builds on the same issue
const running = new Set();

register("label-build", matches, handler);

function matches(payload, eventType) {
  if (eventType !== "issues") return false;
  if (payload.repository?.full_name !== TARGET_REPO) return false;

  const action = payload.action;
  const label = payload.label?.name;
  const labels = payload.issue?.labels || [];

  return (
    (action === "labeled" && label === "ready-to-build") ||
    (action === "opened" && labels.some((l) => l.name === "ready-to-build"))
  );
}

async function handler(payload) {
  const repo = payload.repository.full_name;
  const issue = payload.issue;
  const issueNumber = issue.number;
  const issueUrl = issue.html_url;
  const issueKey = `${repo}#${issueNumber}`;

  if (running.has(issueKey)) return;
  running.add(issueKey);

  const sessionPath = issueSessionPath(issueNumber);
  const prompt =
    `/code-write ${issueUrl} understand this plan, ` +
    `check comments if there are any. Implement the plan.`;

  await agentRunner({
    sessionPath,
    prompt,
    gh,
    postTo: { type: "issue", repo, number: issueNumber },
    reactTo: { type: "issue", repo, number: issueNumber },
    providerEnv: "PI_BUILD",
    timeoutMs: 30 * 60 * 1000,
    emptyResponseOk: true,
    emptyResponseMessage: "✅ Implementation complete (changes applied and pushed).",
    onSuccess: async () => {
      await gh.removeLabel(repo, issueNumber, "ready-to-build");
      await gh.addLabels(repo, issueNumber, "has-agent");
    },
    onFailure: async () => {
      await gh.removeLabel(repo, issueNumber, "ready-to-build").catch(() => {});
    },
  });

  running.delete(issueKey);
}
