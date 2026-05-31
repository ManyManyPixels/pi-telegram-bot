import pinoModule from "pino";
import path from "path";
import { LOG_LEVEL, LOG_DIR } from "../constants.js";

// pino v8 types export a namespace without call signature.
// Runtime default export is a function — cast to match.
const pino = pinoModule as unknown as ((
  opts?: Record<string, unknown>,
  transport?: Record<string, unknown>,
) => pinoModule.Logger) & {
  transport: (opts: Record<string, unknown>) => Record<string, unknown>;
  stdSerializers: Record<string, unknown>;
};

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
  transport,
);

/**
 * Create a child logger with an automatic "module" field.
 * Every log line from this child will include { module: name }.
 */
export function createLogger(name: string): pinoModule.Logger {
  return rootLogger.child({ module: name });
}
