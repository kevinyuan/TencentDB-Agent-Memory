#!/usr/bin/env node
/**
 * TencentDB Agent Memory — Claude Code capture hook.
 *
 * Claude Code has no plugin API, so capture happens through its hook system:
 * `UserPromptSubmit` and `PostToolUse`/`PostToolUseFailure` pipe a JSON payload
 * to stdin, and this script forwards it to `/v3/conversation/add`.
 *
 *   UserPromptSubmit              → user prompt                 → L0
 *   PostToolUse / Failure         → tool name + input + result  → L0
 *
 * Design notes:
 * - Hooks block the turn, so the default mode re-spawns a detached sender and
 *   exits immediately. Set TDAI_CAPTURE_SYNC=1 to post inline instead.
 * - Fire-and-forget: the sender never reports failures, times out after 4 s,
 *   and always exits 0.
 * - Noise control without LLM calls: read-only tools are skipped, output is
 *   truncated, empty markers are dropped, and repeats are de-duplicated per
 *   session using a small state file.
 * - Configuration comes from plugin-style env vars or `~/.tdai-memory.json`,
 *   the same file used by the OpenCode plugin and the recall MCP server.
 *
 * Usage:
 *   node tdai-capture.mjs prompt   # UserPromptSubmit hook
 *   node tdai-capture.mjs tool     # PostToolUse / PostToolUseFailure hook
 *
 * The event name is also read from the payload, so the argument is optional.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEBUG = process.env.TDAI_DEBUG === "1";
const SEND_MODE = process.argv.includes("--send");
const SYNC = process.env.TDAI_CAPTURE_SYNC === "1";

const CONFIG_PATH = process.env.TDAI_CONFIG || path.join(os.homedir(), ".tdai-memory.json");
const STATE_PATH = process.env.TDAI_STATE || path.join(os.homedir(), ".tdai-capture-dedup.json");

const DEDUP_WINDOW = 8;
const MAX_SESSIONS = 80;
const SKIP_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "notebookread",
  "todowrite",
  "todoread",
  "webfetch",
  "websearch",
]);

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {}

  return {
    endpoint: (process.env.TDAI_ENDPOINT || file.endpoint || "").replace(/\/$/, ""),
    key: process.env.TDAI_KEY || file.key || "",
    serviceId: process.env.TDAI_SERVICE_ID || "default",
    teamId: process.env.TDAI_TEAM_ID || file.team_id,
    userId: process.env.TDAI_USER_ID || file.user_id,
    agentId: process.env.TDAI_AGENT_ID || file.agent_id,
  };
}

function isTrivial(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return true;
  return (
    /^(\(session in progress\)|\(executed\)|\(ok\)|\(observed\)|\(curated memory\)|ok|\[[a-z-]+\])$/i.test(
      trimmed,
    ) || /^\{"stdout":"","stderr":"",/.test(trimmed)
  );
}

function inferKind(event) {
  const name = String(event.hook_event_name || event.hookEventName || "").toLowerCase();
  if (name === "userpromptsubmit" || event.prompt != null || event.userPrompt != null) return "prompt";
  if (name.startsWith("posttooluse") || event.tool_name != null || event.toolName != null) return "tool";
  return "";
}

function buildMessages(kind, event) {
  const now = new Date().toISOString();
  const at = { timestamp: now, recorded_at: now };

  if (kind === "prompt") {
    const prompt = String(event.prompt ?? event.userPrompt ?? "").trim();
    if (!prompt || isTrivial(prompt)) return [];
    return [{ role: "user", content: prompt.slice(0, 8000), ...at }];
  }

  const name = String(event.tool_name || event.toolName || "tool");
  if (SKIP_TOOLS.has(name.toLowerCase())) return [];

  const input = event.tool_input ?? event.toolInput ?? event.input;
  const serialized = typeof input === "object" && input !== null ? JSON.stringify(input) : String(input ?? "");
  const action = `[tool] ${name}: ${serialized}`.slice(0, 3000);
  if (isTrivial(action)) return [];

  const failed =
    String(event.hook_event_name || "").toLowerCase() === "posttoolusefailure" || event.error != null;
  let output;
  if (failed) {
    output = `error: ${typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? "unknown")}`;
  } else {
    const response = event.tool_response ?? event.toolResponse ?? event.response;
    output =
      typeof response === "object" && response !== null ? JSON.stringify(response) : String(response ?? "");
  }
  output = output.trim();

  return [
    { role: "user", content: action, ...at },
    { role: "assistant", content: output ? output.slice(0, 400) : "(ok)", ...at },
  ];
}

function isDuplicate(sessionID, content) {
  const key = crypto.createHash("sha1").update(content).digest("hex").slice(0, 16);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) || {};
  } catch {}

  const recent = Array.isArray(state[sessionID]) ? state[sessionID] : [];
  if (recent.includes(key)) return true;

  recent.push(key);
  while (recent.length > DEDUP_WINDOW) recent.shift();
  state[sessionID] = recent;

  const keys = Object.keys(state);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete state[stale];
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch {}
  return false;
}

async function post(config, sessionID, messages) {
  try {
    const response = await fetch(`${config.endpoint}/v3/conversation/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.key}`,
        "x-tdai-service-id": config.serviceId,
      },
      body: JSON.stringify({
        team_id: config.teamId,
        user_id: config.userId,
        agent_id: config.agentId,
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
    if (DEBUG) console.error("[tdai-capture] add failed:", error?.message ?? error);
  }
}

function spawnSender(raw) {
  try {
    const child = spawn(process.execPath, [process.argv[1], "--send"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.stdin.end(raw);
    child.unref();
  } catch (error) {
    if (DEBUG) console.error("[tdai-capture] spawn failed:", error?.message ?? error);
  }
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  if (!event || typeof event !== "object") return;

  const kind = (process.argv.includes("prompt") && "prompt") ||
    (process.argv.includes("tool") && "tool") ||
    inferKind(event);
  if (!kind) return;

  // Cheap filtering happens before spawning so read-only traffic stays cheap.
  const messages = buildMessages(kind, event);
  if (!messages.length) return;

  if (!SEND_MODE && !SYNC) {
    spawnSender(raw);
    return;
  }

  const config = loadConfig();
  if (!config.endpoint || !config.key) return;

  const sessionID = String(event.session_id || event.sessionId || "claude-code");
  if (isDuplicate(sessionID, messages[0].content)) return;

  await post(config, sessionID, messages);
}

main()
  .catch((error) => {
    if (DEBUG) console.error("[tdai-capture] failed:", error?.message ?? error);
  })
  .finally(() => {
    // Hooks must never block or fail a turn.
    process.exit(0);
  });
