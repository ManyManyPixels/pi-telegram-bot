const path = require("path");
const { createLogger } = require("../utils/logger");

const log = createLogger("registry");

/** @type {Array<{name: string, matches: Function, handler: Function}>} */
const commands = [];

/**
 * Register a command. Called by command modules at require() time.
 *
 * @param {string}   name     - Display name for logging
 * @param {Function} matches  - (payload, eventType) => boolean
 * @param {Function} handler  - (payload) => Promise<void>
 */
function register(name, matches, handler) {
  commands.push({ name, matches, handler });
  log.info({ name }, "command registered");
}

/**
 * Auto-discover and require all command modules in the commands/ directory.
 * Each module self-registers via register() at import time.
 */
function autoRegister() {
  const fs = require("fs");
  const dir = path.join(__dirname, "..", "commands");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    require(path.join(dir, file));
  }
  log.info({ count: commands.length }, "commands auto-registered");
}

/**
 * Dispatch a webhook payload to all matching commands.
 * Matching handlers run concurrently (fire-and-forget).
 *
 * @param {object} payload   - Parsed webhook payload
 * @param {string} eventType - X-GitHub-Event header value
 */
function dispatch(payload, eventType) {
  for (const cmd of commands) {
    if (cmd.matches(payload, eventType)) {
      log.info({ command: cmd.name, eventType }, "dispatch");
      cmd.handler(payload).catch((err) =>
        log.error({ command: cmd.name, eventType, err }, "command handler failed")
      );
    }
  }
}

module.exports = { register, autoRegister, dispatch };
