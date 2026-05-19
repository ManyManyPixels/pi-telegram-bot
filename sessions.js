const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createLogger } = require("./utils/logger");

const log = createLogger("sessions");

const LOGS_DIR = path.join(__dirname, "logs");
const SESSIONS_DIR = path.resolve(
  process.env.PI_SESSION_DIR || path.join(LOGS_DIR, "sessions")
);
const MAPPINGS_DIR = path.join(LOGS_DIR, "mappings");

function init() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(MAPPINGS_DIR, { recursive: true });
}

function sessionPathFor(uuid) {
  return path.join(SESSIONS_DIR, `chat-${uuid}.jsonl`);
}

// ── Chat (Telegram) sessions ─────────────────────────────────────────

function chatMappingPath(chatId) {
  return path.join(MAPPINGS_DIR, `chat-${chatId}.json`);
}

function getOrCreateSession(chatId) {
  const mp = chatMappingPath(chatId);
  if (fs.existsSync(mp)) {
    const { uuid } = JSON.parse(fs.readFileSync(mp, "utf8"));
    return { uuid, sessionPath: sessionPathFor(uuid), isNew: false };
  }
  const uuid = crypto.randomUUID();
  fs.writeFileSync(
    mp,
    JSON.stringify({ uuid, createdAt: new Date().toISOString() })
  );
  return { uuid, sessionPath: sessionPathFor(uuid), isNew: true };
}

function resetSession(chatId) {
  const uuid = crypto.randomUUID();
  fs.writeFileSync(
    chatMappingPath(chatId),
    JSON.stringify({ uuid, createdAt: new Date().toISOString() })
  );
  return { uuid, sessionPath: sessionPathFor(uuid) };
}

// ── Issue sessions ───────────────────────────────────────────────────

function issueMappingPath(issueNumber) {
  return path.join(MAPPINGS_DIR, `issue-${issueNumber}.json`);
}

/**
 * Get or create a persistent session for a GitHub issue.
 * Returns { uuid, sessionPath, isNew } — isNew is true if the session
 * was just created (first time this issue has been seen).
 */
function getOrCreateIssueSession(issueNumber) {
  const mp = issueMappingPath(issueNumber);
  if (fs.existsSync(mp)) {
    const { uuid } = JSON.parse(fs.readFileSync(mp, "utf8"));
    return { uuid, sessionPath: sessionPathFor(uuid), isNew: false };
  }
  const uuid = crypto.randomUUID();
  fs.writeFileSync(
    mp,
    JSON.stringify({ uuid, issueNumber, createdAt: new Date().toISOString() })
  );
  return { uuid, sessionPath: sessionPathFor(uuid), isNew: true };
}

/**
 * Reset the session for a GitHub issue (new UUID, fresh .jsonl).
 */
function resetIssueSession(issueNumber) {
  const uuid = crypto.randomUUID();
  fs.writeFileSync(
    issueMappingPath(issueNumber),
    JSON.stringify({ uuid, issueNumber, createdAt: new Date().toISOString() })
  );
  return { uuid, sessionPath: sessionPathFor(uuid) };
}

// ── PR sessions ──────────────────────────────────────────────────────

function prMappingPath(prNumber) {
  return path.join(MAPPINGS_DIR, `pr-${prNumber}.json`);
}

/**
 * Get or create a persistent session for a GitHub pull request.
 * Returns { uuid, sessionPath, isNew } — isNew is true if the session
 * was just created (first time this PR has been seen).
 */
function getOrCreatePrSession(prNumber) {
  const mp = prMappingPath(prNumber);
  if (fs.existsSync(mp)) {
    const { uuid } = JSON.parse(fs.readFileSync(mp, "utf8"));
    return { uuid, sessionPath: sessionPathFor(uuid), isNew: false };
  }
  const uuid = crypto.randomUUID();
  fs.writeFileSync(
    mp,
    JSON.stringify({ uuid, prNumber, createdAt: new Date().toISOString() })
  );
  return { uuid, sessionPath: sessionPathFor(uuid), isNew: true };
}

/**
 * Reset the session for a GitHub PR (new UUID, fresh .jsonl).
 */
function resetPrSession(prNumber) {
  const uuid = crypto.randomUUID();
  fs.writeFileSync(
    prMappingPath(prNumber),
    JSON.stringify({ uuid, prNumber, createdAt: new Date().toISOString() })
  );
  return { uuid, sessionPath: sessionPathFor(uuid) };
}

module.exports = {
  init,
  getOrCreateSession,
  resetSession,
  getOrCreateIssueSession,
  resetIssueSession,
  getOrCreatePrSession,
  resetPrSession,
  sessionPathFor,
};
