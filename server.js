const http = require("http");
const github = require("./github");
const sessions = require("./sessions");
const registry = require("./lib/registry");
const { createLogger } = require("./utils/logger");

const log = createLogger("server");

const PORT = parseInt(process.env.WEBHOOK_PORT || "3001", 10);

// Ensure session directory and register command handlers
sessions.init();
require("./commands/comment");

// ── GitHub webhook handler ────────────────────────────────────────────

function handleGithubWebhook(req, res) {
  const signature = req.headers["x-hub-signature-256"];
  const eventType = req.headers["x-github-event"];
  const deliveryId = req.headers["x-github-delivery"];
  const contentType = (req.headers["content-type"] || "").split(";")[0].trim();

  log.info({ eventType, deliveryId, contentType }, "webhook");

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (!github.verifySignature(signature, body)) {
      log.warn({ eventType, deliveryId }, "invalid signature");
      res.writeHead(401);
      return res.end("unauthorized");
    }

    let payload;
    try {
      if (contentType === "application/x-www-form-urlencoded") {
        const params = new URLSearchParams(body);
        const encoded = params.get("payload");
        if (!encoded) {
          res.writeHead(400);
          return res.end("bad request: missing payload");
        }
        payload = JSON.parse(encoded);
      } else {
        payload = JSON.parse(body);
      }
    } catch (err) {
      log.error({ eventType, deliveryId, err }, "failed to parse body");
      res.writeHead(400);
      return res.end("bad request");
    }

    // Ack immediately, then dispatch
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");

    registry.dispatch(payload, eventType);
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404);
    return res.end("not found");
  }

  if (req.url === "/github-webhook") {
    return handleGithubWebhook(req, res);
  }

  res.writeHead(404);
  return res.end("not found");
});

server.listen(PORT, () => {
  log.info({ port: PORT }, "server started");
});
