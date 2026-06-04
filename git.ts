import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { PI_WORK_BASE } from "./constants.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("git");

/**
 * Derive the work directory path for a given repo.
 */
export function workdirFor(owner: string, repo: string): string {
  return path.resolve(PI_WORK_BASE, owner, repo);
}

/**
 * Resolve the git ref to check out from a webhook event.
 *
 * - Pure issues → default branch (e.g. "main")
 * - PR events → "pull/{N}/head" (GitHub's special ref for PRs, works for forks too)
 * - Issue comments on PRs → fetches PR details via `gh api` to get the PR number
 */
export async function resolveBranch(
  eventType: string,
  action: string | undefined,
  payload: Record<string, any>,
): Promise<string> {
  // ── Issues: use default branch ─────────────────────────────────
  if (eventType === "issues" && action === "opened") {
    return payload.repository?.default_branch || "main";
  }

  // ── Issue comment: could be on a PR ────────────────────────────
  if (eventType === "issue_comment" && action === "created") {
    if (payload.issue?.pull_request) {
      const prUrl: string = payload.issue.pull_request.url;
      try {
        const prData = await ghApiJson(prUrl);
        if (prData.number) {
          return `pull/${prData.number}/head`;
        }
      } catch {
        log.warn("failed to fetch PR details for issue comment, falling back to default branch");
      }
    }
    return payload.repository?.default_branch || "main";
  }

  // ── PR opened ──────────────────────────────────────────────────
  if (eventType === "pull_request" && action === "opened") {
    const prNumber = payload.pull_request?.number;
    if (prNumber) return `pull/${prNumber}/head`;
    return payload.repository?.default_branch || "main";
  }

  // ── PR review comment ──────────────────────────────────────────
  if (eventType === "pull_request_review_comment" && action === "created") {
    const prNumber = payload.pull_request?.number;
    if (prNumber) return `pull/${prNumber}/head`;
    return payload.repository?.default_branch || "main";
  }

  // ── Fallback ───────────────────────────────────────────────────
  return payload.repository?.default_branch || "main";
}

/**
 * Call `gh api <endpoint>` and return the parsed JSON response.
 */
async function ghApiJson(endpoint: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["api", endpoint, "--jq", "."], { timeout: 10_000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Ensure a repo is cloned and force-checked-out at the given ref.
 *
 * - First encounter → `gh repo clone`
 * - Subsequent events → `git fetch origin <ref>` + `git checkout --force FETCH_HEAD`
 *
 * Returns the absolute path to the repo workdir.
 */
export async function ensureRepo(owner: string, repo: string, ref: string): Promise<string> {
  const dir = workdirFor(owner, repo);
  const repoSlug = `${owner}/${repo}`;

  if (!fs.existsSync(dir)) {
    log.info({ repo: repoSlug, dir }, "cloning repo");
    await fs.promises.mkdir(path.dirname(dir), { recursive: true });
    await execFileAsync("gh", ["repo", "clone", repoSlug, dir], {
      timeout: 120_000,
    });
  }

  // Fetch and force checkout
  log.info({ repo: repoSlug, ref }, "fetching and checking out");
  try {
    await execFileAsync("git", ["fetch", "origin", ref], {
      cwd: dir,
      timeout: 60_000,
    });
    await execFileAsync("git", ["checkout", "--force", "FETCH_HEAD"], {
      cwd: dir,
      timeout: 30_000,
    });
  } catch (err: any) {
    // Empty repo or branch doesn't exist yet — that's fine, return the dir anyway
    if (err?.message?.includes("couldn't find remote ref")) {
      log.info({ repo: repoSlug, ref }, "ref not found (empty repo?), continuing");
    } else {
      throw err;
    }
  }

  return dir;
}

/**
 * Promise wrapper around child_process.execFile.
 */
function execFileAsync(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        log.error({ err, cmd, args, stderr }, "command failed");
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
