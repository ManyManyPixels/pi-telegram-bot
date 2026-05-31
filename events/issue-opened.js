import { execFile } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(__dirname, "..", "get_issue_content.sh");
const log = createLogger("events/issue-opened");

/**
 * Handle `issues` / `opened` webhook event.
 * Skips PRs (they're handled by the pull_request event).
 */
export async function handle(payload, { getOrCreateSession }) {
  const { repository, issue } = payload;

  // PRs opened as "issues" are handled by the pull_request event
  if (issue?.pull_request) return;

  const owner = repository.owner.login;
  const repo = repository.name;
  const num = issue.number;
  const url =
    issue.html_url || `https://github.com/${owner}/${repo}/issues/${num}`;

  const prompt = await fetchIssueContent(url, issue);

  const entry = await getOrCreateSession(owner, repo, "issue", num);
  if (entry.busy) {
    await entry.session.followUp(prompt);
  } else {
    await entry.session.prompt(prompt);
  }

  log.info({ owner, repo, num }, "issue opened event processed");
}

/**
 * Shell out to get_issue_content.sh. Falls back to manual formatting
 * if the script is unavailable or fails.
 */
function fetchIssueContent(url, issue) {
  return new Promise((resolve) => {
    execFile(script, [url], { timeout: 15_000 }, (err, stdout) => {
      if (err) {
        log.warn({ err }, "get_issue_content.sh failed, falling back");
        const title = issue.title || "";
        const bodyText = issue.body || "";
        resolve(`Source Issue: ${url}\n\n# ${title}\n\n${bodyText}`);
        return;
      }
      resolve(stdout.trim());
    });
  });
}
