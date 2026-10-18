import { useEffect, useState } from "react";
import { api } from "../api";

type Agent = { id: string; name: string };
type Policy = {
  id: string;
  agentId: string;
  name: string;
  objective: string;
  allowedActions: string[];
  forbiddenActions: string[];
  approvalRules: Array<{ action: string; when: unknown }>;
  isDefault: boolean;
};
type Approval = {
  id: string;
  callId: string;
  action: string;
  payload: Record<string, unknown>;
  status: string;
  note: string | null;
};

export function PermissionsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [name, setName] = useState("报价，不购买");
  const [objective, setObjective] = useState("Get a quote for 50 units. Do not purchase.");
  const [allowed, setAllowed] = useState("ask_price, commit_price, schedule_callback");
  const [forbidden, setForbidden] = useState("purchase, share_payment_details, agree_contract");
  const [rules, setRules] = useState('[{"action":"commit_price","when":{"amountUsdGt":100}}]');
  const [error, setError] = useState("");

  async function reload() {
    const [agentBody, policyBody, approvalBody] = await Promise.all([
      api<{ agents: Agent[] }>("/v1/agents"),
      api<{ policies: Policy[] }>("/v1/policies"),
      api<{ approvals: Approval[] }>("/v1/approvals"),
    ]);
    setAgents(agentBody.agents);
    setPolicies(policyBody.policies);
    setApprovals(approvalBody.approvals);
    setAgentId((current) => current || agentBody.agents[0]?.id || "");
  }

  useEffect(() => {
    reload().catch((reason: unknown) => setError(text(reason)));
    const timer = setInterval(() => reload().catch(() => undefined), 2000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="stack">
      <div>
        <h2>权限</h2>
        <p className="lede">每次通话带上 objective、允许和禁止的动作。超过规则的动作会停在这里等人工确认。Agent 自己的浏览器和邮件工具不在这个门里。</p>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="grid">
        <form
          className="card stack"
          onSubmit={(event) => {
            event.preventDefault();
            let approvalRules: unknown;
            try {
              approvalRules = JSON.parse(rules);
            } catch {
              setError("审批规则需要是 JSON");
              return;
            }
            api("/v1/policies", {
              method: "POST",
              body: JSON.stringify({
                agentId,
                name,
                objective,
                allowedActions: split(allowed),
                forbiddenActions: split(forbidden),
                approvalRules,
                isDefault: true,
              }),
            })
              .then(() => reload())
              .catch((reason: unknown) => setError(text(reason)));
          }}
        >
          <label>
            Agent
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          <label>
            名称
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Objective
            <textarea value={objective} onChange={(event) => setObjective(event.target.value)} />
          </label>
          <label>
            允许，逗号分隔
            <input value={allowed} onChange={(event) => setAllowed(event.target.value)} />
          </label>
          <label>
            禁止，逗号分隔
            <input value={forbidden} onChange={(event) => setForbidden(event.target.value)} />
          </label>
          <label>
            审批规则
            <textarea value={rules} onChange={(event) => setRules(event.target.value)} />
          </label>
          <button className="primary" type="submit">设为默认策略</button>
        </form>
        <div className="stack">
          <table>
            <thead>
              <tr><th>策略</th><th>Agent</th><th>默认</th></tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id}>
                  <td>
                    {policy.name}
                    <div className="lede">{policy.objective}</div>
                  </td>
                  <td>{agents.find((agent) => agent.id === policy.agentId)?.name ?? policy.agentId}</td>
                  <td>{policy.isDefault ? "是" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table>
            <thead>
              <tr><th>动作</th><th>状态</th><th>载荷</th><th></th></tr>
            </thead>
            <tbody>
              {approvals.map((approval) => (
                <tr key={approval.id}>
                  <td>{approval.action}</td>
                  <td><span className={`pill ${approval.status}`}>{approval.status}</span></td>
                  <td>{JSON.stringify(approval.payload)}</td>
                  <td>
                    {approval.status === "pending" ? (
                      <div className="row">
                        <button type="button" onClick={() => decide(approval.id, "approved")}>批准</button>
                        <button type="button" onClick={() => decide(approval.id, "rejected")}>拒绝</button>
                      </div>
                    ) : approval.note}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  function decide(id: string, decision: "approved" | "rejected") {
    api(`/v1/approvals/${id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    })
      .then(() => reload())
      .catch((reason: unknown) => setError(text(reason)));
  }
}

function split(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function text(reason: unknown): string {
  return reason instanceof Error ? reason.message : "请求失败";
}
