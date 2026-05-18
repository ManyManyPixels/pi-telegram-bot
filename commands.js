const sessions = require("./sessions");
const { research, researchList } = require("./commands/research");

/**
 * Command registry.
 * Each handler receives (chatId, args, ctx) and returns a string response.
 *   chatId  - Telegram chat ID (integer)
 *   args    - remainder of the message after the command name (string)
 *   ctx     - { sessions, pi, telegram } for commands that need them
 *
 * To add a new command, add a key to this object. That's it.
 */
const registry = {
  async reset(chatId, _args, _ctx) {
    const { uuid } = sessions.resetSession(chatId);
    return `Session reset. New session: \`${uuid.slice(0, 8)}\`\u2026`;
  },

  async id(chatId, _args, _ctx) {
    const { uuid } = sessions.getOrCreateSession(chatId);
    return `Chat ID: \`${chatId}\`\nSession: \`${uuid.slice(0, 8)}\`\u2026`;
  },

  research,
  'research-list': researchList,
};

// ── Dispatcher ────────────────────────────────────────────────────────

/**
 * Match a /command from message text. Returns the handler's result, or
 * null if the text doesn't start with / or the command isn't registered.
 */
function dispatch(text, chatId, ctx) {
  const match = text.trim().match(/^\/([\w-]+)\s*(.*)/s);
  if (!match) return null;

  const [, command, args] = match;
  const handler = registry[command];
  if (!handler) return null;

  return handler(chatId, args.trim(), ctx);
}

function hasCommand(text) {
  return /^\//.test(text.trim());
}

module.exports = { registry, dispatch, hasCommand };
