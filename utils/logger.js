import pino from "pino";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const LOG_DIR = path.resolve(
  process.env.LOG_DIR || path.join(__dirname, "..", "logs")
);

const transport = pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { colorize: true },
      level: LOG_LEVEL,
    },
    {
      target: "pino-roll",
      options: {
        file: path.join(LOG_DIR, "app"),
        frequency: "daily",
        mkdir: true,
        dateFormat: "yyyy-MM-dd",
      },
      level: LOG_LEVEL,
    },
  ],
});

const rootLogger = pino(
  {
    level: LOG_LEVEL,
    serializers: pino.stdSerializers,
  },
  transport
);

/**
 * Create a child logger with an automatic "module" field.
 * Every log line from this child will include { module: name }.
 */
export function createLogger(name) {
  return rootLogger.child({ module: name });
}
