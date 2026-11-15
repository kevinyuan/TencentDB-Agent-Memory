/**
 * TencentDB Agent Memory — OpenCode capture plugin.
 *
 * Streams OpenCode activity into MemoryCore's L0 conversation store through
 * `/v3/conversation/add`, so sessions started in OpenCode are distilled into
 * the same L1/L2/L3 memory assets as every other client adapter.
 *
 *   session hook "prompt"      → user prompt                    → L0
 *   tool hook  "execute.after" → tool name + input + result     → L0
 *
 * This is a client-only adapter: it captures, it does not run extraction or
 * injection. For prompt injection through the Memory Proxy, see
 * `adapters/opencode/`. Both can be combined.
 *
 * Design notes:
 * - Fire-and-forget: a failed or slow write never blocks OpenCode.
 * - Noise control (no LLM calls): read-only tools are skipped, output is
 *   truncated, empty markers are dropped, and repeats are de-duplicated per
 *   session.
 */
import { Plugin } from "@opencode/plugin";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const DEBUG = process.env.TDAI_DEBUG === "1";
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".tdai-memory.json");
const DEDUP_WINDOW = 8;
const MAX_SESSIONS = 200;

/** Read-only or bookkeeping tools whose output carries no memory value. */
const DEFAULT_SKIP_TOOLS = [
  "read",
  "grep",
  "glob",
  "list",
  "todoread",
  "todowrite",
  "webfetch",
  "websearch",
];

type Scope = {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  capturePrompts: boolean;
  captureTools: boolean;
  skipTools: Set<string>;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  recorded_at: string;
};

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanOption(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Resolve configuration from plugin options, then environment variables, then
 * `~/.tdai-memory.json`. Options win so a project can point at its own gateway
 * without touching the user's global file.
 */
function resolveScope(options: Record<string, unknown>): Scope {
  let file: Record<string, unknown> = {};
  try {
    const configPath = process.env.TDAI_CONFIG || DEFAULT_CONFIG_PATH;
    file = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    // Missing or malformed config is not an error: the plugin just stays idle.
  }

  const endpoint = (stringOption(options.endpoint) ||
    stringOption(process.env.TDAI_ENDPOINT) ||
    stringOption(file.endpoint) ||
    "").replace(/\/$/, "");

  const extraSkip = options.skipTools;
  const skipTools = new Set(DEFAULT_SKIP_TOOLS);
  if (Array.isArray(extraSkip)) {
    for (const tool of extraSkip) {
      const name = stringOption(tool);
      if (name) skipTools.add(name.toLowerCase());
    }
  }

  return {
    endpoint,
    apiKey: stringOption(options.apiKey) || stringOption(process.env.TDAI_KEY) || stringOption(file.key) || "",
    serviceId:
      stringOption(options.serviceId) || stringOption(process.env.TDAI_SERVICE_ID) || "default",
    teamId: stringOption(options.teamId) || stringOption(process.env.TDAI_TEAM_ID) || stringOption(file.team_id),
    userId: stringOption(options.userId) || stringOption(process.env.TDAI_USER_ID) || stringOption(file.user_id),
    agentId: stringOption(options.agentId) || stringOption(process.env.TDAI_AGENT_ID) || stringOption(file.agent_id),
    capturePrompts: booleanOption(options.capturePrompts, true),
    captureTools: booleanOption(options.captureTools, true),
    skipTools,
  };
}

function isTrivial(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return (
    /^(\(session in progress\)|\(executed\)|\(ok\)|\(observed\)|\(curated memory\)|ok|\[[a-z-]+\])$/i.test(
      trimmed,
    ) || /^\{"stdout":"","stderr":"",/.test(trimmed)
  );
}

/**
 * Per-session ring of content hashes. OpenCode may replay a prompt or re-report
 * a tool result after a retry, and both would otherwise become duplicate L0
 * rows.
 */
class Deduper {
  private readonly seen = new Map<string, string[]>();

  duplicate(sessionID: string, content: string): boolean {
    const key = crypto.createHash("sha1").update(content).digest("hex").slice(0, 16);
    const recent = this.seen.get(sessionID) ?? [];
    if (recent.includes(key)) return true;
    recent.push(key);
    while (recent.length > DEDUP_WINDOW) recent.shift();
    if (!this.seen.has(sessionID) && this.seen.size >= MAX_SESSIONS) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(sessionID, recent);
    return false;
  }
}

async function add(scope: Scope, sessionID: string, messages: Message[]): Promise<void> {
  if (!scope.endpoint || !scope.apiKey || !messages.length) return;
  try {
    const response = await fetch(`${scope.endpoint}/v3/conversation/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${scope.apiKey}`,
        "x-tdai-service-id": scope.serviceId,
      },
      body: JSON.stringify({
        team_id: scope.teamId,
        user_id: scope.userId,
        agent_id: scope.agentId,
        session_id: sessionID,
        messages,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (DEBUG && !response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`[tdai-capture] add failed: HTTP ${response.status} ${detail}`);
    }
  } catch (error) {
    if (DEBUG) console.error("[tdai-capture] add failed:", (error as Error).message);
  }
}

/** Flatten a tool result into text suitable for L0. */
function resultText(event: { status: string; result?: unknown; error?: unknown }): string {
  if (event.status === "error") {
    const error = event.error as { message?: string; name?: string } | undefined;
    return `error: ${error?.message ?? error?.name ?? "unknown"}`;
  }
  const result = (event.result ?? {}) as { content?: unknown; output?: unknown };
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .map((part) => {
        const item = part as { type?: string; text?: string };
        return item?.type === "text" ? (item.text ?? "") : `[${item?.type ?? "unknown"}]`;
      })
      .join("\n");
  }
  if (result.output != null) {
    return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
  }
  return "";
}

function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function now(): string {
  return new Date().toISOString();
}

export default Plugin.define({
  id: "tencentdb-agent-memory",
  async setup(ctx) {
    const scope = resolveScope(ctx.options ?? {});
    const deduper = new Deduper();

    if (DEBUG) {
      console.error(
        `[tdai-capture] ready; endpoint=${scope.endpoint || "(unset, idle)"} key=${scope.apiKey ? "set" : "missing"} service=${scope.serviceId}`,
      );
    }

    if (scope.capturePrompts) {
      await ctx.session.hook("prompt", (event) => {
        const text = (event.prompt?.text ?? "").trim();
        if (!text || isTrivial(text)) return;
        const sessionID = String(event.sessionID);
        if (deduper.duplicate(sessionID, text)) return;
        const timestamp = now();
        void add(scope, sessionID, [
          { role: "user", content: text.slice(0, 8000), timestamp, recorded_at: timestamp },
        ]);
      });
    }

    if (scope.captureTools) {
      await ctx.tool.hook("execute.after", (event) => {
        if (scope.skipTools.has(String(event.tool).toLowerCase())) return;
        const sessionID = String(event.sessionID);
        const action = `[tool] ${event.tool}: ${summarizeInput(event.input)}`.slice(0, 3000);
        if (isTrivial(action)) return;

        const output = resultText(event).trim();
        if (deduper.duplicate(sessionID, `${action}\0${output.slice(0, 400)}`)) return;

        const timestamp = now();
        void add(scope, sessionID, [
          { role: "user", content: action, timestamp, recorded_at: timestamp },
          {
            role: "assistant",
            content: output ? output.slice(0, 400) : "(ok)",
            timestamp,
            recorded_at: timestamp,
          },
        ]);
      });
    }
  },
});
