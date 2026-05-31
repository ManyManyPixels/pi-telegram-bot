import { createLogger } from "../utils/logger.js";

const log = createLogger("events/issue-comment");

/**
 * Handle `issue_comment` / `created` webhook event.
 * Works for both issues and PRs.
 */
export async function handle(payload, { getOrCreateSession, isBot }) {
  const { repository, issue, comment } = payload;

  // Skip bot comments
  if (isBot(comment?.user)) {
    log.info({ user: comment?.user?.login }, "skipping bot comment");
    return;
  }

  const isPR = !!issue?.pull_request;
  const kind = isPR ? "pr" : "issue";
  const num = issue.number;
  const bodyText = (comment?.body || "").trim();

  if (!bodyText) return;

  const url =
    issue.html_url || `https://github.com/${repository.owner.login}/${repository.name}/issues/${num}`;
  const kindLabel = isPR ? "PR" : "Issue";
  const prompt = `[Comment by @${comment.user.login} on ${kindLabel} #${num}](${url})\n\n${bodyText}`;

  const owner = repository.owner.login;
  const repo = repository.name;
  const entry = await getOrCreateSession(owner, repo, kind, num);
  if (entry.busy) {
    await entry.session.followUp(prompt);
  } else {
    await entry.session.prompt(prompt);
  }

  log.info({ owner, repo, num, kind }, "comment event processed");
}
