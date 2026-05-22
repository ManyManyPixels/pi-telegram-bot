const gh = require("../utils/gh");
const { register } = require("../lib/registry");
const { matchesCommand } = require("../lib/command-utils");
const { createLogger } = require("../utils/logger");
const { execFilePromise } = require("../utils/exec");

const WORK_DIR = process.env.PI_WORK_DIR || process.cwd();
const log = createLogger("gcm");

register("gcm", matches, handler);

function matches(payload, eventType) {
  return matchesCommand(payload, eventType, "gcm");
}

async function handler(payload) {
  const repo = payload.repository.full_name;
  const issueNumber = payload.issue.number;

  try {
    const { prompt } = require("../lib/command-utils").parseCommand(payload);
    const subcommand = parseSubcommand(prompt);

    await handleGcm(repo, issueNumber, subcommand);
  } catch (err) {
    log.error({ err: err.message }, "gcm failed");
    await gh.postComment(
      repo,
      issueNumber,
      `❌ gcm failed: ${err.message}`,
    );
  }
}

/**
 * Parse the text after ">gcm" into a subcommand and its argument.
 */
function parseSubcommand(prompt) {
  const trimmed = prompt.trim();
  if (!trimmed) return { action: "check" };

  if (trimmed === "stash") return { action: "stash" };

  if (trimmed.startsWith("commit")) {
    const msg = trimmed.slice(6).trim();
    return { action: "commit", message: msg || "gcm auto-commit" };
  }

  return { action: "check" };
}

/**
 * Handle the gcm command based on the parsed subcommand.
 */
async function handleGcm(repo, issueNumber, subcommand) {
  const main = await getDefaultBranch();
  const currentBranch = await getCurrentBranch();
  const dirty = await isDirty();

  // Already on main and clean
  if (currentBranch === main && !dirty) {
    await gh.postComment(repo, issueNumber, `✅ Already on \`${main}\`, working tree clean.`);
    return;
  }

  // Already on main but dirty — just commit/stash on main
  if (currentBranch === main) {
    if (subcommand.action === "commit") {
      await commitAll(subcommand.message);
      await gh.postComment(repo, issueNumber, `✅ Committed on \`${main}\`:\n\`\`\`\n${subcommand.message}\n\`\`\``);
      return;
    }
    if (subcommand.action === "stash") {
      await stashChanges(main);
      await gh.postComment(repo, issueNumber, `✅ Stashed changes on \`${main}\`.`);
      return;
    }
    await askDirty(repo, issueNumber, main);
    return;
  }

  // On a different branch
  if (subcommand.action === "check") {
    if (dirty) {
      await askDirty(repo, issueNumber, currentBranch, main);
    } else {
      await switchToMain(repo, issueNumber, currentBranch, main);
    }
    return;
  }

  if (subcommand.action === "commit") {
    if (dirty) {
      await commitAll(subcommand.message);
    }
    await switchToMain(repo, issueNumber, currentBranch, main);
    return;
  }

  if (subcommand.action === "stash") {
    if (dirty) {
      await stashChanges(currentBranch);
    }
    await switchToMain(repo, issueNumber, currentBranch, main);
  }
}

/**
 * Ask the user what to do with dirty changes.
 */
async function askDirty(repo, issueNumber, branch, main) {
  await gh.postComment(
    repo,
    issueNumber,
    [
      `⚠️ Working tree is dirty on branch \`${branch}\`.`,
      "",
      "What should I do with the changes?",
      "",
      `- Reply \`>gcm commit <message>\` to commit them to \`${branch}\``,
      `- Reply \`>gcm stash\` to stash them and switch to \`${main}\``,
    ].join("\n"),
  );
}

async function commitAll(message) {
  await execFilePromise("git", ["add", "-A"], { cwd: WORK_DIR });
  await execFilePromise("git", ["commit", "-m", message], { cwd: WORK_DIR });
}

async function stashChanges(branch) {
  const summary = await getDiffSummary();
  const stashMsg = `${branch}: ${summary}`;
  await execFilePromise("git", ["stash", "push", "-m", stashMsg], { cwd: WORK_DIR });
}

async function switchToMain(repo, issueNumber, fromBranch, main) {
  await execFilePromise("git", ["checkout", main], { cwd: WORK_DIR });
  await gh.postComment(
    repo,
    issueNumber,
    `✅ Switched from \`${fromBranch}\` to \`${main}\`.`,
  );
}

async function getCurrentBranch() {
  const out = await execFilePromise("git", ["branch", "--show-current"], { cwd: WORK_DIR });
  return out.trim();
}

async function isDirty() {
  const out = await execFilePromise("git", ["status", "--porcelain"], { cwd: WORK_DIR });
  return out.trim().length > 0;
}

/**
 * Detect the default branch from origin (main, master, etc.).
 */
async function getDefaultBranch() {
  try {
    const out = await execFilePromise("git", ["remote", "show", "origin"], { cwd: WORK_DIR });
    const match = out.match(/HEAD branch:\s*(\S+)/);
    if (match) return match[1];
  } catch {
    // fall through
  }
  // Fallback: try common names
  for (const name of ["main", "master"]) {
    try {
      await execFilePromise("git", ["rev-parse", "--verify", `refs/heads/${name}`], { cwd: WORK_DIR });
      return name;
    } catch {
      // try next
    }
  }
  return "master";
}

async function getDiffSummary() {
  const out = await execFilePromise("git", ["diff", "--stat"], { cwd: WORK_DIR });
  const lines = out.trim().split("\n");
  if (lines.length === 0) return "uncommitted changes";
  const last = lines[lines.length - 1].trim();
  return last || "uncommitted changes";
}
