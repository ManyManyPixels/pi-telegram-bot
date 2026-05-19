const http = require("http");
const github = require("./github");
const sessions = require("./sessions");
const { createLogger } = require("./utils/logger");

const log = createLogger("server");

const PORT = parseInt(process.env.WEBHOOK_PORT || "3001", 10);

// Ensure directories
sessions.init();

// ── GitHub webhook handler ────────────────────────────────────────────

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
        const params = new URLSearchParams(body);
        const encoded = params.get("payload");
        if (!encoded) {
          log.error({ eventType, deliveryId, bodyPreview: body.slice(0, 100) }, "form-encoded body missing 'payload' param");
          res.writeHead(400);
          return res.end("bad request: missing payload");
        }
        payload = JSON.parse(encoded);
      } else {
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
    }
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
  log.info(
    {
      model: `${process.env.PI_PROVIDER || "deepseek"}/${process.env.PI_MODEL || "deepseek-v4-pro"}`,
      githubWebhook: "/github-webhook",
    },
    "configuration"
  );
});
