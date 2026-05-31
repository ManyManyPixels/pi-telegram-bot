import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { GitHubUser } from "../github.js";

export interface SessionEntry {
  session: AgentSession;
  busy: boolean;
  key: string;
  filePath: string;
}

export interface EventContext {
  getOrCreateSession: (
    owner: string,
    repo: string,
    kind: "issue" | "pr",
    number: number,
  ) => Promise<SessionEntry>;
  isBot: (user: GitHubUser | undefined) => boolean;
}
