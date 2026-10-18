import { useEffect, useState } from "react";
import { api, type Health } from "../api";

type Agent = {
  id: string;
  name: string;
  adapter: string;
  status: string;
  adapterConfig: Record<string, unknown>;
  voice: { language: string; ttsProvider: string; voice: string };
};

export function AgentsPage({ health }: { health: Health | null }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("Front desk");
  const [adapter, setAdapter] = useState("hermes");
  const [issued, setIssued] = useState<{ id: string; token: string } | null>(null);
  const [connectUrl, setConnectUrl] = useState("");
  const [error, setError] = useState("");

  async function reload() {
    const body = await api<{ agents: Agent[] }>("/v1/agents");
    setAgents(body.agents);
  }

  useEffect(() => {
    reload().catch((reason: unknown) => setError(message(reason)));
    const timer = setInterval(() => reload().catch(() => undefined), 2000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="stack">
      <div>
        <h2>Agent</h2>
        <p className="lede">把这个 GitHub 仓库发给用户的 Agent。Agent 会按仓库里的说明自己装好电话和短信。用户只在 Agent 提问时说可以，或补上 Agent 拿不到的信息。</p>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="card stack">
        <strong>服务已经启动时的连接页</strong>
        <p className="lede">平时把仓库发给 Agent 即可。如果服务已经在本地跑着，也可以把下面的链接发给它。</p>
        <button
          className="primary"
          type="button"
          onClick={() => {
            api<{ url: string }>("/v1/connect", { method: "POST" })
              .then((body) => setConnectUrl(body.url))
              .catch((reason: unknown) => setError(message(reason)));
          }}
        >
          生成连接链接
        </button>
        {connectUrl ? <div className="token">{connectUrl}</div> : null}
      </div>
      <div className="grid">
        <form
          className="card stack"
          onSubmit={(event) => {
            event.preventDefault();
            setError("");
            api<{ agent: Agent; token: string }>("/v1/agents", {
              method: "POST",
              body: JSON.stringify({ name, adapter }),
            })
              .then((body) => {
                setIssued({ id: body.agent.id, token: body.token });
                return reload();
              })
              .catch((reason: unknown) => setError(message(reason)));
          }}
        >
          <label>
            名称
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            适配器
            <select value={adapter} onChange={(event) => setAdapter(event.target.value)}>
              <option value="hermes">Hermes</option>
              <option value="generic">Generic</option>
              <option value="openclaw">OpenClaw（下一阶段）</option>
            </select>
          </label>
          <button className="primary" type="submit">创建</button>
        </form>
        <div className="stack">
          {issued ? (
            <div className="card stack">
              <strong>Token 只显示这一次</strong>
              <div className="token">{issued.token}</div>
              <div className="token">{commands(issued.id, issued.token, health?.publicBaseUrl ?? "http://127.0.0.1:8787")}</div>
              <button type="button" onClick={() => setIssued(null)}>收起</button>
            </div>
          ) : null}
          <table>
            <thead>
              <tr><th>名称</th><th>适配器</th><th>状态</th><th></th></tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <td>{agent.name}<div className="lede">{agent.id}</div></td>
                  <td>{agent.adapter}</td>
                  <td><span className={`pill ${agent.status}`}>{agent.status}</span></td>
                  <td>
                    <button
                      type="button"
                      onClick={() => {
                        api<{ token: string }>(`/v1/agents/${agent.id}/token`, { method: "POST" })
                          .then((body) => setIssued({ id: agent.id, token: body.token }))
                          .catch((reason: unknown) => setError(message(reason)));
                      }}
                    >
                      轮换 token
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function commands(agentId: string, token: string, url: string): string {
  return [
    "Generic echo:",
    `pnpm --filter @agentphone/echo-agent start -- --url ${url} --agent ${agentId} --token ${token}`,
    "",
    "Hermes:",
    `pnpm --filter @agentphone/adapter-hermes start -- --agentphone-url ${url} --agent ${agentId} --token ${token} --hermes-url ws://127.0.0.1:9119/api/ws`,
    "",
    "MCP:",
    `url: ${url}/mcp`,
    `Authorization: Bearer ${token}`,
  ].join("\n");
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "请求失败";
}
