# OpenCode 捕获插件（TencentDB Agent Memory）

[English](./README.md) · 简体中文

这是一个纯客户端的 [OpenCode](https://opencode.ai) 插件，把会话活动写入 TencentDB Agent Memory。用户 prompt 与工具调用通过 `POST /v3/conversation/add` 写入 **L0 对话存储**，因此 OpenCode 会话能和其他客户端一样，被蒸馏成 L1/L2/L3 记忆资产。

本插件**只负责捕获**，不会向 prompt 注入记忆。如果需要 L2/L3 注入，请配合 [Memory Proxy 适配器](../../adapters/opencode/)；如果需要按需召回，请配合 `tencentdb-memory` MCP server。

```
OpenCode
  └─ tencentdb-agent-memory（本插件）
       ├─ session hook "prompt"       → 用户 prompt                → L0
       └─ tool hook  "execute.after"  → 工具名 + 入参 + 结果        → L0
                                          │
                                          ▼
                            POST /v3/conversation/add
                     （team_id / user_id / agent_id / session_id）
```

## 环境要求

| 项 | 说明 |
|------|------|
| OpenCode | **2.x**（使用 V2 插件 API：`Plugin.define`） |
| Gateway | 已运行、暴露 `/v3/conversation/add` 的 MemoryCore 网关 |
| 凭证 | 网关 API key，以及 `team_id` / `user_id` / `agent_id` 隔离三元组 |
| Node | ≥ 20（插件只使用内置 `fetch`） |

本地常见组合：网关 `http://127.0.0.1:8420`、API key `local`、隔离三元组均为 `default`。

## 安装

1. 把插件放到 OpenCode 能加载的位置。直接软链本地仓库即可：

   ```bash
   ln -s "$PWD/MemoryCore/opencode-plugin" ~/.config/opencode/plugins/tencentdb-agent-memory
   ```

2. 在 `~/.config/opencode/opencode.json` 中注册目录。V2 使用 `plugins` 数组，且本地路径必须是**目录**：

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

   OpenCode 会在配置或插件文件变化时自动重载，通常无需重启。

3. 发送一条消息，然后确认写入：

   ```bash
   curl -s http://127.0.0.1:8420/search/conversations \
     -H 'Content-Type: application/json' \
     -H 'Authorization: Bearer local' \
     -H 'x-tdai-service-id: default' \
     -d '{"query":"hello","limit":3,
          "team_id":"default","user_id":"default","agent_id":"default"}'
   ```

## 配置

优先级从高到低：

1. `opencode.json` 里的插件 `options`
2. 环境变量
3. `~/.tdai-memory.json`（可用 `TDAI_CONFIG` 覆盖路径）

| 选项 | 环境变量 | 配置文件键 | 默认值 | 说明 |
|--------|-----|----------|---------|------|
| `endpoint` | `TDAI_ENDPOINT` | `endpoint` | — | 网关地址，必填 |
| `apiKey` | `TDAI_KEY` | `key` | — | Bearer token，必填 |
| `serviceId` | `TDAI_SERVICE_ID` | — | `default` | 作为 `x-tdai-service-id` 发送 |
| `teamId` | `TDAI_TEAM_ID` | `team_id` | — | 隔离维度 |
| `userId` | `TDAI_USER_ID` | `user_id` | — | 隔离维度 |
| `agentId` | `TDAI_AGENT_ID` | `agent_id` | — | 隔离维度 |
| `capturePrompts` | — | — | `true` | 是否捕获用户 prompt |
| `captureTools` | — | — | `true` | 是否捕获工具活动 |
| `skipTools` | — | — | `[]` | 额外忽略的工具名 |

缺少 `endpoint` 或 `apiKey` 时插件保持静默空闲，不会报错。

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

| 事件 | 写入形式 | 上限 |
|-------|-----------|------|
| 用户 prompt | 一条 `user` 消息 | 8 000 字符 |
| 工具调用 | 一条 `user` 消息（`[tool] 名称: {json}`） | 3 000 字符 |
| 工具结果 | 一条 `assistant` 消息 | 400 字符，空则写 `(ok)` |

降噪策略（不调用任何 LLM）：

- 跳过只读/记账类工具（`read`、`grep`、`glob`、`list`、`todowrite`、`webfetch`、`websearch`）。
- 丢弃空内容、纯标记内容、空 shell 输出。
- 每个会话内部去重，避免重试和续轮产生重复 L0。
- 请求 4 s 超时且失败静默，捕获永远不会阻塞会话。

设置 `TDAI_DEBUG=1` 可在服务端日志中看到加载状态和失败写入。

## 排障

| 现象 | 排查 |
|---------|------|
| L0 没有数据 | 设置 `TDAI_DEBUG=1`，在 `~/.local/share/opencode/log/opencode.log` 中查找 `[tdai-capture]` |
| `failed to load plugin` | OpenCode 版本是 V1；或配置仍写 `plugin`（应为 `plugins`）；或路径指向文件而非目录 |
| `401` / `403` | `apiKey` 应使用业务用户 key，而不是 admin key |
| 写入成功但召回为空 | 蒸馏是异步的，首次捕获后请等待几分钟 |

## 其他客户端

本插件依赖 OpenCode 的 V2 插件 hook，因此**仅适用于 OpenCode**。捕获协议本身是可移植的，其他客户端有各自的适配器：

| 客户端 | 适配器 |
|--------|---------|
| Claude Code | [`agents/claude-code/`](../../agents/claude-code/)（代理路由），或在 `Stop`/`PostToolUse` hook 中 POST `/v3/conversation/add` |
| Codex | [`agents/codex/`](../../agents/codex/) |
| OpenClaw | [`MemoryCore/openclaw-plugin/`](../openclaw-plugin/) |
| Pi | [`MemoryCore/pi-plugin/`](../pi-plugin/) |
| Hermes | [`MemoryCore/hermes-plugin/`](../hermes-plugin/) |
