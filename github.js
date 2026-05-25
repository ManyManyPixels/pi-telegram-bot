const crypto = require("crypto");
const { createLogger } = require("./utils/logger");

const log = createLogger("github");

const SECRET = (process.env.GITHUB_WEBHOOK_SECRET || "").trim();

if (SECRET) {
  log.info({ secretLen: SECRET.length }, "github webhook secret configured");
} else {
  log.warn("GITHUB_WEBHOOK_SECRET not set — webhook will reject all requests");
}

/**
 * Verify GitHub's X-Hub-Signature-256 header against our secret.
 */
function verifySignature(signatureHeader, payload) {
  if (!signatureHeader || !SECRET) {
    log.warn(
      { hasSig: !!signatureHeader, hasSecret: !!SECRET },
      "missing signature header or secret"
    );
    return false;
  }
  try {
    const computed = "sha256=" + crypto
      .createHmac("sha256", SECRET)
      .update(payload, "utf8")
      .digest("hex");

    const expected = signatureHeader.trim();

    if (computed.length !== expected.length) {
      log.warn(
        { computedLen: computed.length, expectedLen: expected.length },
        "signature length mismatch"
      );
    }

    const valid = crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(expected)
    );

    if (!valid) {
      log.warn("signature mismatch");
    }

    return valid;
  } catch (err) {
    log.error({ err }, "signature verification error");
    return false;
  }
}

module.exports = { verifySignature };
