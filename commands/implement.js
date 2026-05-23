const gh = require("../utils/gh");
const { agentRunner } = require("../lib/runner");
const { register } = require("../lib/registry");
const { issueSessionPath } = require("../sessions");
const { matchesCommand, parseCommand } = require("../lib/command-utils");

register("implement", matches, handler);

function matches(payload, eventType) {
  return matchesCommand(payload, eventType, "implement");
}

async function handler(payload) {
  const repo = payload.repository.full_name;
  const issueNumber = payload.issue.number;
  const commentId = payload.comment.id;

  const sessionPath = issueSessionPath(`${issueNumber}-implement`);
  const { prompt } = parseCommand(payload);

  const fullPrompt = `
/skill:code-write
${prompt}
Use gh CLI to get issue with number ${issueNumber} in repo ${repo}. Get title, body and comments for the whole context.

CRITICAL: You are running in a single-turn environment. Do NOT stop to confirm understanding or ask "Shall I proceed?" — implement everything fully including creating the draft PR, all in one pass. Skip the confirmation step entirely.

BEFORE YOU START IMPLEMENTING: comment to the issue letting the user know that you will start implementing now.
AFTER THE RESEARCH IS DONE: close current issue and create a new one with the detailed plan. 
`;

  await agentRunner({
    sessionPath,
    prompt: fullPrompt,
    gh,
    postTo: { type: "issue", repo, number: issueNumber },
    reactTo: { type: "comment", repo, id: commentId },
    providerEnv: "PI_ISSUE",
    timeoutMs: 0, // no timeout — implementation can take a while
  });
}
