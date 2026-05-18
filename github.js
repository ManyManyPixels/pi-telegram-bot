const crypto = require("crypto");
const { createLogger } = require("./utils/logger");

const log = createLogger("github");

const SECRET = (process.env.GITHUB_WEBHOOK_SECRET || "").trim();

// Log secret status on startup
if (SECRET) {
  log.info({ secretLen: SECRET.length }, "github webhook secret configured");
} else {
  log.warn("GITHUB_WEBHOOK_SECRET not set — webhook will reject all requests");
}

// ── Webhook signature verification ───────────────────────────────────

/**
 * Verify GitHub's X-Hub-Signature-256 header against our secret.
 * Uses timing-safe comparison.
 */
function verifySignature(signatureHeader, payload) {
  if (!signatureHeader || !SECRET) {
    log.warn(
      { hasSig: !!signatureHeader, hasSecret: !!SECRET },
      "missing signature header or secret"
    );
    return false;
  }
  try {
    const computed = "sha256=" + crypto
      .createHmac("sha256", SECRET)
      .update(payload, "utf8")
      .digest("hex");

    const expected = signatureHeader.trim();

    if (computed.length !== expected.length) {
      log.warn(
        { computedLen: computed.length, expectedLen: expected.length },
        "signature length mismatch"
      );
    }

    const valid = crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(expected)
    );

    if (!valid) {
      log.warn(
        {
          computedPrefix: computed.slice(0, 14) + "...",
          expectedPrefix: expected.slice(0, 14) + "...",
          secretLen: SECRET.length,
          payloadLen: payload.length,
          payloadPreview: payload.slice(0, 80),
        },
        "signature mismatch — check GITHUB_WEBHOOK_SECRET matches GitHub webhook settings"
      );
    }

    return valid;
  } catch (err) {
    log.error({ err }, "signature verification error");
    return false;
  }
}

// ── Event formatters ──────────────────────────────────────────────────

function repoLabel(payload) {
  const r = payload.repository;
  return r ? `[${r.full_name}](${r.html_url})` : "a repository";
}

function actorLabel(payload) {
  const sender = payload.sender;
  if (!sender) return "someone";
  return `[${sender.login}](${sender.html_url})`;
}

function formatPush(payload) {
  const ref = (payload.ref || "").replace("refs/heads/", "");
  const commits = payload.commits || [];
  const repo = repoLabel(payload);
  const actor = actorLabel(payload);

  let msg = `\u{1F4E8} **Push** to \`${ref}\` on ${repo} by ${actor}\n`;
  if (commits.length === 0) {
    msg += "_(forced push or deleted branch)_";
  } else {
    const show = commits.slice(-5); // last 5 commits
    for (const c of show) {
      const shortSha = c.id.slice(0, 7);
      const firstLine = (c.message || "").split("\n")[0].slice(0, 80);
      msg += `\n\`${shortSha}\` ${firstLine} — ${c.author?.name || "?"}`;
    }
    if (commits.length > 5) {
      msg += `\n_\u2026 and ${commits.length - 5} more commits_`;
    }
  }
  return msg;
}

function formatIssues(payload) {
  const issue = payload.issue;
  if (!issue) return "";
  const action = payload.action;
  const repo = repoLabel(payload);
  const actor = actorLabel(payload);
  const emoji = action === "opened" ? "\u{1F7E2}" :
                action === "closed" ? "\u{1F534}" :
                action === "reopened" ? "\u{1F7E1}" : "\u2139\uFE0F";
  return `${emoji} **Issue ${action}** [#${issue.number}](${issue.html_url}) "${issue.title}" on ${repo} by ${actor}`;
}

function formatPullRequest(payload) {
  const pr = payload.pull_request;
  if (!pr) return "";
  const action = payload.action;
  const repo = repoLabel(payload);
  const actor = actorLabel(payload);
  const merged = pr.merged ? " \u2705 *merged*" : "";
  const emoji = action === "opened" ? "\u{1F7E3}" :
                action === "closed" ? (pr.merged ? "\u{1F7E3}" : "\u{1F534}") :
                action === "reopened" ? "\u{1F7E1}" : "\u2139\uFE0F";
  return `${emoji} **Pull request ${action}** [#${pr.number}](${pr.html_url}) "${pr.title}" on ${repo} by ${actor}${merged}\n\`${pr.head?.ref || "?"}\` \u2192 \`${pr.base?.ref || "?"}\``;
}

function formatStar(payload) {
  const repo = repoLabel(payload);
  const actor = actorLabel(payload);
  const stars = payload.repository?.stargazers_count ?? "?";
  return `\u2B50 **Starred** ${repo} by ${actor} (total: ${stars})`;
}

function formatFork(payload) {
  const repo = repoLabel(payload);
  const actor = actorLabel(payload);
  const fork = payload.forkee;
  return `\u{1F500} **Forked** ${repo} by ${actor} \u2192 [${fork?.full_name || "?"}](${fork?.html_url || "#"})`;
}

function formatCreate(payload) {
  const refType = payload.ref_type;
  const ref = payload.ref;
  const repo = repoLabel(payload);
  const actor = actorLabel(payload);
  const emoji = refType === "branch" ? "\u{1F33F}" :
                refType === "tag" ? "\u{1F3F7}" : "\u2795";
  return `${emoji} **${refType} ${ref}** created on ${repo} by ${actor}`;
}

function formatDelete(payload) {
  const refType = payload.ref_type;
  const ref = payload.ref;
  const repo = repoLabel(payload);
  const actor = actorLabel(payload);
  return `\u{274C} **${refType} ${ref}** deleted on ${repo} by ${actor}`;
}

function formatRelease(payload) {
  const release = payload.release;
  if (!release) return "";
  const action = payload.action;
  const repo = repoLabel(payload);
  const actor = actorLabel(payload);
  const name = release.name || release.tag_name;
  return `\u{1F680} **Release ${action}** [${name}](${release.html_url}) on ${repo} by ${actor}`;
}

function formatPing(payload) {
  const repo = repoLabel(payload);
  return `\u{1F44B} **Webhook ping** received for ${repo} — webhook is configured correctly!`;
}

// ── Event routing ─────────────────────────────────────────────────────

const EVENT_FORMATTERS = {
  push: formatPush,
  issues: formatIssues,
  pull_request: formatPullRequest,
  star: formatStar,
  fork: formatFork,
  create: formatCreate,
  delete: formatDelete,
  release: formatRelease,
  ping: formatPing,
};

/**
 * Parse a GitHub event and return a human-readable message.
 * Returns null for unhandled event types.
 */
function formatEvent(eventType, payload) {
  const formatter = EVENT_FORMATTERS[eventType];
  if (!formatter) {
    log.debug({ eventType }, "unhandled event type");
    const repo = repoLabel(payload);
    const actor = actorLabel(payload);
    return `\u2139\uFE0F **${eventType}** event on ${repo} by ${actor}`;
  }
  try {
    return formatter(payload);
  } catch (err) {
    log.error({ eventType, err }, "error formatting event");
    return null;
  }
}

module.exports = {
  verifySignature,
  formatEvent,
};
