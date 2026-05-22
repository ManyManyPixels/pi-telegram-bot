const gh = require("../utils/gh");
const { agentRunner } = require("../lib/runner");
const { register } = require("../lib/registry");
const { issueSessionPath } = require("../sessions");
const { matchesCommand, parseCommand } = require("../lib/command-utils");

register("research", matches, handler);

function matches(payload, eventType) {
  return matchesCommand(payload, eventType, "research");
}

async function handler(payload) {
  const repo = payload.repository.full_name;
  const issueNumber = payload.issue.number;
  const commentId = payload.comment.id;

  const sessionPath = issueSessionPath(`${issueNumber}-research`);
  const { prompt } = parseCommand(payload);

  const fullPrompt = `
/skill:research-codebase
${prompt}
Use gh CLI to get issue with number ${issueNumber} in repo ${repo}. Get title, body and comments for the whole context.

BEFORE YOU START RESEARCHING: comment to the issue with the gist of the research you're going to conduct (keep it short, this comments aim is to let user know that you're on it).
AFTER THE RESEARCH IS DONE: close current issue and create a new one with the research results. 
`;

  await agentRunner({
    sessionPath,
    prompt: fullPrompt,
    gh,
    reactTo: { type: "comment", repo, id: commentId },
    providerEnv: "PI_ISSUE",
    timeoutMs: 0, // no timeout — research can take a while
  });
}
