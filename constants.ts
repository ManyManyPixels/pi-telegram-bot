import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Server ────────────────────────────────────────────────────────
export const PORT = parseInt(process.env.WEBHOOK_PORT || "3001", 10);

// ── Pi agent ──────────────────────────────────────────────────────
function resolveWorkBase(raw: string | undefined): string {
  let base = raw || path.join(os.homedir(), "src");
  // Expand ~ (dotenv doesn't expand shell tilde)
  if (base.startsWith("~")) {
    base = path.join(os.homedir(), base.slice(base[1] === "/" ? 2 : 1));
  }
  return path.resolve(base);
}
export const PI_WORK_BASE = resolveWorkBase(process.env.PI_WORK_BASE);
export const PI_PROVIDER: string | undefined = process.env.PI_PROVIDER || undefined;
export const PI_MODEL: string | undefined = process.env.PI_MODEL || undefined;

// ── Logging ───────────────────────────────────────────────────────
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";
export const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(__dirname, "logs"));
