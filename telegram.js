const { spawn } = require("child_process");
const crypto = require("crypto");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4000;

// ── Webhook verification ──────────────────────────────────────────────
/**
 * Verify the X-Telegram-Bot-Api-Secret-Token header against our secret.
 * Uses timing-safe comparison.
 */
function verifyWebhook(header) {
  if (!header || !WEBHOOK_SECRET) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(header),
      Buffer.from(WEBHOOK_SECRET)
    );
  } catch {
    return false;
  }
}

// ── Telegram API helpers ──────────────────────────────────────────────

async function apiCall(method, body) {
  const url = `${TELEGRAM_API}/bot${BOT_TOKEN}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Telegram API ${method} returned ${resp.status}: ${errText}`);
  }
  return resp.json();
}

function sendChatAction(chatId, action = "typing") {
  return apiCall("sendChatAction", { chat_id: chatId, action });
}

function sendMessage(chatId, text) {
  return apiCall("sendMessage", { chat_id: chatId, text });
}

// ── Gist fallback ─────────────────────────────────────────────────────

function createGist(text) {
  return new Promise((resolve, reject) => {
    const gh = spawn(
      "gh",
      ["gist", "create", "-f", "response.md", "-d", "pi response", "-"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    let stdout = "";
    gh.stdout.on("data", (d) => (stdout += d.toString()));
    gh.stderr.on("data", (d) =>
      console.error(`[gh gist] ${d.toString().trim()}`)
    );

    gh.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`gh gist exit ${code}`));
    });

    gh.on("error", reject);

    gh.stdin.write(text);
    gh.stdin.end();
  });
}

// ── Smart send ────────────────────────────────────────────────────────

/**
 * Send a response to a chat. If the text exceeds Telegram's limit,
 * creates a GitHub gist and sends the link instead.
 */
async function sendResponse(chatId, text) {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return sendMessage(chatId, text);
  }

  console.log(
    `[telegram] Response too long (${text.length} chars), creating gist`
  );

  try {
    const gistUrl = await createGist(text);
    return sendMessage(
      chatId,
      `Response too long for Telegram (${text.length} chars). Full response:\n${gistUrl}`
    );
  } catch (err) {
    console.error(`[telegram] Gist failed: ${err.message}, falling back to truncation`);
    // Fallback: send truncated
    return sendMessage(
      chatId,
      text.slice(0, MAX_MESSAGE_LENGTH - 30) + "\n\n\u2026[truncated]"
    );
  }
}

module.exports = {
  verifyWebhook,
  sendChatAction,
  sendMessage,
  sendResponse,
};
