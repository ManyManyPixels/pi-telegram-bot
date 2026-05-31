import type { AgentSessionEvent, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import fs from "fs";
import http from "http";
import path from "path";
import { PI_MODEL, PI_PROVIDER, PI_SESSION_DIR, PI_WORK_DIR, PORT } from "./constants.js";
import * as issueComment from "./events/issue-comment.js";
import * as issueOpened from "./events/issue-opened.js";
import * as prOpened from "./events/pr-opened.js";
import * as prReviewComment from "./events/pr-review-comment.js";
import type { SessionEntry } from "./events/types.js";
import { isBot, postComment, verifySignature } from "./github.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("server");

// ── Session tracking ──────────────────────────────────────────────
// Key: "owner/repo/issue/42" or "owner/repo/pr/42"
const sessions = new Map<string, SessionEntry>();

function sessionKey(owner: string, repo: string, kind: "issue" | "pr", number: number): string {
  return `${owner}/${repo}/${kind}/${number}`;
}

function sessionPath(owner: string, repo: string, kind: "issue" | "pr", number: number): string {
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

async function getOrCreateSession(
  owner: string,
  repo: string,
  kind: "issue" | "pr",
  number: number,
): Promise<SessionEntry> {
  const key = sessionKey(owner, repo, kind, number);
  const filePath = sessionPath(owner, repo, kind, number);

  // Return cached session if it still exists and is valid
  const cached = sessions.get(key);
  if (cached) return cached;

  // Check if session file already exists on disk
  const exists = fs.existsSync(filePath);

  let sessionManager: SessionManager;
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

  const createOptions: CreateAgentSessionOptions = {
    cwd: PI_WORK_DIR,
    sessionManager,
    authStorage,
    modelRegistry,
    settingsManager,
  };

  if (PI_PROVIDER && PI_MODEL) {
    const available = await modelRegistry.getAvailable();
    const model = available.find((m) => m.provider === PI_PROVIDER && m.id === PI_MODEL);
    if (model) {
      createOptions.model = model;
      log.info({ provider: PI_PROVIDER, model: PI_MODEL }, "using configured model");
    }
  }

  const { session } = await createAgentSession(createOptions);
  const entry: SessionEntry = { session, busy: false, key, filePath };
  sessions.set(key, entry);

  // Subscribe to events
  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "agent_start") {
      entry.busy = true;
      log.info({ key }, "agent started");
    }

    if (event.type === "agent_end") {
      entry.busy = false;
      log.info({ key }, "agent ended");
    }

    if (event.type === "turn_end") {
      const msg = event.message;
      if (msg.role === "assistant") {
        // Collect thinking blocks and format as markdown quotes
        const content = msg.content as Array<{
          type: string;
          text?: string;
          thinking?: string;
        }>;
        const thinkingBlocks = content
          .filter((block) => block.type === "thinking")
          .map((block) =>
            (block.thinking || "")
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n"),
          );

        const textBlocks = content
          .filter((block) => block.type === "text")
          .map((block) => block.text || "");

        const parts = [...thinkingBlocks, ...textBlocks];
        const replyText = parts.join("\n\n").trim();
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

interface WebhookPayload {
  action?: string;
  repository?: {
    owner?: { login?: string };
    name?: string;
  };
  [key: string]: unknown;
}

function handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): void {
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  const eventType = req.headers["x-github-event"] as string | undefined;
  const deliveryId = req.headers["x-github-delivery"] as string | undefined;
  const contentType = (req.headers["content-type"] || "").split(";")[0].trim();

  let body = "";
  req.on("data", (chunk: string) => (body += chunk));
  req.on("end", async () => {
    if (!verifySignature(signature, body)) {
      res.writeHead(401);
      return res.end("unauthorized");
    }

    let payload: WebhookPayload;
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
  log.info({ port: PORT, workDir: PI_WORK_DIR, sessionDir: PI_SESSION_DIR }, "server started");
});
