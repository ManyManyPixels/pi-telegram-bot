const fs = require("fs");
const gh = require("../utils/gh");
const { agentRunner } = require("../lib/runner");
const { register } = require("../lib/registry");
const { issueSessionPath, prSessionPath } = require("../sessions");
const { matchesComment, isResetCommand } = require("../lib/command-utils");
const { createLogger } = require("../utils/logger");

const log = createLogger("comment");

register("comment", matches, handler);

function matches(payload, eventType) {
  return matchesComment(payload, eventType);
}

async function handler(payload) {
  const repo = payload.repository.full_name;
  const isPr = !!payload.issue?.pull_request;
  const number = payload.issue.number;
  const commentBody = payload.comment.body || "";

  // Check for has-agent label
  const hasAgent = await gh.issueHasLabel(repo, number, "has-agent");
  if (!hasAgent) return;

  // /reset command
  if (isResetCommand(commentBody)) {
    const sessionPath = isPr ? prSessionPath(number) : issueSessionPath(number);
    await handleReset(sessionPath, repo, number, isPr);
    return;
  }

  // Normal comment → pi turn
  const sessionPath = isPr
    ? prSessionPath(number)
    : issueSessionPath(number);

  const prompt = isPr
    ? `You are an AI coding assistant working on Pull Request #${number} in ${repo}.\n\n` +
      `User's comment:\n---\n${commentBody}\n---`
    : commentBody;

  await agentRunner({
    sessionPath,
    prompt,
    gh,
    postTo: { type: isPr ? "pr" : "issue", repo, number },
    timeoutMs: 5 * 60 * 1000,
  });
}

async function handleReset(sessionPath, repo, number, isPr) {
  try {
    let existed = false;

    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
      existed = true;
    }

    // Also remove any session directory
    const sessionDir = sessionPath.replace(/\.jsonl$/, "");
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      existed = true;
    }

    const postFn = isPr ? gh.postPrComment : gh.postComment;

    if (existed) {
      await postFn(repo, number, "🔄 **Session reset.** Starting fresh.");
    } else {
      await postFn(repo, number, "ℹ️ No active session found. Nothing to reset.");
    }

    log.info({ repo, number }, "session reset");
  } catch (err) {
    log.error({ err: err.message }, "reset failed");
  }
}
