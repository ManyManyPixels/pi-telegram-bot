const TARGET_REPO = (process.env.GITHUB_ISSUE_REPO || "alexfi/flow").trim();
const BOT_USERNAME = (process.env.GITHUB_BOT_USERNAME || "").trim();

/**
 * Check if a comment author is a known bot that should be ignored.
 */
function isBotAuthor(login) {
  if (!login) return true;
  if (BOT_USERNAME && login === BOT_USERNAME) return true;
  if (login.endsWith("[bot]") || login === "github-actions") return true;
  return false;
}

/**
 * Determine if this issue_comment event should trigger a pi turn.
 * Requirements:
 *   - issue_comment "created" event
 *   - Targets the configured repo
 *   - Author is not a bot
 *   - Issue/PR has the "has-agent" label
 *   (label check is done separately by the caller via gh.issueHasLabel)
 */
function matchesComment(payload, eventType) {
  if (eventType !== "issue_comment") return false;
  if (payload.action !== "created") return false;

  const repo = payload.repository?.full_name;
  if (repo !== TARGET_REPO) return false;

  const login = payload.comment?.user?.login || "";
  if (isBotAuthor(login)) return false;

  return true;
}

/**
 * Check if the comment is a /reset command (case-insensitive, starts with /reset).
 */
function isResetCommand(body) {
  return /^\/reset\b/i.test(body.trim());
}

module.exports = {
  TARGET_REPO,
  BOT_USERNAME,
  isBotAuthor,
  matchesComment,
  isResetCommand,
};
