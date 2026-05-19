const fs = require("fs");
const path = require("path");
const http = require("http");
const telegram = require("./telegram");
const github = require("./github");
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

// ── GitHub notify chat auto-registration ─────────────────────────────
// On the first message from any chat, set it as the GitHub notify chat
// so events get sent to the same conversation.

function ensureNotifyChat(chatId) {
  if (!process.env.GITHUB_NOTIFY_CHAT_ID) {
    process.env.GITHUB_NOTIFY_CHAT_ID = String(chatId);
    log.info({ chatId }, "auto-registered as GitHub notify chat");

    // Persist to .env so it survives restarts
    const envPath = path.join(__dirname, ".env");
    try {
      let env = fs.readFileSync(envPath, "utf8");
      if (env.includes("GITHUB_NOTIFY_CHAT_ID=")) {
        env = env.replace(/GITHUB_NOTIFY_CHAT_ID=.*/, `GITHUB_NOTIFY_CHAT_ID=${chatId}`);
      } else {
        env += `\nGITHUB_NOTIFY_CHAT_ID=${chatId}\n`;
      }
      fs.writeFileSync(envPath, env, "utf8");
      log.info({ chatId }, "persisted GITHUB_NOTIFY_CHAT_ID to .env");
    } catch (err) {
      log.warn({ err }, "could not persist GITHUB_NOTIFY_CHAT_ID to .env");
    }
  }
}

// ── Message processing ────────────────────────────────────────────────

async function processMessage(chatId, text) {
  // Guard: empty messages
  if (!text || !text.trim()) return;

  // Auto-register this chat for GitHub notifications
  ensureNotifyChat(chatId);

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

function handleTelegramWebhook(req, res) {
  // Verify Telegram secret token
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  log.debug(
    { contentType: req.headers["content-type"], secretProvided: !!secret },
    "telegram webhook request"
  );
  if (!telegram.verifyWebhook(secret)) {
    log.warn({ secretProvided: !!secret }, "invalid or missing telegram webhook secret");
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

    log.info({ chatId, sender, text }, "telegram message received");

    withChatLock(chatId, () => processMessage(chatId, text));
  });
}

function handleGithubWebhook(req, res) {
  const signature = req.headers["x-hub-signature-256"];
  const eventType = req.headers["x-github-event"];
  const deliveryId = req.headers["x-github-delivery"];
  const contentType = (req.headers["content-type"] || "").split(";")[0].trim();

  log.info({ eventType, deliveryId, contentType }, "github webhook request");

  // Collect body as raw string for signature verification
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    // Verify signature on the raw body
    if (!github.verifySignature(signature, body)) {
      log.warn({ eventType, deliveryId }, "invalid github signature");
      res.writeHead(401);
      return res.end("unauthorized");
    }

    let payload;
    try {
      if (contentType === "application/x-www-form-urlencoded") {
        // GitHub sends: payload=<url-encoded-json>
        // smee.io may decode this, so we need to handle both cases
        const params = new URLSearchParams(body);
        const encoded = params.get("payload");
        if (!encoded) {
          log.error({ eventType, deliveryId, bodyPreview: body.slice(0, 100) }, "form-encoded body missing 'payload' param");
          res.writeHead(400);
          return res.end("bad request: missing payload");
        }
        payload = JSON.parse(encoded);
      } else {
        // Default: application/json
        payload = JSON.parse(body);
      }
    } catch (err) {
      log.error({ eventType, deliveryId, contentType, err, bodyPreview: body.slice(0, 120) }, "failed to parse webhook body");
      res.writeHead(400);
      return res.end("bad request");
    }

    // Ack immediately
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");

    // issue_comment: spawn an agent to respond on the issue
    if (eventType === "issue_comment") {
      const issueAgent = require("./commands/issue-agent");
      issueAgent.handleIssueComment(payload).catch((err) =>
        log.error({ eventType, deliveryId, err }, "issue agent handler failed")
      );
      return;
    }

    // pull_request_review: spawn an agent to implement review feedback
    if (eventType === "pull_request_review") {
      const prReviewAgent = require("./commands/pr-review-agent");
      prReviewAgent.handleReviewSubmitted(payload).catch((err) =>
        log.error({ eventType, deliveryId, err }, "pr review agent handler failed")
      );
      return;
    }

    // issues labeled "needs-research": spawn research agent
    if (eventType === "issues") {
      const action = payload.action;
      const labelName = payload.label?.name;
      const issueLabels = payload.issue?.labels || [];

      if (
        (action === "labeled" && labelName === "needs-research") ||
        (action === "opened" && issueLabels.some((l) => l.name === "needs-research"))
      ) {
        log.info({ eventType, deliveryId, action, issueNumber: payload.issue?.number }, "needs-research trigger");
        const labelResearch = require("./commands/label-research");
        labelResearch.handleLabelEvent(payload).catch((err) =>
          log.error({ eventType, deliveryId, err }, "label research handler failed")
        );
      }
      // Don't return — still send notification to Telegram below
    }

    // Format event
    const message = github.formatEvent(eventType, payload);
    if (!message) {
      log.debug({ eventType, deliveryId }, "empty formatted event, skipping");
      return;
    }

    // Send to Telegram notify chat
    const chatId = process.env.GITHUB_NOTIFY_CHAT_ID;
    if (!chatId) {
      log.warn("GITHUB_NOTIFY_CHAT_ID not set, cannot send notification");
      return;
    }

    log.info({ eventType, deliveryId, chatId }, "sending github event to telegram");
    telegram.sendResponse(chatId, message).catch((err) =>
      log.error({ eventType, deliveryId, err }, "failed to send github notification")
    );
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404);
    return res.end("not found");
  }

  if (req.url === "/webhook") {
    return handleTelegramWebhook(req, res);
  }

  if (req.url === "/github-webhook") {
    return handleGithubWebhook(req, res);
  }

  res.writeHead(404);
  return res.end("not found");
});

server.listen(PORT, () => {
  log.info({ port: PORT }, "server started");
  log.info(
    {
      model: `${process.env.PI_PROVIDER || "deepseek"}/${process.env.PI_MODEL || "deepseek-v4-pro"}`,
      sessions: process.env.PI_SESSION_DIR || "./sessions",
      telegramWebhook: "/webhook",
      githubWebhook: "/github-webhook",
      githubNotifyChat: process.env.GITHUB_NOTIFY_CHAT_ID || "(not set)",
    },
    "configuration"
  );
});
