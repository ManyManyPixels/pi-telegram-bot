import pino from "pino";
import path from "path";
import { LOG_LEVEL, LOG_DIR } from "../constants.js";

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
