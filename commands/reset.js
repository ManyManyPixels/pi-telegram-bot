const fs = require("fs");
const gh = require("../utils/gh");
const { register } = require("../lib/registry");
const { issueSessionPath } = require("../sessions");
const { matchesCommand } = require("../lib/command-utils");
const { createLogger } = require("../utils/logger");

const log = createLogger("reset");

register("reset", matches, handler);

function matches(payload, eventType) {
  return matchesCommand(payload, eventType, "reset");
}

async function handler(payload) {
  const repo = payload.repository.full_name;
  const issueNumber = payload.issue.number;
  const sessionPath = issueSessionPath(issueNumber);

  try {
    let existed = false;

    // Remove the session JSONL file if it exists
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
      existed = true;
    }

    // Also remove any session directory (e.g. issue-77/)
    const sessionDir = sessionPath.replace(/\.jsonl$/, "");
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      existed = true;
    }

    if (existed) {
      await gh.postComment(
        repo,
        issueNumber,
        "🔄 **Session reset.**\n\nThe session history for this issue has been cleared. The next command will start with a fresh context.",
      );
    } else {
      await gh.postComment(
        repo,
        issueNumber,
        "ℹ️ **No active session found** for this issue. Nothing to reset.",
      );
    }

    log.info({ repo, issueNumber }, "session reset");
  } catch (err) {
    log.error({ err: err.message }, "failed to reset session");
    await gh.postComment(
      repo,
      issueNumber,
      `❌ Failed to reset session: ${err.message}`,
    );
  }
}
