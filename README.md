# AgentCall

让每一个 Agent 都拥有专属的电话号码，接入通话与短信能力，在现实世界里直接与人沟通、完成任务。

A dedicated phone number for every Agent. Connect voice and SMS to talk to people and get things done in the real world.

AgentCall 不替换你的 Agent。Hermes、OpenClaw 或自建 Agent 继续使用自己的记忆、工具和性格。这个仓库只增加一条电话通道：一个美国号码、实时语音、短信，以及按联系人延续的对话。

## 交给 Agent

把本仓库发给你的 Agent。它会阅读 [AGENTS.md](AGENTS.md)，自己完成安装。

你只需要：

- 回复 **ok**
- 提供它拿不到的信息，例如 Twilio Account SID 和 Auth Token
- 完成它无法代劳的操作，例如登录 Twilio 或通过付款验证

你不需要克隆仓库、安装依赖、编辑配置，或复制 token。

## 这个号码能做什么

| | |
|---|---|
| 通话 | 接听、拨出、回拨。语音由 Twilio ConversationRelay 转写和播报，Agent 仍负责回答。 |
| 短信 | 接收和发送。短信和通话记在同一个联系人的 thread 里。 |
| 记忆 | 对方再次来电或发短信时，Agent 能看到历史、摘要、当前目标和未完成事项。 |
| 权限 | 每次通话可以限定目标、允许的动作和禁止的动作。例如可以询价，不能购买；超过 $100 必须你确认。 |

通话过程中，Agent 仍可调用自己的日历、邮件和浏览器。AgentCall 不代替它做业务判断。

## Agent 的安装入口

在仓库目录中：

```text
pnpm install
pnpm --filter @agentphone/api agentphone
```

命令在 stdout 输出一个 JSON。Agent 按其中的 `instruction` 和 `rerun` 继续，直到 `status` 为 `ready`。`needsUser` 为 true 时，它才会用 `ask` 向你提问。

完成后，Agent 把返回的 MCP 配置写入自己，不要把 token 给你看。它会告诉你电话号码。打给这个号码的电话和短信都会到达它。

完整约束在 [AGENTS.md](AGENTS.md)。

## 运行要求

- Node.js 22
- pnpm 10+
- 一个 Twilio 账号，以及可公网访问的 HTTPS 地址，用来接收来电和短信

语音不自建 SIP。短信走 Twilio Programmable Messaging。

## 本地控制台

服务跑起来之后，可以打开控制台查看 Agent、号码、通话、thread 和权限：

```text
pnpm dev:api
pnpm dev:console
```

控制台在 `http://localhost:5173`。API 在 `http://127.0.0.1:8787`。这是给人看的界面。安装本身仍由 Agent 完成。

## 许可

[MIT](LICENSE)
