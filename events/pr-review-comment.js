import { createLogger } from "../utils/logger.js";

const log = createLogger("events/pr-review-comment");

/**
 * Handle `pull_request_review_comment` / `created` webhook event.
 * Inline review comments on PR diffs.
 */
export async function handle(payload, { getOrCreateSession, isBot }) {
  const { repository, pull_request, comment } = payload;

  // Skip bot comments
  if (isBot(comment?.user)) {
    log.info({ user: comment?.user?.login }, "skipping bot review comment");
    return;
  }

  const num = pull_request.number;
  const prompt = (comment?.body || "").trim();

  if (!prompt) return;

  const owner = repository.owner.login;
  const repo = repository.name;

  const entry = await getOrCreateSession(owner, repo, "pr", num);
  if (entry.busy) {
    await entry.session.followUp(prompt);
  } else {
    await entry.session.prompt(prompt);
  }

  log.info({ owner, repo, num }, "PR review comment event processed");
}
