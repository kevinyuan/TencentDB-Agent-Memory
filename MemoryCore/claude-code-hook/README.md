# Claude Code Capture Hook for TencentDB Agent Memory

[简体中文](./README_CN.md) · English

Claude Code has no plugin API, so this adapter captures through its **hook system**. A small Node script receives each hook payload on stdin and writes it to the **L0 conversation store** via `POST /v3/conversation/add`, so Claude Code sessions are distilled into the same L1/L2/L3 assets as every other client.

This hook **captures only**. For prompt injection through the Memory Proxy, see [`agents/claude-code/`](../../agents/claude-code/); both can be used together.

```
Claude Code
  └─ UserPromptSubmit / PostToolUse hook
       └─ tdai-capture.mjs
            ├─ user prompt                → L0
            └─ tool name + input + result → L0
                       │
                       ▼
             POST /v3/conversation/add
        (team_id / user_id / agent_id / session_id)
```

## Requirements

| Item | Value |
|------|-------|
| Node | ≥ 20 (uses built-in `fetch`) |
| Gateway | A running MemoryCore gateway exposing `/v3/conversation/add` |
| Credentials | A gateway API key plus the `team_id` / `user_id` / `agent_id` isolation triple |

A gateway at `http://127.0.0.1:8420` with API key `local` and the isolation triple `default` is the usual local setup.

## Install

1. Put the script somewhere stable and make it runnable:

   ```bash
   mkdir -p ~/.claude/hooks
   cp MemoryCore/claude-code-hook/tdai-capture.mjs ~/.claude/hooks/
   chmod +x ~/.claude/hooks/tdai-capture.mjs
   ```

2. Merge the hook entries from [`settings.example.json`](./settings.example.json) into
   `~/.claude/settings.json`:

   ```json
   {
     "hooks": {
       "UserPromptSubmit": [
         { "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/hooks/tdai-capture.mjs\" prompt" }] }
       ],
       "PostToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/hooks/tdai-capture.mjs\" tool" }] }
       ],
       "PostToolUseFailure": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/hooks/tdai-capture.mjs\" tool" }] }
       ]
     }
   }
   ```

   Keep any existing hook entries; Claude Code runs all of them.

3. Send one prompt in Claude Code, then check the write:

   ```bash
   curl -s http://127.0.0.1:8420/search/conversations \
     -H 'Content-Type: application/json' \
     -H 'Authorization: Bearer local' \
     -H 'x-tdai-service-id: default' \
     -d '{"query":"hello","limit":3,
          "team_id":"default","user_id":"default","agent_id":"default"}'
   ```

## Configuration

Environment variables win over `~/.tdai-memory.json` (path overridable with `TDAI_CONFIG`), so one file can serve the OpenCode plugin, this hook, and the recall MCP server.

| Env | File key | Default | Notes |
|-----|----------|---------|-------|
| `TDAI_ENDPOINT` | `endpoint` | — | Gateway base URL; required |
| `TDAI_KEY` | `key` | — | Bearer token; required |
| `TDAI_SERVICE_ID` | — | `default` | Sent as `x-tdai-service-id` |
| `TDAI_TEAM_ID` | `team_id` | — | Isolation dimension |
| `TDAI_USER_ID` | `user_id` | — | Isolation dimension |
| `TDAI_AGENT_ID` | `agent_id` | — | Isolation dimension |
| `TDAI_STATE` | — | `~/.tdai-capture-dedup.json` | De-duplication state file |
| `TDAI_CAPTURE_SYNC` | — | unset | `1` posts inline instead of detaching |
| `TDAI_DEBUG` | — | unset | `1` logs failures to stderr |

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

| Hook | Event | Stored as | Limit |
|------|-------|-----------|-------|
| `UserPromptSubmit` | prompt | one `user` message | 8 000 chars |
| `PostToolUse` | successful tool | `user` action + `assistant` result | 3 000 / 400 chars |
| `PostToolUseFailure` | failed tool | `user` action + `assistant` `error: …` | 3 000 / 400 chars |

Noise control, applied without any LLM calls:

- Read-only and bookkeeping tools (`Read`, `Grep`, `Glob`, `LS`, `NotebookRead`, `TodoWrite`, `TodoRead`, `WebFetch`, `WebSearch`) are skipped.
- Empty, marker-only, and empty-shell-output payloads are dropped.
- Repeats are de-duplicated per session using a rolling window in the state file (needed because every hook is a new process).
- The hook itself never waits on the network: it re-spawns a detached sender and exits immediately. Set `TDAI_CAPTURE_SYNC=1` to post inline when debugging.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Nothing in L0 | Run the script by hand with a payload (below) and `TDAI_DEBUG=1` |
| Hook slows the turn | Confirm you did not set `TDAI_CAPTURE_SYNC`; the default detaches |
| `401` / `403` | `TDAI_KEY` must be the business user key, not the admin key |
| Duplicate rows | Delete `~/.tdai-capture-dedup.json` if it was corrupted |

Manual check:

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"manual-test","prompt":"hello from curl"}' \
  | TDAI_DEBUG=1 node MemoryCore/claude-code-hook/tdai-capture.mjs prompt
```

## Other clients

Each harness has its own adapter; the capture protocol is the same.

| Client | Adapter |
|--------|---------|
| OpenCode | [`MemoryCore/opencode-plugin/`](../opencode-plugin/) (capture) and [`adapters/opencode/`](../../adapters/opencode/) (proxy injection) |
| Codex | [`agents/codex/`](../../agents/codex/) |
| OpenClaw | [`MemoryCore/openclaw-plugin/`](../openclaw-plugin/) |
| Pi | [`MemoryCore/pi-plugin/`](../pi-plugin/) |
| Hermes | [`MemoryCore/hermes-plugin/`](../hermes-plugin/) |
