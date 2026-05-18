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

function mappingPath(chatId) {
  return path.join(MAPPINGS_DIR, `chat-${chatId}.json`);
}

function getOrCreateSession(chatId) {
  const mp = mappingPath(chatId);
  if (fs.existsSync(mp)) {
    const { uuid } = JSON.parse(fs.readFileSync(mp, "utf8"));
    return { uuid, sessionPath: sessionPathFor(uuid) };
  }
  const uuid = crypto.randomUUID();
  fs.writeFileSync(
    mp,
    JSON.stringify({ uuid, createdAt: new Date().toISOString() })
  );
  return { uuid, sessionPath: sessionPathFor(uuid) };
}

function resetSession(chatId) {
  const uuid = crypto.randomUUID();
  fs.writeFileSync(
    mappingPath(chatId),
    JSON.stringify({ uuid, createdAt: new Date().toISOString() })
  );
  return { uuid, sessionPath: sessionPathFor(uuid) };
}

function sessionPathFor(uuid) {
  return path.join(SESSIONS_DIR, `chat-${uuid}.jsonl`);
}

module.exports = { init, getOrCreateSession, resetSession, sessionPathFor };
