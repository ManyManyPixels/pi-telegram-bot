const http = require("http");
const telegram = require("./telegram");
const sessions = require("./sessions");
const pi = require("./pi");
const commands = require("./commands");
const { createLogger } = require("./utils/logger");

const log = createLogger("server");

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
      log.error({ chatId, err }, "command error");
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
    log.error({ chatId, err }, "pi turn error");
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
  log.debug(
    { contentType: req.headers["content-type"], secretProvided: !!secret },
    "webhook request"
  );
  if (!telegram.verifyWebhook(secret)) {
    log.warn({ secretProvided: !!secret }, "invalid or missing webhook secret");
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

    log.info({ chatId, sender, text }, "message received");

    withChatLock(chatId, () => processMessage(chatId, text));
  });
});

server.listen(PORT, () => {
  log.info({ port: PORT }, "server started");
  log.info(
    {
      model: `${process.env.PI_PROVIDER || "deepseek"}/${process.env.PI_MODEL || "deepseek-v4-pro"}`,
      sessions: process.env.PI_SESSION_DIR || "./sessions",
      webhook: "/webhook",
    },
    "configuration"
  );
});
