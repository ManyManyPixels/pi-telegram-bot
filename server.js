const http = require("http");
const github = require("./github");
const { createLogger } = require("./utils/logger");

const log = createLogger("server");

const PORT = parseInt(process.env.WEBHOOK_PORT || "3001", 10);

function handleWebhook(req, res) {
  const signature = req.headers["x-hub-signature-256"];
  const eventType = req.headers["x-github-event"];
  const deliveryId = req.headers["x-github-delivery"];
  const contentType = (req.headers["content-type"] || "").split(";")[0].trim();

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (!github.verifySignature(signature, body)) {
      res.writeHead(401);
      return res.end("unauthorized");
    }

    let payload;
    try {
      payload = contentType === "application/x-www-form-urlencoded"
        ? JSON.parse(new URLSearchParams(body).get("payload") || "{}")
        : JSON.parse(body);
    } catch {
      res.writeHead(400);
      return res.end("bad request");
    }

    // Early ACK
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");

    // ── Debug: log every webhook event ──
    log.info(
      { eventType, action: payload.action, deliveryId },
      "webhook received"
    );

    // ── Log PR comments from issue_comment events ──
    if (eventType === "issue_comment" && payload.action === "created") {
      const isPr = !!payload.issue?.pull_request;
      log.info({ isPr, issueKeys: payload.issue ? Object.keys(payload.issue) : [] }, "issue_comment detail");
      if (isPr) {
        const repo = payload.repository?.full_name || "unknown";
        const prNumber = payload.issue?.number;
        const user = payload.comment?.user?.login || "unknown";
        const bodyText = (payload.comment?.body || "").trim();
        const commentId = payload.comment?.id;

        console.log("──────────────────────────────────────────");
        console.log(`📨 PR COMMENT`);
        console.log(`   Repo:      ${repo}`);
        console.log(`   PR:        #${prNumber}`);
        console.log(`   Comment:   ${commentId}`);
        console.log(`   Author:    @${user}`);
        console.log(`   Body:`);
        console.log(`${bodyText}`);
        console.log("──────────────────────────────────────────");
      }
    }

    // ── Also catch pull_request_review_comment events (inline PR comments) ──
    if (eventType === "pull_request_review_comment" && payload.action === "created") {
      const repo = payload.repository?.full_name || "unknown";
      const prNumber = payload.pull_request?.number;
      const user = payload.comment?.user?.login || "unknown";
      const bodyText = (payload.comment?.body || "").trim();
      const commentId = payload.comment?.id;

      console.log("──────────────────────────────────────────");
      console.log(`📨 PR REVIEW COMMENT (inline)`);
      console.log(`   Repo:      ${repo}`);
      console.log(`   PR:        #${prNumber}`);
      console.log(`   Comment:   ${commentId}`);
      console.log(`   Author:    @${user}`);
      console.log(`   Body:`);
      console.log(`${bodyText}`);
      console.log("──────────────────────────────────────────");
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/github-webhook") {
    res.writeHead(404);
    return res.end("not found");
  }
  handleWebhook(req, res);
});

server.listen(PORT, () => {
  log.info({ port: PORT }, "server started");
});
