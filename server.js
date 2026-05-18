const http = require("http");
const telegram = require("./telegram");
const sessions = require("./sessions");
const pi = require("./pi");
const commands = require("./commands");

const PORT = parseInt(process.env.WEBHOOK_PORT || "3001", 10);

// Ensure directories
sessions.init();

// ── Per-chat concurrency lock ─────────────────────────────────────────
// Prevents parallel pi turns on the same chat from corrupting the session
// file. Incoming messages for a busy chat are queued and processed in order.

const chatLocks = new Map();

function withChatLock(chatId, fn) {
  if (chatLocks.has(chatId)) {
    // Chain: wait for current work, then run
    chatLocks.set(
      chatId,
      chatLocks
        .get(chatId)
        .then(() => fn())
        .finally(() => {
          chatLocks.delete(chatId);
        })
    );
    return chatLocks.get(chatId);
  }
  const promise = fn().finally(() => {
    chatLocks.delete(chatId);
  });
  chatLocks.set(chatId, promise);
  return promise;
}

// ── Message processing ────────────────────────────────────────────────

async function processMessage(chatId, text) {
  // Guard: empty messages
  if (!text || !text.trim()) return;

  // Commands take priority
  if (commands.hasCommand(text)) {
    try {
      const ctx = { sessions, pi, telegram };
      const response = await commands.dispatch(text, chatId, ctx);
      if (response) {
        await telegram.sendResponse(chatId, response);
      }
    } catch (err) {
      console.error(`[cmd ${chatId}] Error: ${err.message}`);
      await telegram.sendResponse(chatId, `\u26a0\ufe0f ${err.message}`);
    }
    return;
  }

  // Everything else goes to pi
  const { uuid } = sessions.getOrCreateSession(chatId);

  try {
    // Show typing indicator while pi works
    await telegram.sendChatAction(chatId, "typing");

    const response = await pi.runPiTurn(uuid, text);

    if (response.trim()) {
      await telegram.sendResponse(chatId, response);
    } else {
      await telegram.sendResponse(chatId, "\u2014 (no response)");
    }
  } catch (err) {
    console.error(`[pi ${chatId}] Error: ${err.message}`);
    await telegram.sendResponse(chatId, `\u26a0\ufe0f ${err.message}`);
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Only accept webhook POSTs
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404);
    return res.end("not found");
  }

  // Verify Telegram secret token
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  console.log("[webhook] Headers:", JSON.stringify(req.headers));
  if (!telegram.verifyWebhook(secret)) {
    console.error("[webhook] Invalid or missing secret token. Got:", secret);
    res.writeHead(401);
    return res.end("unauthorized");
  }

  // Collect body
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let update;
    try {
      update = JSON.parse(body);
    } catch {
      res.writeHead(400);
      return res.end("bad request");
    }

    // Acknowledge immediately — processing is async
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");

    // Extract message
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return; // ignore non-text updates

    const chatId = msg.chat.id;
    const text = msg.text;
    const sender = msg.from?.first_name || msg.from?.username || "?";

    console.log(`[chat ${chatId}] ${sender}: ${text}`);

    withChatLock(chatId, () => processMessage(chatId, text));
  });
});

server.listen(PORT, () => {
  console.log(`Telegram pi bot listening on port ${PORT}`);
  console.log(`Model: ${process.env.PI_PROVIDER || "deepseek"}/${process.env.PI_MODEL || "deepseek-v4-pro"}`);
  console.log(`Sessions: ${process.env.PI_SESSION_DIR || "./sessions"}`);
  console.log(`Webhook path: /webhook`);
});
