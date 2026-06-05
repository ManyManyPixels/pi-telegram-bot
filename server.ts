import "dotenv/config";

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
import { fileURLToPath } from "url";
import { PI_MODEL, PI_PROVIDER, PI_WORK_BASE, PORT } from "./constants.js";
import * as issueComment from "./events/issue-comment.js";
import * as issueOpened from "./events/issue-opened.js";
import * as prOpened from "./events/pr-opened.js";
import * as prReviewComment from "./events/pr-review-comment.js";
import type { SessionEntry } from "./events/types.js";
import { ensureRepo, resolveBranch, workdirFor } from "./git.js";
import {
  isBot,
  postComment,
  reactToIssue,
  reactToIssueComment,
  reactToPRReviewComment,
  verifySignature,
  type Reaction,
} from "./github.js";
import { createLogger } from "./utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("server");

// ── Owner configs ─────────────────────────────────────────────────

interface OwnerConfig {
  deepseekApiKey: string;
}

/** owner → deepseekApiKey */
const ownerConfigs = new Map<string, string>();

function loadOwnerConfigs(): void {
  const configsDir = path.resolve(__dirname, "configs");
  if (!fs.existsSync(configsDir)) {
    log.warn({ configsDir }, "configs directory not found");
    return;
  }
  const files = fs.readdirSync(configsDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const owner = path.basename(file, ".json");
    try {
      const raw = fs.readFileSync(path.join(configsDir, file), "utf-8");
      const config: OwnerConfig = JSON.parse(raw);
      if (
        config.deepseekApiKey &&
        typeof config.deepseekApiKey === "string" &&
        config.deepseekApiKey.length > 0
      ) {
        ownerConfigs.set(owner, config.deepseekApiKey);
        log.info({ owner }, "loaded owner config");
      } else {
        log.warn({ owner }, "owner config missing or empty deepseekApiKey");
      }
    } catch (err) {
      log.error({ err, owner, file }, "failed to load owner config");
    }
  }
  log.info({ owners: [...ownerConfigs.keys()] }, "owner configs loaded");
}

// ── Session tracking ──────────────────────────────────────────────
// Key: "owner/repo/issue/42" or "owner/repo/pr/42"
const sessions = new Map<string, SessionEntry>();

function sessionKey(owner: string, repo: string, kind: "issue" | "pr", number: number): string {
  return `${owner}/${repo}/${kind}/${number}`;
}

function sessionPath(owner: string, repo: string, kind: "issue" | "pr", number: number): string {
  return path.join(workdirFor(owner, repo), ".pi-sessions", `${kind}-${number}.jsonl`);
}

// ── Pi setup ──────────────────────────────────────────────────────
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
  packages: ["npm:pi-subagents"],
});

function createSessionAuth(ownerApiKey: string): {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const authStorage = AuthStorage.inMemory({
    deepseek: { type: "api_key", key: ownerApiKey },
  });
  const modelRegistry = ModelRegistry.create(authStorage);
  return { authStorage, modelRegistry };
}

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
  const workDir = workdirFor(owner, repo);
  const sessionDir = path.join(workDir, ".pi-sessions");

  let sessionManager: SessionManager;
  if (exists) {
    log.info({ key, filePath }, "opening existing session");
    sessionManager = SessionManager.open(filePath);
  } else {
    log.info({ key, filePath, workDir }, "creating new session");
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    sessionManager = SessionManager.create(workDir, sessionDir);
    // Rename to our convention-based path before any data is written
    sessionManager.setSessionFile(filePath);
  }

  // Resolve owner-specific API key
  const ownerApiKey = ownerConfigs.get(owner);
  if (!ownerApiKey) {
    throw new Error(`No API key configured for owner "${owner}"`);
  }

  const { authStorage: sessionAuth, modelRegistry: sessionModelRegistry } =
    createSessionAuth(ownerApiKey);

  const createOptions: CreateAgentSessionOptions = {
    cwd: workDir,
    sessionManager,
    authStorage: sessionAuth,
    modelRegistry: sessionModelRegistry,
    settingsManager,
  };

  if (PI_PROVIDER && PI_MODEL) {
    const available = await sessionModelRegistry.getAvailable();
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
      const prefix = `${owner}/${repo}/`;
      let busyCount = 0;
      for (const [k, e] of sessions) {
        if (k.startsWith(prefix) && e.busy) busyCount++;
      }
      if (busyCount === 0) {
        log.info({ owner, repo }, "repo has zero busy sessions (eligible for cleanup)");
      }
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
        if (replyText && textBlocks.length > 0) {
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

    if (!eventType || !owner || !repo) {
      log.warn({ eventType, action }, "missing eventType or owner/repo in payload");
      return;
    }

    log.info({ eventType, action, deliveryId }, "webhook received");

    // 👀 React with eyes — the agent is looking at this
    addReaction(eventType, payload, "eyes");

    // Skip bot-triggered events early to prevent error-comment loops
    if (eventType === "issue_comment" && isBot(payload.comment?.user)) {
      log.info("skipping bot comment (early)");
      return;
    }

    // ── Check owner has a config ────────────────────────────────
    if (!ownerConfigs.has(owner)) {
      log.warn({ owner }, "no config for owner, skipping");
      addReaction(eventType, payload, "-1");
      const issueNumber = extractIssueNumber(eventType, payload);
      if (issueNumber) {
        postComment(
          owner,
          repo,
          issueNumber,
          `⚠️ I'm not configured for the \`${owner}\` organization. ` +
            `An administrator needs to add an API key configuration for this owner.`,
        ).catch(() => {});
      }
      return;
    }

    // ── Ensure repo is cloned and on the right ref ───────────────
    try {
      const ref = await resolveBranch(eventType, action, payload);
      const workdir = await ensureRepo(owner, repo, ref);
      log.info({ owner, repo, ref, workdir }, "repo ready");
    } catch (err) {
      log.error({ err, owner, repo }, "failed to ensure repo");
      addReaction(eventType, payload, "-1");
      // Only post error comment for non-bot events (prevents loops)
      if (eventType !== "issue_comment" || !isBot(payload.comment?.user)) {
        const issueNumber = extractIssueNumber(eventType, payload);
        if (issueNumber) {
          postComment(
            owner,
            repo,
            issueNumber,
            "❌ I couldn't access the repository to review your request. Please make sure the bot has read access to this repository.",
          ).catch(() => {});
        }
      }
      return;
    }

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
      // 👍 All good — thumbs up!
      addReaction(eventType, payload, "+1");
    } catch (err) {
      log.error({ err, eventType, action }, "error processing webhook");
      addReaction(eventType, payload, "-1");
    }
  });
}

/** Fire-and-forget reaction added to the right target based on event type. */
function addReaction(
  eventType: string,
  payload: Record<string, any>,
  reaction: Reaction,
): void {
  const owner: string | undefined = payload.repository?.owner?.login;
  const repo: string | undefined = payload.repository?.name;
  if (!owner || !repo) return;

  const number =
    payload.issue?.number ?? payload.pull_request?.number;

  if (eventType === "issues") {
    if (number) reactToIssue(owner, repo, number, reaction).catch(() => {});
  } else if (eventType === "pull_request") {
    if (number) reactToIssue(owner, repo, number, reaction).catch(() => {}); // PRs share the issues reactions endpoint
  } else if (eventType === "issue_comment") {
    const commentId: number | undefined = payload.comment?.id;
    if (commentId) reactToIssueComment(owner, repo, commentId, reaction).catch(() => {});
  } else if (eventType === "pull_request_review_comment") {
    const commentId: number | undefined = payload.comment?.id;
    if (commentId) reactToPRReviewComment(owner, repo, commentId, reaction).catch(() => {});
  }
}

/** Extract issue/PR number from a webhook payload for error-reporting comments. */
function extractIssueNumber(eventType: string, payload: Record<string, any>): number | undefined {
  if (eventType === "issues" || eventType === "issue_comment") {
    return payload.issue?.number;
  }
  if (eventType === "pull_request" || eventType === "pull_request_review_comment") {
    return payload.pull_request?.number;
  }
  return undefined;
}

// ── Server ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/github-webhook") {
    res.writeHead(404);
    return res.end("not found");
  }
  handleWebhook(req, res);
});

// ── Startup ────────────────────────────────────────────────────────

loadOwnerConfigs();

server.listen(PORT, () => {
  log.info({ port: PORT, workBase: PI_WORK_BASE }, "server started");
});
