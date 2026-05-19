const fs = require("fs");
const path = require("path");
const { createLogger } = require("./utils/logger");

const log = createLogger("sessions");

const LOGS_DIR = path.join(__dirname, "logs");
const SESSIONS_DIR = path.resolve(
  process.env.PI_SESSION_DIR || path.join(LOGS_DIR, "sessions")
);

function init() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * GitHub issue session path.
 * Keyed directly by issue number.
 */
function issueSessionPath(issueNumber) {
  return path.join(SESSIONS_DIR, `issue-${issueNumber}.jsonl`);
}

/**
 * GitHub pull request session path.
 * Keyed directly by PR number.
 */
function prSessionPath(prNumber) {
  return path.join(SESSIONS_DIR, `pr-${prNumber}.jsonl`);
}

module.exports = {
  init,
  issueSessionPath,
  prSessionPath,
};
