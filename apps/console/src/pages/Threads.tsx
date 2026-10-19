import { useEffect, useState } from "react";
import { api } from "../api";

type Turn = { id: string; channel: string; who: string; text: string; createdAt: string };

type Thread = {
  id: string;
  agentId: string;
  contactE164: string;
  callbackStatus: string;
  callbackAt: string | null;
  callbackNote: string | null;
};

export function ThreadsPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [callbackAt, setCallbackAt] = useState("");
  const [error, setError] = useState("");

  async function reload() {
    const body = await api<{ threads: Thread[] }>("/v1/threads");
    setThreads(body.threads);
    setSelected((current) => current || body.threads[0]?.id || "");
  }

  useEffect(() => {
    reload().catch((reason: unknown) => setError(text(reason)));
    const timer = setInterval(() => reload().catch(() => undefined), 3000);
    return () => clearInterval(timer);
  }, []);

  const thread = threads.find((item) => item.id === selected);

  useEffect(() => {
    if (!selected) return;
    api<{ turns: Turn[] }>(`/v1/threads/${selected}`)
      .then((body) => setTurns(body.turns))
      .catch(() => undefined);
  }, [selected, threads]);

  return (
    <div className="stack">
      <div>
        <h2>联系人</h2>
        <p className="lede">同一个人的电话和短信记在同一份记录里，按时间排列。</p>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="grid">
        <table>
          <thead>
            <tr><th>联系人</th><th>回拨</th></tr>
          </thead>
          <tbody>
            {threads.map((item) => (
              <tr key={item.id} className={item.id === selected ? "selected" : ""} onClick={() => setSelected(item.id)}>
                <td>{item.contactE164}</td>
                <td><span className={`pill ${item.callbackStatus}`}>{item.callbackStatus}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {thread ? (
          <form
            className="card stack"
            onSubmit={(event) => {
              event.preventDefault();
              api(`/v1/threads/${thread.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  callbackStatus: callbackAt ? "scheduled" : thread.callbackStatus,
                  callbackAt: callbackAt ? new Date(callbackAt).toISOString() : thread.callbackAt,
                }),
              })
                .then(() => reload())
                .catch((reason: unknown) => setError(text(reason)));
            }}
          >
            <label>
              预约回拨
              <input type="datetime-local" value={callbackAt} onChange={(event) => setCallbackAt(event.target.value)} />
            </label>
            <div className="row">
              <button className="primary" type="submit">保存回拨</button>
              <button
                type="button"
                onClick={() => {
                  api("/v1/calls", {
                    method: "POST",
                    body: JSON.stringify({
                      agentId: thread.agentId,
                      to: thread.contactE164,
                    }),
                  }).catch((reason: unknown) => setError(text(reason)));
                }}
              >
                现在回拨
              </button>
            </div>
            <p className="lede">当前回拨：{thread.callbackStatus} {thread.callbackAt ?? ""} {thread.callbackNote ?? ""}</p>
            <div className="transcript">
              {turns.map((turn) => (
                <div key={turn.id} className={`bubble ${turn.who}`}>
                  <strong>{turn.channel === "sms" ? "短信" : "电话"} · {turn.who === "agent" ? "我说" : turn.who === "contact" ? "对方" : "系统"}</strong> {turn.text}
                </div>
              ))}
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function text(reason: unknown): string {
  return reason instanceof Error ? reason.message : "请求失败";
}
