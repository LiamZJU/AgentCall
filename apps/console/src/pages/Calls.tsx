import { useEffect, useState } from "react";
import { api, type Health } from "../api";

type Agent = { id: string; name: string };
type Phone = { agentId: string; e164: string };
type Call = {
  id: string;
  threadId: string;
  agentId: string;
  direction: string;
  fromE164: string;
  toE164: string;
  status: string;
  objective: string;
  simulated: boolean;
};
type Segment = { id: string; speaker: string; text: string; interrupted: boolean };

export function CallsPage({ health }: { health: Health | null }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [numbers, setNumbers] = useState<Phone[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  const [selected, setSelected] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [partial, setPartial] = useState("");
  const [to, setTo] = useState("");
  const [from, setFrom] = useState("+14155550142");
  const [line, setLine] = useState("Can you price fifty units?");
  const [objective, setObjective] = useState("Get a quote");
  const [callee, setCallee] = useState("+14155550123");
  const [error, setError] = useState("");

  async function reloadCalls() {
    const body = await api<{ calls: Call[] }>("/v1/calls");
    setCalls(body.calls);
    setSelected((current) => current || body.calls[0]?.id || "");
  }

  useEffect(() => {
    Promise.all([
      api<{ agents: Agent[] }>("/v1/agents"),
      api<{ numbers: Phone[] }>("/v1/numbers"),
    ])
      .then(([agentBody, numberBody]) => {
        setAgents(agentBody.agents);
        setNumbers(numberBody.numbers);
        setTo(numberBody.numbers[0]?.e164 ?? "");
      })
      .catch((reason: unknown) => setError(text(reason)));
    reloadCalls().catch((reason: unknown) => setError(text(reason)));
    const timer = setInterval(() => reloadCalls().catch(() => undefined), 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selected) return;
    const load = () => {
      api<{ segments: Segment[]; partial: string }>(`/v1/calls/${selected}`)
        .then((body) => {
          setSegments(body.segments);
          setPartial(body.partial);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, [selected]);

  const agentId = numbers.find((number) => number.e164 === to)?.agentId ?? agents[0]?.id ?? "";

  return (
    <div className="stack">
      <div>
        <h2>通话</h2>
        <p className="lede">来电和外呼都记在 Call 上。模拟来电不经过 Twilio，用来检查 Gateway 和 transcript。</p>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="grid">
        <div className="stack">
          {health?.devSimulate ? (
            <form
              className="card stack"
              onSubmit={(event) => {
                event.preventDefault();
                api<{ call: Call }>("/v1/dev/inbound", {
                  method: "POST",
                  body: JSON.stringify({ to, from }),
                })
                  .then((body) => {
                    setSelected(body.call.id);
                    return reloadCalls();
                  })
                  .catch((reason: unknown) => setError(text(reason)));
              }}
            >
              <strong>模拟来电</strong>
              <label>
                打给
                <select value={to} onChange={(event) => setTo(event.target.value)}>
                  {numbers.map((number) => <option key={number.e164}>{number.e164}</option>)}
                </select>
              </label>
              <label>
                主叫
                <input value={from} onChange={(event) => setFrom(event.target.value)} />
              </label>
              <button className="primary" type="submit">发起</button>
              <label>
                对方说
                <input value={line} onChange={(event) => setLine(event.target.value)} />
              </label>
              <button
                type="button"
                disabled={!selected}
                onClick={() => {
                  api("/v1/dev/prompt", {
                    method: "POST",
                    body: JSON.stringify({ callId: selected, text: line }),
                  }).catch((reason: unknown) => setError(text(reason)));
                }}
              >
                送进当前通话
              </button>
            </form>
          ) : null}
          <form
            className="card stack"
            onSubmit={(event) => {
              event.preventDefault();
              api<{ call: Call }>("/v1/calls", {
                method: "POST",
                body: JSON.stringify({ agentId, to: callee, objective }),
              })
                .then((body) => {
                  setSelected(body.call.id);
                  return reloadCalls();
                })
                .catch((reason: unknown) => setError(text(reason)));
            }}
          >
            <strong>外呼</strong>
            <label>
              目标
              <input value={callee} onChange={(event) => setCallee(event.target.value)} />
            </label>
            <label>
              目标说明
              <input value={objective} onChange={(event) => setObjective(event.target.value)} />
            </label>
            <button type="submit">拨打</button>
          </form>
        </div>
        <div className="stack">
          <table>
            <thead>
              <tr><th>方向</th><th>对方</th><th>状态</th><th>目标</th></tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <tr key={call.id} className={call.id === selected ? "selected" : ""} onClick={() => setSelected(call.id)}>
                  <td>{call.direction}{call.simulated ? " · 模拟" : ""}</td>
                  <td>{call.direction === "inbound" ? call.fromE164 : call.toE164}</td>
                  <td><span className={`pill ${call.status}`}>{call.status}</span></td>
                  <td>{call.objective}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="card transcript">
            {segments.map((segment) => (
              <div key={segment.id} className={`bubble ${segment.speaker}`}>
                <strong>{segment.speaker}</strong> {segment.text}
                {segment.interrupted ? " （被打断）" : ""}
              </div>
            ))}
            {partial ? <div className="bubble agent">{partial}</div> : null}
            {selected ? (
              <button
                type="button"
                onClick={() => api(`/v1/calls/${selected}/hangup`, { method: "POST" }).catch((reason: unknown) => setError(text(reason)))}
              >
                挂断
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function text(reason: unknown): string {
  return reason instanceof Error ? reason.message : "请求失败";
}
