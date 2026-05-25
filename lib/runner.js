const { runPiTurn } = require("../pi");
const { splitResponse } = require("../utils/text");
const { createLogger } = require("../utils/logger");

const log = createLogger("runner");

/**
 * Run an agent turn: pi → split → post.
 *
 * @param {object} opts
 * @param {string} opts.sessionPath - Path to session .jsonl file
 * @param {string} opts.prompt      - The prompt to send
 * @param {object} opts.gh          - GitHub helpers module
 * @param {object} opts.postTo      - { type: "issue"|"pr", repo, number }
 * @param {number} [opts.timeoutMs] - Agent timeout (default 5 min)
 * @param {string} [opts.workDir]   - Working directory for pi
 */
async function agentRunner(opts) {
  const { sessionPath, prompt, gh, postTo, timeoutMs, workDir } = opts;

  let responseText;
  try {
    responseText = await runPiTurn(sessionPath, prompt, {
      timeoutMs,
      workDir: workDir || process.env.PI_WORK_DIR || process.cwd(),
    });
  } catch (err) {
    log.error({ err: err.message }, "agent failed");
    await _post(gh, postTo, `❌ Something went wrong: ${err.message}`);
    return;
  }

  if (!responseText.trim()) {
    log.warn("agent returned empty response");
    await _post(gh, postTo, "❌ I generated an empty response — something may have gone wrong.");
    return;
  }

  try {
    const chunks = splitResponse(responseText);
    for (let i = 0; i < chunks.length; i++) {
      await _post(gh, postTo, chunks[i]);
      log.info({ chunk: i + 1, total: chunks.length }, "posted chunk");
    }
  } catch (err) {
    log.error({ err: err.message }, "failed to post response");
    try {
      await _post(gh, postTo, `❌ Failed to post response: ${err.message}`);
    } catch {}
  }
}

async function _post(gh, target, body) {
  if (!target) return;
  if (target.type === "pr") {
    return gh.postPrComment(target.repo, target.number, body);
  }
  return gh.postComment(target.repo, target.number, body);
}

module.exports = { agentRunner };
