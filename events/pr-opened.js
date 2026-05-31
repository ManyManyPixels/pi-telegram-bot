import { execFile } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(__dirname, "..", "get_issue_content.sh");
const log = createLogger("events/pr-opened");

/**
 * Handle `pull_request` / `opened` webhook event.
 */
export async function handle(payload, { getOrCreateSession }) {
  const { repository, pull_request } = payload;

  const owner = repository.owner.login;
  const repo = repository.name;
  const num = pull_request.number;
  const url =
    pull_request.html_url ||
    `https://github.com/${owner}/${repo}/pull/${num}`;

  const prompt = await fetchIssueContent(url, pull_request);

  const entry = await getOrCreateSession(owner, repo, "pr", num);
  if (entry.busy) {
    await entry.session.followUp(prompt);
  } else {
    await entry.session.prompt(prompt);
  }

  log.info({ owner, repo, num }, "PR opened event processed");
}

/**
 * Shell out to get_issue_content.sh. Falls back to manual formatting
 * if the script is unavailable or fails.
 */
function fetchIssueContent(url, issueOrPr) {
  return new Promise((resolve) => {
    execFile(script, [url], { timeout: 15_000 }, (err, stdout) => {
      if (err) {
        log.warn({ err }, "get_issue_content.sh failed, falling back");
        const title = issueOrPr.title || "";
        const bodyText = issueOrPr.body || "";
        resolve(`Source PR: ${url}\n\n# ${title}\n\n${bodyText}`);
        return;
      }
      resolve(stdout.trim());
    });
  });
}
