import http from "http";
import path from "path";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { verifySignature, isBot, postComment } from "./github.js";
import { createLogger } from "./utils/logger.js";
import {
  PORT,
  PI_WORK_DIR,
  PI_SESSION_DIR,
  PI_PROVIDER,
  PI_MODEL,
} from "./constants.js";
import * as issueOpened from "./events/issue-opened.js";
import * as prOpened from "./events/pr-opened.js";
import * as issueComment from "./events/issue-comment.js";
import * as prReviewComment from "./events/pr-review-comment.js";

const log = createLogger("server");

// ── Session tracking ──────────────────────────────────────────────
// Key: "owner/repo/issue/42" or "owner/repo/pr/42"
const sessions = new Map();

function sessionKey(owner, repo, kind, number) {
  return `${owner}/${repo}/${kind}/${number}`;
}

function sessionPath(owner, repo, kind, number) {
  return path.join(PI_SESSION_DIR, `${owner}-${repo}-${kind}-${number}.jsonl`);
}

// ── Pi setup ──────────────────────────────────────────────────────
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
  packages: ["npm:pi-subagents"],
});

async function getOrCreateSession(owner, repo, kind, number) {
  const key = sessionKey(owner, repo, kind, number);
  const filePath = sessionPath(owner, repo, kind, number);

  // Return cached session if it still exists and is valid
  const cached = sessions.get(key);
  if (cached) return cached;

  // Check if session file already exists on disk
  const fs = await import("fs");
  const exists = fs.existsSync(filePath);

  let sessionManager;
  if (exists) {
    log.info({ key, filePath }, "opening existing session");
    sessionManager = SessionManager.open(filePath);
  } else {
    log.info({ key, filePath }, "creating new session");
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    sessionManager = SessionManager.create(PI_WORK_DIR, PI_SESSION_DIR);
    // Rename to our convention-based path before any data is written
    sessionManager.setSessionFile(filePath);
  }

  const createOptions = {
    cwd: PI_WORK_DIR,
    sessionManager,
    authStorage,
    modelRegistry,
    settingsManager,
  };

  if (PI_PROVIDER && PI_MODEL) {
    // Find model by provider/id
    const available = await modelRegistry.getAvailable();
    const model = available.find(
      (m) => m.provider === PI_PROVIDER && m.id === PI_MODEL,
    );
    if (model) {
      createOptions.model = model;
      log.info(
        { provider: PI_PROVIDER, model: PI_MODEL },
        "using configured model",
      );
    }
  }

  const { session } = await createAgentSession(createOptions);

  const entry = { session, busy: false, key, filePath };
  sessions.set(key, entry);

  // Subscribe to events
  session.subscribe((event) => {
    if (event.type === "agent_start") {
      entry.busy = true;
      log.info({ key }, "agent started");
    }

    if (event.type === "agent_end") {
      entry.busy = false;
      log.info({ key }, "agent ended");
    }

    if (event.type === "turn_end") {
      // TODO: together with text block try also sending thinking process using markdown quote `>`
      const msg = event.message;
      if (msg.role === "assistant") {
        const textBlocks = msg.content
          .filter((block) => block.type === "text")
          .map((block) => block.text);

        const replyText = textBlocks.join("").trim();
        if (replyText) {
          log.info({ key, len: replyText.length }, "posting turn reply");
          postComment(owner, repo, number, replyText).catch((err) => {
            log.error({ err, key }, "failed to post turn reply");
          });
        }
      }
    }
  });

  return entry;
}

// ── Webhook handler ────────────────────────────────────────────────

function handleWebhook(req, res) {
  const signature = req.headers["x-hub-signature-256"];
  const eventType = req.headers["x-github-event"];
  const deliveryId = req.headers["x-github-delivery"];
  const contentType = (req.headers["content-type"] || "").split(";")[0].trim();

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    if (!verifySignature(signature, body)) {
      res.writeHead(401);
      return res.end("unauthorized");
    }

    let payload;
    try {
      payload =
        contentType === "application/x-www-form-urlencoded"
          ? JSON.parse(new URLSearchParams(body).get("payload") || "{}")
          : JSON.parse(body);
    } catch {
      res.writeHead(400);
      return res.end("bad request");
    }

    // Early ACK
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");

    const { action, repository } = payload;
    const owner = repository?.owner?.login;
    const repo = repository?.name;

    if (!owner || !repo) {
      log.warn({ eventType, action }, "missing owner/repo in payload");
      return;
    }

    log.info({ eventType, action, deliveryId }, "webhook received");

    // TODO: for issue & pull request opened events:
    //   Use get_issue_content to get content and send it as first prompt.
    //   Reply to this first prompt should be a short acknowledgment.

    const ctx = { getOrCreateSession, isBot };

    try {
      if (eventType === "issues" && action === "opened") {
        await issueOpened.handle(payload, ctx);
      } else if (eventType === "pull_request" && action === "opened") {
        await prOpened.handle(payload, ctx);
      } else if (eventType === "issue_comment" && action === "created") {
        await issueComment.handle(payload, ctx);
      } else if (eventType === "pull_request_review_comment" && action === "created") {
        await prReviewComment.handle(payload, ctx);
      }
    } catch (err) {
      log.error({ err, eventType, action }, "error processing webhook");
    }
  });
}

// ── Server ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/github-webhook") {
    res.writeHead(404);
    return res.end("not found");
  }
  handleWebhook(req, res);
});

server.listen(PORT, () => {
  log.info(
    { port: PORT, workDir: PI_WORK_DIR, sessionDir: PI_SESSION_DIR },
    "server started",
  );
});
