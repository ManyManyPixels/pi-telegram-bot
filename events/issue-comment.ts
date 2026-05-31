import { createLogger } from "../utils/logger.js";
import type { EventContext } from "./types.js";

const log = createLogger("events/issue-comment");

export async function handle(
  payload: Record<string, any>,
  { getOrCreateSession, isBot }: EventContext,
): Promise<void> {
  const { repository, issue, comment } = payload;

  // Skip bot comments
  if (isBot(comment?.user)) {
    log.info({ user: comment?.user?.login }, "skipping bot comment");
    return;
  }

  const isPR = !!issue?.pull_request;
  const kind = isPR ? "pr" : "issue";
  const num: number = issue.number;
  const prompt: string = (comment?.body || "").trim();

  if (!prompt) return;

  const owner: string = repository.owner.login;
  const repo: string = repository.name;
  const entry = await getOrCreateSession(owner, repo, kind, num);
  if (entry.busy) {
    await entry.session.followUp(prompt);
  } else {
    await entry.session.prompt(prompt);
  }

  log.info({ owner, repo, num, kind }, "comment event processed");
}
