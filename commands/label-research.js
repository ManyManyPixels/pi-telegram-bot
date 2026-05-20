const { promises: fs } = require("fs");
const path = require("path");
const os = require("os");
const gh = require("../utils/gh");
const { agentRunner } = require("../lib/runner");
const { register } = require("../lib/registry");
const { runPiTurn } = require("../pi");
const { execFilePromise } = require("../utils/exec");

const TARGET_REPO = (process.env.GITHUB_ISSUE_REPO || "").trim();

// Prevent duplicate research on the same issue
const running = new Set();

register("label-research", matches, handler);

function matches(payload, eventType) {
  if (eventType !== "issues") return false;

  const action = payload.action;
  const label = payload.label?.name;
  const labels = payload.issue?.labels || [];

  return (
    (action === "labeled" && label === "needs-research") ||
    (action === "opened" && labels.some((l) => l.name === "needs-research"))
  );
}

async function handler(payload) {
  const repo = payload.repository?.full_name;
  const issue = payload.issue;
  if (!repo || !issue) return;

  // Verify repo matches local git remote
  const ownerRepo = await getOwnerRepo();
  if (!ownerRepo || repo !== ownerRepo) return;

  const issueNumber = issue.number;
  const issueKey = `${repo}#${issueNumber}`;

  if (running.has(issueKey)) return;
  running.add(issueKey);

  const query = issue.body ? `${issue.title}\n\n${issue.body}` : issue.title;

  // Post 👀 reaction
  gh.addIssueReaction(repo, issueNumber, "eyes").catch(() => {});

  let responseText;
  try {
    responseText = await runPiTurn(
      // Use a random session so it doesn't pollute issue sessions
      path.join(os.tmpdir(), `research-${issueNumber}.jsonl`),
      query,
      {
        extensions: true,
        provider: process.env.PI_RESEARCH_PROVIDER || process.env.PI_PROVIDER || "deepseek",
        model: process.env.PI_RESEARCH_MODEL || process.env.PI_MODEL || "deepseek-v4-pro",
        timeoutMs: 30 * 60 * 1000,
        workDir: process.env.PI_WORK_DIR || process.cwd(),
      }
    );
  } catch (err) {
    gh.addIssueReaction(repo, issueNumber, "confused").catch(() => {});
    await gh.postComment(repo, issueNumber, `❌ Research failed: ${err.message}`);
    await gh.removeLabel(repo, issueNumber, "needs-research").catch(() => {});
    running.delete(issueKey);
    return;
  }

  if (!responseText.trim()) {
    gh.addIssueReaction(repo, issueNumber, "confused").catch(() => {});
    await gh.postComment(repo, issueNumber, "❌ Research produced no output.");
    running.delete(issueKey);
    return;
  }

  // Write response to temp file, update issue body
  const tmpFile = path.join(os.tmpdir(), `research-${issueNumber}.md`);
  await fs.writeFile(tmpFile, responseText, "utf8");

  try {
    await gh.updateIssueBody(repo, issueNumber, tmpFile);
    await gh.removeLabel(repo, issueNumber, "needs-research");
    await gh.addLabels(repo, issueNumber, "research,has-agent");
    gh.addIssueReaction(repo, issueNumber, "rocket").catch(() => {});
  } catch (err) {
    gh.addIssueReaction(repo, issueNumber, "confused").catch(() => {});
    await gh.postComment(repo, issueNumber, `❌ Failed to update issue: ${err.message}`);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
    running.delete(issueKey);
  }
}

// ── Git helper ───────────────────────────────────────────────────────

async function getOwnerRepo() {
  try {
    const stdout = await execFilePromise("git", ["remote", "get-url", "origin"], {
      cwd: process.env.PI_WORK_DIR || process.cwd(),
      timeout: 5000,
    });
    const m = stdout.trim().match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}
