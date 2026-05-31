import { createLogger } from "../utils/logger.js";

const log = createLogger("events/pr-opened");

/**
 * Handle `pull_request` / `opened` webhook event.
 */
export async function handle(payload, { getOrCreateSession }) {
  const { repository, pull_request } = payload;

  const owner = repository.owner.login;
  const repo = repository.name;
  const num = pull_request.number;
  const title = pull_request.title || "";
  const bodyText = pull_request.body || "";
  const url =
    pull_request.html_url ||
    `https://github.com/${owner}/${repo}/pull/${num}`;

  const prompt = `Source PR: ${url}\n\n# ${title}\n\n${bodyText}`;

  const entry = await getOrCreateSession(owner, repo, "pr", num);
  if (entry.busy) {
    await entry.session.followUp(prompt);
  } else {
    await entry.session.prompt(prompt);
  }

  log.info({ owner, repo, num }, "PR opened event processed");
}
