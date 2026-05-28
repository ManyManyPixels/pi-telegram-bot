import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { verifySignature, isBot, postComment } from "./github.js";
import { createLogger } from "./utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("server");

const PORT = parseInt(process.env.WEBHOOK_PORT || "3001", 10);
const PI_WORK_DIR = process.env.PI_WORK_DIR || process.cwd();
const PI_SESSION_DIR = path.resolve(
  process.env.PI_SESSION_DIR || path.join(__dirname, "sessions")
);
const PI_PROVIDER = process.env.PI_PROVIDER || undefined;
const PI_MODEL = process.env.PI_MODEL || undefined;

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
      (m) => m.provider === PI_PROVIDER && m.id === PI_MODEL
    );
    if (model) {
      createOptions.model = model;
      log.info({ provider: PI_PROVIDER, model: PI_MODEL }, "using configured model");
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
      // Extract text blocks from the assistant message
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

    const { action, repository, issue, pull_request, comment, sender } = payload;
    const owner = repository?.owner?.login;
    const repo = repository?.name;

    if (!owner || !repo) {
      log.warn({ eventType, action }, "missing owner/repo in payload");
      return;
    }

    log.info({ eventType, action, deliveryId }, "webhook received");

    try {
      // ── Issue opened ──────────────────────────────────────────
      if (eventType === "issues" && action === "opened") {
        const isPR = !!payload.issue?.pull_request;
        if (isPR) return; // PRs handled by pull_request event

        const num = issue.number;
        const title = issue.title || "";
        const bodyText = issue.body || "";
        const url = issue.html_url || `https://github.com/${owner}/${repo}/issues/${num}`;
        const prompt = `Source Issue: ${url}\n\n# ${title}\n\n${bodyText}`;

        const entry = await getOrCreateSession(owner, repo, "issue", num);
        if (entry.busy) {
          await entry.session.followUp(prompt);
        } else {
          await entry.session.prompt(prompt);
        }
      }

      // ── PR opened ─────────────────────────────────────────────
      if (eventType === "pull_request" && action === "opened") {
        const num = pull_request.number;
        const title = pull_request.title || "";
        const bodyText = pull_request.body || "";
        const url = pull_request.html_url || `https://github.com/${owner}/${repo}/pull/${num}`;
        const prompt = `Source PR: ${url}\n\n# ${title}\n\n${bodyText}`;

        const entry = await getOrCreateSession(owner, repo, "pr", num);
        if (entry.busy) {
          await entry.session.followUp(prompt);
        } else {
          await entry.session.prompt(prompt);
        }
      }

      // ── Issue/PR comment created ──────────────────────────────
      if (eventType === "issue_comment" && action === "created") {
        // Skip bot comments
        if (isBot(comment?.user)) {
          log.info({ user: comment?.user?.login }, "skipping bot comment");
          return;
        }

        const isPR = !!payload.issue?.pull_request;
        const kind = isPR ? "pr" : "issue";
        const num = issue.number;
        const bodyText = (comment?.body || "").trim();

        if (!bodyText) return;

        const url = issue.html_url || `https://github.com/${owner}/${repo}/issues/${num}`;
        const kindLabel = isPR ? "PR" : "Issue";
        const prompt = `[Comment by @${comment.user.login} on ${kindLabel} #${num}](${url})\n\n${bodyText}`;

        const entry = await getOrCreateSession(owner, repo, kind, num);
        if (entry.busy) {
          await entry.session.followUp(prompt);
        } else {
          await entry.session.prompt(prompt);
        }
      }

      // ── PR review comment created (inline comments) ───────────
      if (eventType === "pull_request_review_comment" && action === "created") {
        if (isBot(comment?.user)) {
          log.info({ user: comment?.user?.login }, "skipping bot review comment");
          return;
        }

        const num = pull_request.number;
        const bodyText = (comment?.body || "").trim();

        if (!bodyText) return;

        const url = pull_request.html_url || `https://github.com/${owner}/${repo}/pull/${num}`;
        const prompt = `[Inline review comment by @${comment.user.login} on PR #${num}](${url})\n\n${bodyText}`;

        const entry = await getOrCreateSession(owner, repo, "pr", num);
        if (entry.busy) {
          await entry.session.followUp(prompt);
        } else {
          await entry.session.prompt(prompt);
        }
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
  log.info({ port: PORT, workDir: PI_WORK_DIR, sessionDir: PI_SESSION_DIR }, "server started");
});
