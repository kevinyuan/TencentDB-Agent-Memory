# OpenCode Capture Plugin for TencentDB Agent Memory

[简体中文](./README_CN.md) · English

Client-only [OpenCode](https://opencode.ai) plugin that streams session activity into TencentDB Agent Memory. Prompts and tool calls are written to the **L0 conversation store** through `POST /v3/conversation/add`, so OpenCode sessions are distilled into the same L1/L2/L3 assets as every other adapter.

This plugin **captures only**. It does not inject memory into the prompt — combine it with the [Memory Proxy adapter](../../adapters/opencode/) if you also want L2/L3 injection, or with the `tencentdb-memory` MCP server for on-demand recall.

```
OpenCode
  └─ tencentdb-agent-memory (this plugin)
       ├─ session hook "prompt"       → user prompt                 → L0
       └─ tool hook  "execute.after"  → tool name + input + result  → L0
                                          │
                                          ▼
                            POST /v3/conversation/add
                     (team_id / user_id / agent_id / session_id)
```

## Requirements

| Item | Value |
|------|-------|
| OpenCode | **2.x** (uses the V2 plugin API, `Plugin.define`) |
| Gateway | A running MemoryCore gateway exposing `/v3/conversation/add` |
| Credentials | A gateway API key plus the `team_id` / `user_id` / `agent_id` isolation triple |
| Node | ≥ 20 (the plugin only uses built-in `fetch`) |

A gateway reachable at `http://127.0.0.1:8420` with API key `local` and the isolation triple `default` is the usual local setup.

## Install

1. Put the plugin where OpenCode can load it. A local checkout works directly:

   ```bash
   ln -s "$PWD/MemoryCore/opencode-plugin" ~/.config/opencode/plugins/tencentdb-agent-memory
   ```

2. Register the directory in `~/.config/opencode/opencode.json`. V2 requires the
   `plugins` array, and a configured local path must be a **directory**:

   ```jsonc
   {
     "plugins": [
       {
         "package": "./plugins/tencentdb-agent-memory",
         "options": {
           "endpoint": "http://127.0.0.1:8420",
           "apiKey": "local",
           "teamId": "default",
           "userId": "default",
           "agentId": "default"
         }
       }
     ]
   }
   ```

   OpenCode reloads plugins when the config or the plugin file changes; no restart
   is normally required.

3. Send one message, then confirm the write:

   ```bash
   curl -s http://127.0.0.1:8420/search/conversations \
     -H 'Content-Type: application/json' \
     -H 'Authorization: Bearer local' \
     -H 'x-tdai-service-id: default' \
     -d '{"query":"hello","limit":3,
          "team_id":"default","user_id":"default","agent_id":"default"}'
   ```

## Configuration

Options are resolved in this order, highest first:

1. plugin `options` in `opencode.json`
2. environment variables
3. `~/.tdai-memory.json` (path overridable with `TDAI_CONFIG`)

| Option | Env | File key | Default | Notes |
|--------|-----|----------|---------|-------|
| `endpoint` | `TDAI_ENDPOINT` | `endpoint` | — | Gateway base URL; required |
| `apiKey` | `TDAI_KEY` | `key` | — | Bearer token; required |
| `serviceId` | `TDAI_SERVICE_ID` | — | `default` | Sent as `x-tdai-service-id` |
| `teamId` | `TDAI_TEAM_ID` | `team_id` | — | Isolation dimension |
| `userId` | `TDAI_USER_ID` | `user_id` | — | Isolation dimension |
| `agentId` | `TDAI_AGENT_ID` | `agent_id` | — | Isolation dimension |
| `capturePrompts` | — | — | `true` | Capture user prompts |
| `captureTools` | — | — | `true` | Capture tool activity |
| `skipTools` | — | — | `[]` | Extra tool names to ignore |

If `endpoint` or `apiKey` is missing the plugin stays idle instead of failing.

Example `~/.tdai-memory.json`:

```json
{
  "endpoint": "https://memory-api.example.com",
  "key": "sk-...",
  "team_id": "team-...",
  "user_id": "usr-...",
  "agent_id": "agt-..."
}
```

## What gets captured

| Event | Stored as | Limit |
|-------|-----------|-------|
| User prompt | one `user` message | 8 000 chars |
| Tool call | one `user` message (`[tool] name: {json}`) | 3 000 chars |
| Tool result | one `assistant` message | 400 chars, `(ok)` when empty |

Noise control, applied without any LLM calls:

- Read-only and bookkeeping tools (`read`, `grep`, `glob`, `list`, `todowrite`, `webfetch`, `websearch`) are skipped.
- Empty, marker-only, and empty-shell-output payloads are dropped.
- Per-session de-duplication ignores repeats from retries and continued turns.
- Requests time out after 4 s and failures are silent, so capture never blocks a session.

Set `TDAI_DEBUG=1` to log load status and failed writes to the server log.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Nothing in L0 | `TDAI_DEBUG=1`, then look for `[tdai-capture]` in `~/.local/share/opencode/log/opencode.log` |
| `failed to load plugin` | OpenCode is V1, or the config still uses `plugin` instead of `plugins`, or the path points at a file instead of a directory |
| `401` / `403` | `apiKey` is the business user key, not the admin key |
| Writes accepted but recall is empty | Distillation is asynchronous; allow a few minutes after the first capture |

## Other agent harnesses

This plugin is **OpenCode-specific** because it depends on OpenCode's V2 plugin hooks. The capture protocol itself is portable, and sibling adapters cover other clients:

| Client | Adapter |
|--------|---------|
| Claude Code | [`agents/claude-code/`](../../agents/claude-code/) (proxy routing), or a `Stop`/`PostToolUse` hook posting to `/v3/conversation/add` |
| Codex | [`agents/codex/`](../../agents/codex/) |
| OpenClaw | [`MemoryCore/openclaw-plugin/`](../openclaw-plugin/) |
| Pi | [`MemoryCore/pi-plugin/`](../pi-plugin/) |
| Hermes | [`MemoryCore/hermes-plugin/`](../hermes-plugin/) |
