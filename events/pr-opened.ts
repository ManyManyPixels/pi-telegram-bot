import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.js";
import type { EventContext } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(__dirname, "..", "get_issue_content.sh");
const systemPrompt = fs.readFileSync(
  path.resolve(__dirname, "..", "prompts", "pr-opened.md"),
  "utf-8",
).trim();
const log = createLogger("events/pr-opened");

export async function handle(
  payload: Record<string, any>,
  { getOrCreateSession }: EventContext,
): Promise<void> {
  const { repository, pull_request } = payload;

  const owner: string = repository.owner.login;
  const repo: string = repository.name;
  const num: number = pull_request.number;
  const url: string =
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

function fetchIssueContent(url: string, issueOrPr: Record<string, any>): Promise<string> {
  return new Promise((resolve) => {
    execFile(script, [url], { timeout: 15_000 }, (err, stdout) => {
      if (err) {
        log.warn({ err }, "get_issue_content.sh failed, falling back");
        const title: string = issueOrPr.title || "";
        const bodyText: string = issueOrPr.body || "";
        resolve(`${systemPrompt}\nSource PR: ${url}\n\n# ${title}\n\n${bodyText}`);
        return;
      }
      resolve(`${systemPrompt}\n${stdout.trim()}\n`);
    });
  });
}
