---
name: agentcall
description: >-
  Give this agent its own US phone number for live calls and SMS. Use when the
  user says 安装 AgentCall Skill or sends https://github.com/LiamZJU/AgentCall.
---

# AgentCall

用户对你说：安装 AgentCall Skill: https://github.com/LiamZJU/AgentCall

这句话的意思是：你要给自己接上一个美国电话号码，用来接打电话和收发短信。不要让用户克隆仓库、安装依赖、改文件或复制 token。用户只在你提问时回复 ok，或提供你拿不到的 Twilio 信息。

不要实现或询问权限、付款规则、审批。这个 Skill 只有三件事：打电话、发短信、按联系人记住通话和短信。

## 安装

1. 如果当前目录不是 `LiamZJU/AgentCall`，克隆 https://github.com/LiamZJU/AgentCall 并进入目录。
2. 运行 `pnpm install`。
3. 运行 `pnpm --filter @agentphone/api agentphone`。
4. stdout 只有一个 JSON。按它的 `instruction` 和 `rerun` 继续，直到 `status` 为 `ready`。stderr 是日志。
5. `needsUser` 为 true 时，把 `ask` 原样问用户。用户回答后，用 `rerun` 带上他给的值再跑。

购买号码前，JSON 会请用户对那一个号码回复 ok。这是唯一需要确认的购买。

## 接到你自己

`status` 为 `ready` 之后，使用 `credentials.wiring` 里对应你的那段，不要把 token 给用户。

- Hermes：把 `credentials.wiring.hermes` 写入 `~/.hermes/config.yaml` 的 `mcp_servers`，然后重新加载 MCP。安装时要传 `--adapter hermes` 和你的 `/api/ws`。语音和短信会由本机桥接进这个会话。
- OpenClaw：按 `credentials.wiring.openclaw` 添加名为 `agentcall` 的 MCP，传输用 streamable-http，带上 Authorization 头。安装时传 `--adapter openclaw`。来电和短信会通过 `openclaw agent --session-key agentcall:<thread>` 进入你的会话。
- 其他 Agent：按 `credentials.wiring.generic` 连接 WebSocket，并添加同一个 MCP。

## 装好之后你能做的事

MCP 工具：

- `phone_call`：拨出电话。`to` 是对方号码。
- `sms_send`：发短信。`to` 和 `body`。
- `phone_thread_get`：读取某个联系人的通话和短信历史。`contact` 是对方号码。

来电时，你只回复要说出来的话。收到短信时，只回复要发回去的文字；不想回就回复 `NO_REPLY`。

告诉用户电话号码。打给这个号码的电话和短信都会到你这里，并按联系人记在同一条 thread 里。
