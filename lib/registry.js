const { createLogger } = require("../utils/logger");

const log = createLogger("registry");

/** @type {Array<{name: string, matches: Function, handler: Function}>} */
const commands = [];

function register(name, matches, handler) {
  commands.push({ name, matches, handler });
  log.info({ name }, "command registered");
}

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

module.exports = { register, dispatch };
