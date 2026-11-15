# Claude Code 捕获 Hook（TencentDB Agent Memory）

[English](./README.md) · 简体中文

Claude Code 没有插件 API，因此本适配器通过它的 **hook 机制**捕获：一个 Node 小脚本从 stdin 读取 hook payload，再通过 `POST /v3/conversation/add` 写入 **L0 对话存储**。这样 Claude Code 会话也能和其他客户端一样被蒸馏成 L1/L2/L3 记忆。

本 hook **只负责捕获**。如需通过 Memory Proxy 注入记忆，请参见 [`agents/claude-code/`](../../agents/claude-code/)；两者可以同时使用。

```
Claude Code
  └─ UserPromptSubmit / PostToolUse hook
       └─ tdai-capture.mjs
            ├─ 用户 prompt                 → L0
            └─ 工具名 + 入参 + 结果         → L0
                       │
                       ▼
             POST /v3/conversation/add
       （team_id / user_id / agent_id / session_id）
```

## 环境要求

| 项 | 说明 |
|------|------|
| Node | ≥ 20（使用内置 `fetch`） |
| Gateway | 已运行、暴露 `/v3/conversation/add` 的 MemoryCore 网关 |
| 凭证 | 网关 API key，以及 `team_id` / `user_id` / `agent_id` 隔离三元组 |

本地常见组合：网关 `http://127.0.0.1:8420`、API key `local`、隔离三元组均为 `default`。

## 安装

1. 把脚本放到固定位置并赋予执行权限：

   ```bash
   mkdir -p ~/.claude/hooks
   cp MemoryCore/claude-code-hook/tdai-capture.mjs ~/.claude/hooks/
   chmod +x ~/.claude/hooks/tdai-capture.mjs
   ```

2. 把 [`settings.example.json`](./settings.example.json) 中的条目合并进 `~/.claude/settings.json`：

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

   保留已有 hook 条目；Claude Code 会依次执行所有 hook。

3. 在 Claude Code 里发一条消息，然后确认写入：

   ```bash
   curl -s http://127.0.0.1:8420/search/conversations \
     -H 'Content-Type: application/json' \
     -H 'Authorization: Bearer local' \
     -H 'x-tdai-service-id: default' \
     -d '{"query":"hello","limit":3,
          "team_id":"default","user_id":"default","agent_id":"default"}'
   ```

## 配置

环境变量优先于 `~/.tdai-memory.json`（可用 `TDAI_CONFIG` 覆盖路径），因此同一份配置可以同时服务 OpenCode 插件、本 hook 和召回 MCP server。

| 环境变量 | 配置文件键 | 默认值 | 说明 |
|-----|----------|---------|------|
| `TDAI_ENDPOINT` | `endpoint` | — | 网关地址，必填 |
| `TDAI_KEY` | `key` | — | Bearer token，必填 |
| `TDAI_SERVICE_ID` | — | `default` | 作为 `x-tdai-service-id` 发送 |
| `TDAI_TEAM_ID` | `team_id` | — | 隔离维度 |
| `TDAI_USER_ID` | `user_id` | — | 隔离维度 |
| `TDAI_AGENT_ID` | `agent_id` | — | 隔离维度 |
| `TDAI_STATE` | — | `~/.tdai-capture-dedup.json` | 去重状态文件 |
| `TDAI_CAPTURE_SYNC` | — | 未设置 | 设为 `1` 时改为同步 POST |
| `TDAI_DEBUG` | — | 未设置 | 设为 `1` 时把失败写入 stderr |

`~/.tdai-memory.json` 示例：

```json
{
  "endpoint": "https://memory-api.example.com",
  "key": "sk-...",
  "team_id": "team-...",
  "user_id": "usr-...",
  "agent_id": "agt-..."
}
```

## 捕获内容

| Hook | 事件 | 写入形式 | 上限 |
|------|-------|-----------|------|
| `UserPromptSubmit` | prompt | 一条 `user` 消息 | 8 000 字符 |
| `PostToolUse` | 成功工具 | `user` 动作 + `assistant` 结果 | 3 000 / 400 字符 |
| `PostToolUseFailure` | 失败工具 | `user` 动作 + `assistant` `error: …` | 3 000 / 400 字符 |

降噪策略（不调用任何 LLM）：

- 跳过只读/记账类工具（`Read`、`Grep`、`Glob`、`LS`、`NotebookRead`、`TodoWrite`、`TodoRead`、`WebFetch`、`WebSearch`）。
- 丢弃空内容、纯标记内容、空 shell 输出。
- 每个会话用状态文件做滚动窗口去重（每次 hook 都是新进程，必须落盘）。
- hook 本身不等网络：它派生一个 detached 发送进程后立刻退出。调试时可设 `TDAI_CAPTURE_SYNC=1` 改为同步。

## 排障

| 现象 | 排查 |
|---------|------|
| L0 没有数据 | 用下面的命令手动执行并设置 `TDAI_DEBUG=1` |
| hook 拖慢对话 | 确认没有设置 `TDAI_CAPTURE_SYNC`；默认是异步派生 |
| `401` / `403` | `TDAI_KEY` 应是业务用户 key，而不是 admin key |
| 出现重复记录 | 状态文件损坏时删除 `~/.tdai-capture-dedup.json` |

手动验证：

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"manual-test","prompt":"hello from curl"}' \
  | TDAI_DEBUG=1 node MemoryCore/claude-code-hook/tdai-capture.mjs prompt
```

## 其他客户端

每个 harness 都有自己的适配器，捕获协议一致。

| 客户端 | 适配器 |
|--------|---------|
| OpenCode | [`MemoryCore/opencode-plugin/`](../opencode-plugin/)（捕获）与 [`adapters/opencode/`](../../adapters/opencode/)（代理注入） |
| Codex | [`agents/codex/`](../../agents/codex/) |
| OpenClaw | [`MemoryCore/openclaw-plugin/`](../openclaw-plugin/) |
| Pi | [`MemoryCore/pi-plugin/`](../pi-plugin/) |
| Hermes | [`MemoryCore/hermes-plugin/`](../hermes-plugin/) |
