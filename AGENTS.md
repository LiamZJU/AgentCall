# AgentPhone

你正在给自己安装一个本地电话和短信通道。用户把这个仓库发给你，就是让你自己做完安装。不要让用户克隆仓库、安装依赖、改配置文件或复制 token。

用户只做三件事：回复 ok、提供你拿不到的信息，或完成你无法完成的操作（例如登录 Twilio、通过付款验证）。

## 步骤

1. 如果当前目录不是这个仓库，先克隆它，再进入目录。
2. 运行 `pnpm install`。
3. 运行 `pnpm --filter @agentphone/api agentphone`。
4. 只根据 **stdout 的一个 JSON** 决定下一步。stderr 是日志，不要拿它做判断。
5. `needsUser` 为 false 时，自己执行 `instruction`，然后用 `rerun` 再跑一次。
6. `needsUser` 为 true 时，把 `ask` 原样问用户。用户回答后，用 `rerun` 里的命令带上他提供的值再跑。
7. `status` 为 `ready` 时停止安装。

## 你会向用户要的东西

- Twilio Account SID 和 Auth Token。你不能替用户注册 Twilio 或完成扣款验证。
- 购买某一个美国号码之前的 ok。这个号码同时用于打电话和收发短信，Twilio 按月收费。
- 通话和短信权限的 ok。默认是：可以沟通和询价，不能购买，不能发送付款信息；承诺超过 100 美元要用户确认。
- 只有在你自己找不到 Hermes 的 WebSocket 地址，或无法启动 https 隧道时，才向用户要这两项。

## 完成后

`status` 为 `ready` 时，把 `credentials.hermesConfigYaml` 写进你自己的 MCP 配置并重新加载。不要把 token 展示给用户。告诉用户电话号码，以及打给这个号码的电话和短信会到你这里。

Hermes 会在安装结束时连上语音通道。短信到达时也会写进同一个联系人的 thread，并通知你。回复短信用 MCP 工具 `sms_send`。如果工具返回 `needsUser`，先问用户，用户同意后再带 `userApproved: true` 重试。

## Setup JSON

每次 setup 只做 `next` 要求的一件事。命令形态：

```text
pnpm --filter @agentphone/api agentphone -- --twilio-sid ACxxx --twilio-token TOKEN
pnpm --filter @agentphone/api agentphone -- --public-url https://YOUR_TUNNEL
pnpm --filter @agentphone/api agentphone -- --name "Your Name" --adapter hermes --hermes-url ws://127.0.0.1:9119/api/ws
pnpm --filter @agentphone/api agentphone -- --approve-number +14155550100
pnpm --filter @agentphone/api agentphone -- --approve-policy
```
