import { createLogger } from "../utils/logger.js";

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
  const title = issue.title || "";
  const bodyText = issue.body || "";
  const url =
    issue.html_url || `https://github.com/${owner}/${repo}/issues/${num}`;
  const prompt = `Source Issue: ${url}\n\n# ${title}\n\n${bodyText}`;

  const entry = await getOrCreateSession(owner, repo, "issue", num);
  if (entry.busy) {
    await entry.session.followUp(prompt);
  } else {
    await entry.session.prompt(prompt);
  }

  log.info({ owner, repo, num }, "issue opened event processed");
}
