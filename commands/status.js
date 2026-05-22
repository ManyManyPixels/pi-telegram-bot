const fs = require("fs");
const gh = require("../utils/gh");
const { register } = require("../lib/registry");
const { issueSessionPath } = require("../sessions");
const { matchesCommand } = require("../lib/command-utils");
const { createLogger } = require("../utils/logger");

const log = createLogger("status");

register("status", matches, handler);

function matches(payload, eventType) {
  return matchesCommand(payload, eventType, "status");
}

async function handler(payload) {
  const repo = payload.repository.full_name;
  const issueNumber = payload.issue.number;
  const sessionPath = issueSessionPath(issueNumber);

  try {
    const summary = summarizeSession(sessionPath);
    if (!summary) {
      await gh.postComment(
        repo,
        issueNumber,
        "📊 **Session Status**\n\nNo session data found for this issue.",
      );
      return;
    }

    const body = formatStatus(summary);
    await gh.postComment(repo, issueNumber, body);
    log.info({ repo, issueNumber }, "status posted");
  } catch (err) {
    log.error({ err: err.message }, "failed to post status");
    await gh.postComment(
      repo,
      issueNumber,
      `❌ Failed to read session status: ${err.message}`,
    );
  }
}

/**
 * Parse the session JSONL file and aggregate usage data.
 *
 * @param {string} sessionPath
 * @returns {object|null}
 */
function summarizeSession(sessionPath) {
  if (!fs.existsSync(sessionPath)) return null;

  const raw = fs.readFileSync(sessionPath, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);

  let sessionId = null;
  let provider = "unknown";
  let model = "unknown";
  let userTurns = 0;
  let assistantTurns = 0;
  let sumInput = 0;
  let sumOutput = 0;
  let sumCacheRead = 0;
  let sumCacheWrite = 0;
  let sumTokens = 0;
  let costInput = 0;
  let costOutput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let costTotal = 0;

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    switch (event.type) {
      case "session":
        sessionId = event.id;
        break;
      case "model_change":
        provider = event.provider || provider;
        model = event.modelId || model;
        break;
      case "message": {
        const msg = event.message;
        if (!msg) continue;
        if (msg.role === "user") {
          userTurns++;
        } else if (msg.role === "assistant" && msg.usage) {
          assistantTurns++;
          const u = msg.usage;
          sumInput += u.input || 0;
          sumOutput += u.output || 0;
          sumCacheRead += u.cacheRead || 0;
          sumCacheWrite += u.cacheWrite || 0;
          sumTokens += u.totalTokens || 0;
          if (u.cost) {
            costInput += u.cost.input || 0;
            costOutput += u.cost.output || 0;
            costCacheRead += u.cost.cacheRead || 0;
            costCacheWrite += u.cost.cacheWrite || 0;
            costTotal += u.cost.total || 0;
          }
        }
        break;
      }
    }
  }

  if (assistantTurns === 0 && userTurns === 0) return null;

  return {
    sessionId,
    provider,
    model,
    userTurns,
    assistantTurns,
    sumInput,
    sumOutput,
    sumCacheRead,
    sumCacheWrite,
    sumTokens,
    costInput,
    costOutput,
    costCacheRead,
    costCacheWrite,
    costTotal,
  };
}

/**
 * Format a summary object into a Markdown status message.
 */
function formatStatus(s) {
  const parts = [
    "📊 **Session Status**",
    "",
    `| | |`,
    `|---|---|`,
    `| **Model** | \`${s.provider}/${s.model}\` |`,
    `| **Assistant turns** | ${s.assistantTurns} |`,
    `| **User prompts** | ${s.userTurns} |`,
  ];

  // Tokens
  parts.push(
    `| **Tokens in** | ${s.sumInput.toLocaleString()} |`,
    `| **Tokens out** | ${s.sumOutput.toLocaleString()} |`,
  );
  if (s.sumCacheRead > 0) {
    parts.push(`| **Cache read** | ${s.sumCacheRead.toLocaleString()} |`);
  }
  if (s.sumCacheWrite > 0) {
    parts.push(`| **Cache written** | ${s.sumCacheWrite.toLocaleString()} |`);
  }
  parts.push(`| **Total tokens** | ${s.sumTokens.toLocaleString()} |`);

  // Cost
  if (s.costTotal > 0) {
    parts.push(
      "",
      "**Cost breakdown:**",
      "",
      `| | |`,
      `|---|---|`,
      `| Input | $${s.costInput.toFixed(6)} |`,
      `| Output | $${s.costOutput.toFixed(6)} |`,
    );
    if (s.costCacheRead > 0) {
      parts.push(`| Cache read | $${s.costCacheRead.toFixed(6)} |`);
    }
    if (s.costCacheWrite > 0) {
      parts.push(`| Cache write | $${s.costCacheWrite.toFixed(6)} |`);
    }
    parts.push(`| **Total cost** | **$${s.costTotal.toFixed(6)}** |`);
  }

  if (s.sessionId) {
    parts.push("", `Session: \`${s.sessionId}\``);
  }

  return parts.join("\n");
}
