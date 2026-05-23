const TARGET_REPO = (process.env.GITHUB_ISSUE_REPO || "alexfi/flow").trim();
const BOT_USERNAME = (process.env.GITHUB_BOT_USERNAME || "").trim();

/**
 * Shared matching for issue_comment events:
 *   - Must be an issue_comment "created" event
 *   - Must target the configured repo
 *   - Must not be on a pull request
 *   - Must not be the bot's own comment
 */
function matchesIssueComment(payload, eventType) {
  if (eventType !== "issue_comment") return false;
  if (payload.action !== "created") return false;

  const repo = payload.repository?.full_name;
  if (repo !== TARGET_REPO) return false;

  if (payload.issue?.pull_request) return false;

  const author = payload.comment?.user?.login || "";
  if (BOT_USERNAME && author === BOT_USERNAME) return false;

  return true;
}

/**
 * Check if a comment body starts with ">" (after trimming whitespace).
 */
function isCommandComment(payload) {
  const body = (payload.comment?.body || "").trim();
  return body.startsWith(">");
}

/**
 * Parse ">command rest of message" into { command, prompt }.
 * e.g. ">research figure out auth" => { command: "research", prompt: "figure out auth" }
 */
function parseCommand(payload) {
  const body = (payload.comment?.body || "").trim();
  const withoutPrefix = body.slice(1).trim();

  const spaceIdx = withoutPrefix.indexOf(" ");
  if (spaceIdx === -1) {
    return { command: withoutPrefix, prompt: "" };
  }

  return {
    command: withoutPrefix.slice(0, spaceIdx),
    prompt: withoutPrefix.slice(spaceIdx + 1).trim(),
  };
}

/**
 * Combined check: matches issue comment AND matches a specific command name.
 */
function matchesCommand(payload, eventType, commandName) {
  if (!matchesIssueComment(payload, eventType)) return false;
  const { command } = parseCommand(payload);
  return command === commandName;
}

/**
 * Matches issue_comment events on pull requests (not issues).
 */
function matchesPrComment(payload, eventType) {
  if (eventType !== "issue_comment") return false;
  if (payload.action !== "created") return false;

  const repo = payload.repository?.full_name;
  if (repo !== TARGET_REPO) return false;

  // Must be on a PR, not on an issue
  if (!payload.issue?.pull_request) return false;

  const author = payload.comment?.user?.login || "";
  if (BOT_USERNAME && author === BOT_USERNAME) return false;

  return true;
}

/**
 * Matches pull_request_review_comment events.
 */
function matchesReviewComment(payload, eventType) {
  if (eventType !== "pull_request_review_comment") return false;
  if (payload.action !== "created") return false;

  const repo = payload.repository?.full_name;
  if (repo !== TARGET_REPO) return false;

  const author = payload.comment?.user?.login || "";
  if (BOT_USERNAME && author === BOT_USERNAME) return false;

  return true;
}

/**
 * Combined check: matches PR comment AND matches a specific command name.
 */
function matchesCommandOnPr(payload, eventType, commandName) {
  if (!matchesPrComment(payload, eventType)) return false;
  const { command } = parseCommand(payload);
  return command === commandName;
}

/**
 * Combined check: matches review comment AND matches a specific command name.
 */
function matchesCommandOnReview(payload, eventType, commandName) {
  if (!matchesReviewComment(payload, eventType)) return false;
  const body = (payload.comment?.body || "").trim();
  if (!body.startsWith(">")) return false;
  const withoutPrefix = body.slice(1).trim();
  const spaceIdx = withoutPrefix.indexOf(" ");
  const command = spaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIdx);
  return command === commandName;
}

/**
 * Parse a review comment body into { command, prompt }.
 */
function parseReviewCommand(payload) {
  const body = (payload.comment?.body || "").trim();
  const withoutPrefix = body.slice(1).trim();
  const spaceIdx = withoutPrefix.indexOf(" ");
  if (spaceIdx === -1) {
    return { command: withoutPrefix, prompt: "" };
  }
  return {
    command: withoutPrefix.slice(0, spaceIdx),
    prompt: withoutPrefix.slice(spaceIdx + 1).trim(),
  };
}

/**
 * Extract PR number from either event type.
 */
function extractPrNumber(payload, eventType) {
  if (eventType === "pull_request_review_comment") {
    return payload.pull_request?.number;
  }
  return payload.issue?.number;
}

module.exports = {
  TARGET_REPO,
  BOT_USERNAME,
  matchesIssueComment,
  isCommandComment,
  parseCommand,
  matchesCommand,
  matchesPrComment,
  matchesReviewComment,
  matchesCommandOnPr,
  matchesCommandOnReview,
  parseReviewCommand,
  extractPrNumber,
};
