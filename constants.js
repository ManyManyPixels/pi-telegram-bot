import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Server ────────────────────────────────────────────────────────
export const PORT = parseInt(process.env.WEBHOOK_PORT || "3001", 10);

// ── Pi agent ──────────────────────────────────────────────────────
export const PI_WORK_DIR = process.env.PI_WORK_DIR || process.cwd();
export const PI_SESSION_DIR = path.resolve(
  process.env.PI_SESSION_DIR || path.join(__dirname, "sessions"),
);
export const PI_PROVIDER = process.env.PI_PROVIDER || undefined;
export const PI_MODEL = process.env.PI_MODEL || undefined;

// ── Logging ───────────────────────────────────────────────────────
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";
export const LOG_DIR = path.resolve(
  process.env.LOG_DIR || path.join(__dirname, "logs"),
);
