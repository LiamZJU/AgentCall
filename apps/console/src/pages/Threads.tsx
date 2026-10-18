import { useEffect, useState } from "react";
import { api } from "../api";

type Sms = { id: string; direction: string; fromE164: string; body: string; status: string };

type Thread = {
  id: string;
  agentId: string;
  contactE164: string;
  summary: string;
  currentGoal: string;
  pendingState: Record<string, unknown>;
  callbackStatus: string;
  callbackAt: string | null;
  callbackNote: string | null;
};

export function ThreadsPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState("");
  const [summary, setSummary] = useState("");
  const [goal, setGoal] = useState("");
  const [pending, setPending] = useState("{}");
  const [callbackAt, setCallbackAt] = useState("");
  const [messages, setMessages] = useState<Sms[]>([]);
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
    api<{ messages: Sms[] }>(`/v1/threads/${selected}`)
      .then((body) => setMessages(body.messages))
      .catch(() => undefined);
  }, [selected, threads]);

  useEffect(() => {
    if (!thread) return;
    setSummary(thread.summary);
    setGoal(thread.currentGoal);
    setPending(JSON.stringify(thread.pendingState, null, 2));
  }, [thread?.id]);

  return (
    <div className="stack">
      <div>
        <h2>Thread</h2>
        <p className="lede">同一个联系人的多次通话共用一条 thread。再次来电会带上摘要、目标和 pending。</p>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="grid">
        <table>
          <thead>
            <tr><th>联系人</th><th>目标</th><th>回拨</th></tr>
          </thead>
          <tbody>
            {threads.map((item) => (
              <tr key={item.id} className={item.id === selected ? "selected" : ""} onClick={() => setSelected(item.id)}>
                <td>{item.contactE164}</td>
                <td>{item.currentGoal || item.summary}</td>
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
              let pendingState: Record<string, unknown> = {};
              try {
                pendingState = JSON.parse(pending) as Record<string, unknown>;
              } catch {
                setError("pending 需要是 JSON 对象");
                return;
              }
              api(`/v1/threads/${thread.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  summary,
                  currentGoal: goal,
                  pendingState,
                  callbackStatus: callbackAt ? "scheduled" : thread.callbackStatus,
                  callbackAt: callbackAt ? new Date(callbackAt).toISOString() : thread.callbackAt,
                }),
              })
                .then(() => reload())
                .catch((reason: unknown) => setError(text(reason)));
            }}
          >
            <label>
              摘要
              <textarea value={summary} onChange={(event) => setSummary(event.target.value)} />
            </label>
            <label>
              当前目标
              <input value={goal} onChange={(event) => setGoal(event.target.value)} />
            </label>
            <label>
              Pending
              <textarea value={pending} onChange={(event) => setPending(event.target.value)} />
            </label>
            <label>
              预约回拨
              <input type="datetime-local" value={callbackAt} onChange={(event) => setCallbackAt(event.target.value)} />
            </label>
            <div className="row">
              <button className="primary" type="submit">保存</button>
              <button
                type="button"
                onClick={() => {
                  api("/v1/calls", {
                    method: "POST",
                    body: JSON.stringify({
                      agentId: thread.agentId,
                      to: thread.contactE164,
                      objective: goal || thread.currentGoal,
                    }),
                  }).catch((reason: unknown) => setError(text(reason)));
                }}
              >
                现在回拨
              </button>
            </div>
            <p className="lede">当前回拨：{thread.callbackStatus} {thread.callbackAt ?? ""} {thread.callbackNote ?? ""}</p>
            <p className="lede">短信</p>
            <div className="transcript">
              {messages.map((message) => (
                <div key={message.id} className={`bubble ${message.direction === "outbound" ? "agent" : "contact"}`}>
                  <strong>{message.direction === "outbound" ? "发出" : "收到"}</strong> {message.body}
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
