import { execFile } from "child_process";
import crypto from "crypto";
import { createLogger } from "./utils/logger.js";

const log = createLogger("github");

const SECRET = (process.env.GITHUB_WEBHOOK_SECRET || "").trim();
const BOT_USERNAME = (process.env.GITHUB_BOT_USERNAME || "").trim();

if (SECRET) {
  log.info({ secretLen: SECRET.length }, "github webhook secret configured");
} else {
  log.warn("GITHUB_WEBHOOK_SECRET not set — webhook will reject all requests");
}

if (BOT_USERNAME) {
  log.info({ bot: BOT_USERNAME }, "bot username configured");
} else {
  log.warn("GITHUB_BOT_USERNAME not set — bot comment filtering may not work");
}

/** GitHub user object shape from webhook payloads. */
export interface GitHubUser {
  login: string;
  type: string;
}

/**
 * Verify GitHub's X-Hub-Signature-256 header against our secret.
 */
export function verifySignature(signatureHeader: string | undefined, payload: string): boolean {
  if (!signatureHeader || !SECRET) {
    log.warn(
      { hasSig: !!signatureHeader, hasSecret: !!SECRET },
      "missing signature header or secret",
    );
    return false;
  }
  try {
    const computed = `sha256=${crypto.createHmac("sha256", SECRET).update(payload, "utf8").digest("hex")}`;

    const expected = signatureHeader.trim();

    if (computed.length !== expected.length) {
      log.warn(
        { computedLen: computed.length, expectedLen: expected.length },
        "signature length mismatch",
      );
    }

    const valid = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected));

    if (!valid) {
      log.warn("signature mismatch");
    }

    return valid;
  } catch (err) {
    log.error({ err }, "signature verification error");
    return false;
  }
}

/**
 * Returns true if the comment author is a bot that should be ignored.
 * Filters the configured bot account AND any GitHub user with type "Bot"
 * (github-actions[bot], dependabot, etc.).
 */
export function isBot(user: GitHubUser | undefined): boolean {
  if (!user) return true;
  if (BOT_USERNAME && user.login === BOT_USERNAME) return true;
  if (user.type === "Bot") return true;
  return false;
}

/** GitHub reaction emoji names (as accepted by the API). */
export type Reaction = "eyes" | "+1" | "-1" | "rocket" | "heart" | "hooray" | "laugh" | "confused";

/**
 * Add an emoji reaction to a GitHub issue or pull request via `gh api`.
 */
export function reactToIssue(
  owner: string,
  repo: string,
  number: number,
  reaction: Reaction,
): Promise<void> {
  return ghApiReaction(`repos/${owner}/${repo}/issues/${number}/reactions`, reaction);
}

/**
 * Add an emoji reaction to a GitHub issue comment via `gh api`.
 */
export function reactToIssueComment(
  owner: string,
  repo: string,
  commentId: number,
  reaction: Reaction,
): Promise<void> {
  return ghApiReaction(`repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, reaction);
}

/**
 * Add an emoji reaction to a GitHub PR review comment via `gh api`.
 */
export function reactToPRReviewComment(
  owner: string,
  repo: string,
  commentId: number,
  reaction: Reaction,
): Promise<void> {
  return ghApiReaction(`repos/${owner}/${repo}/pulls/comments/${commentId}/reactions`, reaction);
}

function ghApiReaction(endpoint: string, reaction: Reaction): Promise<void> {
  return new Promise((resolve) => {
    const _child = execFile(
      "gh",
      ["api", endpoint, "-f", `content=${reaction}`, "--silent"],
      { timeout: 10_000 },
      (err) => {
        if (err) {
          log.warn({ err, endpoint, reaction }, "gh reaction failed");
          resolve(); // fire-and-forget, never reject
        }
        resolve();
      },
    );
  });
}

/**
 * Post a comment on a GitHub issue or pull request via the `gh` CLI.
 */
export function postComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const repoSlug = `${owner}/${repo}`;
    log.info({ repo: repoSlug, number }, "posting comment");

    const _child = execFile(
      "gh",
      ["issue", "comment", String(number), "--repo", repoSlug, "--body", body],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          log.error({ err, stderr }, "gh comment failed");
          reject(err);
        } else {
          log.info({ stdout: stdout.trim() }, "comment posted");
          resolve(stdout.trim());
        }
      },
    );
  });
}
