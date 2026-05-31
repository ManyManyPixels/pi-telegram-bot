import { createLogger } from "../utils/logger.js";
import type { EventContext } from "./types.js";

const log = createLogger("events/pr-review-comment");

export async function handle(
  payload: Record<string, any>,
  { getOrCreateSession, isBot }: EventContext,
): Promise<void> {
  const { repository, pull_request, comment } = payload;

  // Skip bot comments
  if (isBot(comment?.user)) {
    log.info({ user: comment?.user?.login }, "skipping bot review comment");
    return;
  }

  const num: number = pull_request.number;
  const prompt: string = (comment?.body || "").trim();

  if (!prompt) return;

  const owner: string = repository.owner.login;
  const repo: string = repository.name;

  const entry = await getOrCreateSession(owner, repo, "pr", num);
  if (entry.busy) {
    await entry.session.followUp(prompt);
  } else {
    await entry.session.prompt(prompt);
  }

  log.info({ owner, repo, num }, "PR review comment event processed");
}
