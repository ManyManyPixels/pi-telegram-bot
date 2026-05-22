const gh = require("../utils/gh");
const { agentRunner } = require("../lib/runner");
const { register } = require("../lib/registry");
const { issueSessionPath } = require("../sessions");
const { matchesCommand, parseCommand } = require("../lib/command-utils");

register("plan", matches, handler);

function matches(payload, eventType) {
  return matchesCommand(payload, eventType, "plan");
}

async function handler(payload) {
  const repo = payload.repository.full_name;
  const issueNumber = payload.issue.number;
  const commentId = payload.comment.id;

  const sessionPath = issueSessionPath(`${issueNumber}-plan`);
  const { prompt } = parseCommand(payload);

  const fullPrompt = `
/skill:create-plan
${prompt}
Use gh CLI to get issue with number ${issueNumber} in repo ${repo}. Get title, body and comments for the whole context.

BEFORE YOU START CREATING A PLAN: comment to the issue letting the user know that you will create a plan now.
AFTER THE PLAN IS DONE: close current issue and create a new one with the detailed plan. 
`;

  await agentRunner({
    sessionPath,
    prompt: fullPrompt,
    gh,
    reactTo: { type: "comment", repo, id: commentId },
    providerEnv: "PI_ISSUE",
    timeoutMs: 0, // no timeout — planning can take a while
  });
}
