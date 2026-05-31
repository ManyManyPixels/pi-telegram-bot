import { execFile } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.js";
import type { EventContext } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(__dirname, "..", "get_issue_content.sh");
const log = createLogger("events/issue-opened");

export async function handle(
  payload: Record<string, any>,
  { getOrCreateSession }: EventContext,
): Promise<void> {
  const { repository, issue } = payload;

  // PRs opened as "issues" are handled by the pull_request event
  if (issue?.pull_request) return;

  const owner: string = repository.owner.login;
  const repo: string = repository.name;
  const num: number = issue.number;
  const url: string =
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

function fetchIssueContent(url: string, issue: Record<string, any>): Promise<string> {
  return new Promise((resolve) => {
    execFile(script, [url], { timeout: 15_000 }, (err, stdout) => {
      if (err) {
        log.warn({ err }, "get_issue_content.sh failed, falling back");
        const title: string = issue.title || "";
        const bodyText: string = issue.body || "";
        resolve(`Source Issue: ${url}\n\n# ${title}\n\n${bodyText}`);
        return;
      }
      resolve(stdout.trim());
    });
  });
}
