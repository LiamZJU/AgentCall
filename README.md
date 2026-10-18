# AgentCall

安装 AgentCall Skill: https://github.com/LiamZJU/AgentCall

让每一个 Agent 都拥有专属的电话号码，接入通话与短信能力，在现实世界里直接与人沟通、完成任务。

A dedicated phone number for every Agent. Connect voice and SMS to talk to people and get things done in the real world.

把上面这句话发给 Hermes、OpenClaw 或任何其他 Agent。Agent 读取本仓库的 [SKILL.md](SKILL.md)，给自己接上一个美国号码。你只在它提问时回复 ok，或提供它拿不到的 Twilio Account SID 和 Auth Token。

这个号码可以：

- 接听和拨出电话
- 接收和发送短信
- 按联系人保存通话和短信历史。同一个人再次来电或发短信时，记录还在。

Agent 继续使用自己的记忆和工具。AgentCall 只负责这条电话通道。

## 要求

- Node.js 22
- pnpm 10 或更新版本
- Twilio 账号
- 一个公网 HTTPS 地址，用来把来电和短信送回你的电脑

## 给人看的页面

```text
pnpm dev:api
pnpm dev:console
```

控制台在 `http://localhost:5173`，可以查看号码、通话、短信和联系人。安装本身由 Agent 完成。

## 许可

[MIT](LICENSE)
