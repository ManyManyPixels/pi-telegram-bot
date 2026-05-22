const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const gh = require("../utils/gh");
const { register } = require("../lib/registry");
const { issueSessionPath } = require("../sessions");
const { matchesCommand } = require("../lib/command-utils");
const { createLogger } = require("../utils/logger");
const { execFilePromise } = require("../utils/exec");

const WORK_DIR = process.env.PI_WORK_DIR || __dirname;
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
    ensureSession(sessionPath);
    const summary = summarizeSession(sessionPath);
    const gitInfo = await getGitInfo();

    const body = formatStatus(summary, gitInfo);
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
 * Gather current git branch and working tree status.
 *
 * @returns {Promise<{branch: string|null, status: string|null, error: string|null}>}
 */
async function getGitInfo() {
  try {
    const branch = (await execFilePromise("git", ["branch", "--show-current"], { cwd: WORK_DIR }))
      .trim() || "(detached)";
    const status = (await execFilePromise("git", ["status", "--short"], { cwd: WORK_DIR }))
      .trim() || "(clean)";
    return { branch, status, error: null };
  } catch (err) {
    return { branch: null, status: null, error: err.message };
  }
}

/**
 * Create a minimal session file if one doesn't already exist.
 * Writes the session header and current model info so status
 * always has something to render.
 */
function ensureSession(sessionPath) {
  if (fs.existsSync(sessionPath)) return;

  const providerEnv = "PI_ISSUE";
  const provider = process.env[`${providerEnv}_PROVIDER`] || process.env.PI_PROVIDER || "deepseek";
  const model = process.env[`${providerEnv}_MODEL`] || process.env.PI_MODEL || "deepseek-v4-pro";

  const sessionEvent = {
    type: "session",
    version: 3,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: WORK_DIR,
  };
  const modelChangeEvent = {
    type: "model_change",
    id: "00000000",
    parentId: null,
    timestamp: new Date().toISOString(),
    provider,
    modelId: model,
  };

  const dir = path.dirname(sessionPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    sessionPath,
    JSON.stringify(sessionEvent) + "\n" + JSON.stringify(modelChangeEvent) + "\n",
    "utf-8",
  );
}

/**
 * Format a summary object into a Markdown status message.
 */
function formatStatus(s, gitInfo) {
  const parts = [
    "📊 **Session Status**",
    "",
    `| | |`,
    `|---|---|`,
    `| **Model** | \`${s.provider}/${s.model}\` |`,
    `| **Assistant turns** | ${s.assistantTurns} |`,
    `| **User prompts** | ${s.userTurns} |`,
  ];

  // Git info
  if (gitInfo) {
    parts.push(`| **Active branch** | \`${gitInfo.branch || "unknown"}\` |`);
    const statusLines = gitInfo.status
      ? gitInfo.status.split("\n").map((l) => `\`${l}\``).join("<br>")
      : `_${gitInfo.error || "unavailable"}_`;
    parts.push(`| **Git status** | ${statusLines} |`);
  }

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
