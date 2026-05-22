const gh = require("../utils/gh");
const { register } = require("../lib/registry");
const { matchesCommand } = require("../lib/command-utils");
const { createLogger } = require("../utils/logger");

const log = createLogger("help");

const HELP_TEXT = `**Available commands:**

- \`>research <prompt>\` — Research a topic in the codebase
- \`>implement <prompt>\` — Implement changes
- \`>plan <prompt>\` — Create an implementation plan
- \`>status\` — Show current session status (tokens, cost, model)
- \`>reset\` — Reset the session completely (same as /new)
- \`>help\` — Show this help message`;

register("help", matches, handler);

function matches(payload, eventType) {
  return matchesCommand(payload, eventType, "help");
}

async function handler(payload) {
  const repo = payload.repository.full_name;
  const issueNumber = payload.issue.number;

  try {
    await gh.postComment(repo, issueNumber, HELP_TEXT);
    log.info({ repo, issueNumber }, "help posted");
  } catch (err) {
    log.error({ err: err.message }, "failed to post help");
  }
}
