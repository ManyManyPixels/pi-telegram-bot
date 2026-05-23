const { runPiTurn } = require("../pi");
const { splitResponse } = require("../utils/text");
const { createLogger } = require("../utils/logger");

const log = createLogger("runner");

/**
 * Run an agent turn with full lifecycle management:
 *   1. Post 👀 reaction
 *   2. Run pi via runPiTurn
 *   3. Split response into chunks, post each
 *   4. Post 🚀 on success, ❌ on failure
 *   5. Call optional onSuccess/onFailure hooks for label transitions etc.
 *
 * @param {object} opts
 * @param {string} opts.sessionPath    - Path to session .jsonl file
 * @param {string} opts.prompt         - The prompt to send
 * @param {object} opts.gh             - GitHub helpers module (at minimum needs the functions used)
 * @param {object} opts.postTo         - { repo, number }
 * @param {"issue"|"pr"} opts.postTo.type - Where to post results
 * @param {object} [opts.reactTo]      - { type: "issue"|"comment"|"pr", id: number } — what to react 👀/🚀/❌ on
 * @param {number} [opts.timeoutMs]    - Agent timeout (default 5 min)
 * @param {string} [opts.providerEnv]  - Env var prefix for provider override (e.g. "PI_ISSUE")
 * @param {string} [opts.workDir]      - Working directory for pi
 * @param {Function} [opts.onSuccess]  - Called after posting, with (responseText)
 * @param {Function} [opts.onFailure]  - Called on failure, with (error)
 * @param {boolean} [opts.emptyResponseOk] - Treat empty responses as success (default false)
 * @param {string}  [opts.emptyResponseMessage] - Message to post when empty + emptyResponseOk
 */
async function agentRunner(opts) {
  const {
    sessionPath,
    prompt,
    gh,
    postTo,
    reactTo = postTo, // default: react on the same target we post to
    timeoutMs = 5 * 60 * 1000,
    providerEnv,
    workDir,
    onSuccess,
    onFailure,
  } = opts;

  // 1. Post 👀
  await _react(gh, reactTo, "eyes");

  // 2. Build pi options
  const piOpts = {
    extensions: true,
    timeoutMs,
    workDir: workDir || process.env.PI_WORK_DIR || process.cwd(),
  };

  if (providerEnv) {
    piOpts.provider = process.env[`${providerEnv}_PROVIDER`] || process.env.PI_PROVIDER || "deepseek";
    piOpts.model = process.env[`${providerEnv}_MODEL`] || process.env.PI_MODEL || "deepseek-v4-pro";
  }

  // 3. Run pi
  let responseText;
  try {
    responseText = await runPiTurn(sessionPath, prompt, piOpts);
  } catch (err) {
    log.error({ err: err.message }, "agent failed");
    await _react(gh, reactTo, "confused");

    const errorBody = `❌ Something went wrong: ${err.message}`;
    await _post(gh, postTo, errorBody);

    if (onFailure) {
      try { await onFailure(err); } catch (e) { log.error({ err: e.message }, "onFailure hook failed"); }
    }
    return;
  }

  // 4. Handle empty response
  if (!responseText.trim()) {
    log.warn("agent returned empty response");
    if (opts.emptyResponseOk) {
      if (opts.emptyResponseMessage) {
        await _post(gh, postTo, opts.emptyResponseMessage).catch(() => {});
      }
      await _react(gh, reactTo, "rocket");
      if (onSuccess) {
        try { await onSuccess(""); } catch (e) { log.error({ err: e.message }, "onSuccess hook failed"); }
      }
      return;
    }
    await _react(gh, reactTo, "confused");
    await _post(gh, postTo, "❌ I generated an empty response — something may have gone wrong.");
    if (onFailure) {
      try { await onFailure(new Error("empty response")); } catch {}
    }
    return;
  }

  // 5. Post response chunks
  try {
    const chunks = splitResponse(responseText);
    for (let i = 0; i < chunks.length; i++) {
      await _post(gh, postTo, chunks[i]);
      log.info({ chunk: i + 1, total: chunks.length }, "posted chunk");
    }
    await _react(gh, reactTo, "rocket");

    if (onSuccess) {
      try { await onSuccess(responseText); } catch (e) { log.error({ err: e.message }, "onSuccess hook failed"); }
    }
  } catch (err) {
    log.error({ err: err.message }, "failed to post response");
    await _react(gh, reactTo, "confused");
    try {
      await _post(gh, postTo, `❌ Failed to post response: ${err.message}`);
    } catch {}
    if (onFailure) {
      try { await onFailure(err); } catch {}
    }
  }
}

// ── Internal: post to issue, PR, or review comment ───────────────────

async function _post(gh, target, body) {
  if (!target) return;
  if (target.type === "pr") {
    return gh.postPrComment(target.repo, target.number, body);
  }
  if (target.type === "review-comment") {
    return gh.replyToReviewComment(target.repo, target.number, target.commentId, body);
  }
  return gh.postComment(target.repo, target.number, body);
}

// ── Internal: react on issue, PR, or comment ─────────────────────────

async function _react(gh, target, content) {
  if (!target) return;
  try {
    if (target.type === "comment") {
      return gh.addCommentReaction(target.repo, target.id, content);
    }
    if (target.type === "review-comment") {
      return gh.addReviewCommentReaction(target.repo, target.id, content);
    }
    if (target.type === "pr") {
      return gh.addPrReaction(target.repo, target.number, content);
    }
    return gh.addIssueReaction(target.repo, target.number, content);
  } catch (err) {
    log.warn({ target, content, err: err.message }, "reaction failed");
  }
}

module.exports = { agentRunner };
