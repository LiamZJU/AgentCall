import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, getKey, setKey, type Health } from "./api";
import { AgentsPage } from "./pages/Agents";
import { CallsPage } from "./pages/Calls";
import { NumbersPage } from "./pages/Numbers";
import { ThreadsPage } from "./pages/Threads";

export function App() {
  const [key, setKeyState] = useState(getKey());
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Health>("/health")
      .then(setHealth)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "health failed"));
  }, []);

  return (
    <div className="shell">
      <nav>
        <h1>AgentPhone</h1>
        <label>
          操作员密钥
          <input
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setKeyState(event.target.value);
            }}
          />
        </label>
        <div className="stack">
          <NavLink to="/" end>Agent</NavLink>
          <NavLink to="/numbers">电话号码</NavLink>
          <NavLink to="/calls">通话和短信</NavLink>
          <NavLink to="/threads">Thread</NavLink>
        </div>
        <p className="lede">
          {health ? (health.twilio ? "Twilio 已配置" : "Twilio 未配置，可绑定本地号码") : "正在连接 API"}
        </p>
      </nav>
      <main>
        {error ? <p className="error">{error}</p> : null}
        <Routes>
          <Route path="/" element={<AgentsPage health={health} />} />
          <Route path="/numbers" element={<NumbersPage health={health} />} />
          <Route path="/calls" element={<CallsPage health={health} />} />
          <Route path="/threads" element={<ThreadsPage />} />
        </Routes>
      </main>
    </div>
  );
}
