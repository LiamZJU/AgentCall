import { useEffect, useState } from "react";
import { api, type Health } from "../api";

type Agent = { id: string; name: string };
type Phone = { id: string; agentId: string; e164: string; localOnly: boolean; twilioSid: string | null };
type Available = { phoneNumber: string; locality: string; region: string };

export function NumbersPage({ health }: { health: Health | null }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [numbers, setNumbers] = useState<Phone[]>([]);
  const [agentId, setAgentId] = useState("");
  const [areaCode, setAreaCode] = useState("415");
  const [localNumber, setLocalNumber] = useState("+14155550100");
  const [available, setAvailable] = useState<Available[]>([]);
  const [error, setError] = useState("");

  async function reload() {
    const [agentBody, numberBody] = await Promise.all([
      api<{ agents: Agent[] }>("/v1/agents"),
      api<{ numbers: Phone[] }>("/v1/numbers"),
    ]);
    setAgents(agentBody.agents);
    setNumbers(numberBody.numbers);
    setAgentId((current) => current || agentBody.agents[0]?.id || "");
  }

  useEffect(() => {
    reload().catch((reason: unknown) => setError(text(reason)));
  }, []);

  return (
    <div className="stack">
      <div>
        <h2>电话号码</h2>
        <p className="lede">每个 Agent 绑定一个美国号码。真实购买走 Twilio，本地联调可以绑定一个不存在的号码。</p>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="grid">
        <div className="stack">
          <label>
            Agent
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          {health?.twilio ? (
            <form
              className="card stack"
              onSubmit={(event) => {
                event.preventDefault();
                api<{ numbers: Available[] }>(`/v1/numbers/available?areaCode=${areaCode}`)
                  .then((body) => setAvailable(body.numbers))
                  .catch((reason: unknown) => setError(text(reason)));
              }}
            >
              <label>
                区号
                <input value={areaCode} onChange={(event) => setAreaCode(event.target.value)} />
              </label>
              <button type="submit">搜索可用号码</button>
              {available.map((item) => (
                <div className="row" key={item.phoneNumber}>
                  <span>{item.phoneNumber}</span>
                  <span className="lede">{item.locality} {item.region}</span>
                  <button
                    className="primary"
                    type="button"
                    onClick={() => {
                      api("/v1/numbers", {
                        method: "POST",
                        body: JSON.stringify({ agentId, phoneNumber: item.phoneNumber }),
                      })
                        .then(() => reload())
                        .catch((reason: unknown) => setError(text(reason)));
                    }}
                  >
                    购买并绑定
                  </button>
                </div>
              ))}
            </form>
          ) : null}
          {health?.devSimulate ? (
            <form
              className="card stack"
              onSubmit={(event) => {
                event.preventDefault();
                api("/v1/numbers/local", {
                  method: "POST",
                  body: JSON.stringify({ agentId, e164: localNumber }),
                })
                  .then(() => reload())
                  .catch((reason: unknown) => setError(text(reason)));
              }}
            >
              <label>
                本地号码
                <input value={localNumber} onChange={(event) => setLocalNumber(event.target.value)} />
              </label>
              <button type="submit">绑定本地号码</button>
            </form>
          ) : null}
        </div>
        <table>
          <thead>
            <tr><th>号码</th><th>Agent</th><th>来源</th><th></th></tr>
          </thead>
          <tbody>
            {numbers.map((number) => (
              <tr key={number.id}>
                <td>{number.e164}</td>
                <td>{agents.find((agent) => agent.id === number.agentId)?.name ?? number.agentId}</td>
                <td>{number.localOnly ? "本地" : number.twilioSid}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      api(`/v1/numbers/${number.id}`, { method: "DELETE" })
                        .then(() => reload())
                        .catch((reason: unknown) => setError(text(reason)));
                    }}
                  >
                    释放
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function text(reason: unknown): string {
  return reason instanceof Error ? reason.message : "请求失败";
}
