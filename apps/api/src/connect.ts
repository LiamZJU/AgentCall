import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { isUsE164, normalizeE164, type ApprovalRule, type Policy } from "@agentphone/protocol";
import { z } from "zod";
import { ensureHermesBridge } from "./bridges.js";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { log } from "./log.js";
import type { Store } from "./store.js";
import type { ConnectSessionView } from "./store.js";
import { buyUsNumber, releaseSid, searchUsNumbers, twilioConfigured } from "./twilio.js";

const ADAPTERS = new Set(["hermes", "generic", "openclaw"]);

const policyShape = z.object({
  name: z.string().default("电话权限"),
  objective: z.string().default(""),
  allowedActions: z.array(z.string()).default([]),
  forbiddenActions: z.array(z.string()).default([]),
  approvalRules: z
    .array(
      z.object({
        action: z.string(),
        when: z.union([z.literal("always"), z.object({ amountUsdGt: z.number() })]),
      }),
    )
    .default([]),
});

const policyTemplate: Policy = {
  objective: "可以询价和确认回拨，不能购买，也不能提供付款信息。",
  allowedActions: ["ask_price", "commit_price", "schedule_callback"],
  forbiddenActions: ["purchase", "share_payment_details", "agree_contract"],
  approvalRules: [{ action: "commit_price", when: { amountUsdGt: 100 } }],
};

export function registerConnect(
  app: FastifyInstance,
  services: { config: AppConfig; store: Store; guard: preHandlerHookHandler },
): void {
  const { config, store } = services;

  app.post("/v1/connect", { preHandler: services.guard }, async () => {
    const session = store.createConnectSession();
    const url = pageUrl(config, session.code);
    log(`connect link ${session.code}`, { url });
    return { code: session.code, url, expiresAt: session.expiresAt };
  });

  app.get("/connect/:code", async (request, reply) => {
    const session = load(store, codeOf(request));
    reply.type("text/html; charset=utf-8");
    return renderPage(config, session);
  });

  app.get("/v1/connect/:code", async (request) => {
    const session = load(store, codeOf(request));
    return protocol(config, session, audience(request));
  });

  app.get("/v1/connect/:code/available-numbers", async (request) => {
    const session = load(store, codeOf(request));
    requireStatus(session, ["awaiting_number_request", "pending_number_authorization"]);
    if (!twilioConfigured(config)) {
      return {
        mode: "local",
        numbers: [],
        instruction: "当前没有 Twilio。请 POST /v1/connect/{code}/number，body 为 {\"e164\":\"+1...\"}。用户确认后会绑定这个本地号码。",
      };
    }
    const areaCode = (request.query as { areaCode?: string }).areaCode ?? "";
    if (!/^\d{3}$/.test(areaCode)) throw new HttpError(400, "areaCode must be 3 digits");
    return { mode: "twilio", numbers: await searchUsNumbers(config, areaCode) };
  });

  app.post("/v1/connect/:code/claim", async (request) => {
    const session = load(store, codeOf(request));
    requireStatus(session, ["waiting_for_agent"]);
    const body = read(
      z.object({
        name: z.string().min(1),
        adapter: z.enum(["hermes", "generic", "openclaw"]),
        hermesWsUrl: z.string().optional(),
        hermesToken: z.string().optional(),
      }),
      request.body,
    );
    if (!ADAPTERS.has(body.adapter)) throw new HttpError(400, "unknown adapter");
    if (body.adapter === "hermes" && !body.hermesWsUrl?.startsWith("ws")) {
      throw new HttpError(400, "hermes adapter requires hermesWsUrl starting with ws:// or wss://");
    }
    const next = store.updateConnectSession(session.code, {
      status: "pending_agent_authorization",
      agentName: body.name.trim(),
      adapter: body.adapter,
      adapterConfig: {
        hermesWsUrl: body.hermesWsUrl ?? "",
        hermesToken: body.hermesToken ?? "",
      },
      lastError: null,
    });
    log(`connect claimed ${session.code}`, { name: body.name, adapter: body.adapter });
    return protocol(config, next, "agent");
  });

  app.post("/v1/connect/:code/number", async (request) => {
    const session = load(store, codeOf(request));
    requireStatus(session, ["awaiting_number_request"]);
    const body = read(z.object({ e164: z.string(), areaCode: z.string().optional() }), request.body);
    const e164 = normalizeE164(body.e164);
    if (twilioConfigured(config) && !isUsE164(e164)) throw new HttpError(400, "Twilio MVP buys US numbers only");
    const next = store.updateConnectSession(session.code, {
      status: "pending_number_authorization",
      requestedE164: e164,
      lastError: null,
    });
    log(`connect number requested ${session.code}`, { e164 });
    return protocol(config, next, "agent");
  });

  app.post("/v1/connect/:code/policy", async (request) => {
    const session = load(store, codeOf(request));
    requireStatus(session, ["awaiting_policy_request"]);
    const body = read(policyShape, request.body);
    const policy: Policy = {
      objective: body.objective,
      allowedActions: body.allowedActions,
      forbiddenActions: body.forbiddenActions,
      approvalRules: body.approvalRules as ApprovalRule[],
    };
    const next = store.updateConnectSession(session.code, {
      status: "pending_policy_authorization",
      policyJson: JSON.stringify(policy),
      lastError: null,
    });
    log(`connect policy requested ${session.code}`);
    return protocol(config, next, "agent");
  });

  app.post("/v1/connect/:code/complete", async (request) => {
    const session = load(store, codeOf(request));
    requireStatus(session, ["credentials_ready", "completed"]);
    const next = store.updateConnectSession(session.code, { status: "completed", lastError: null });
    log(`connect completed ${session.code}`, { agentId: next.agentId });
    return protocol(config, next, "agent");
  });

  app.post("/v1/connect/:code/authorize-agent", async (request, reply) => {
    const session = load(store, codeOf(request));
    requireStatus(session, ["pending_agent_authorization"]);
    const decision = decisionOf(request);
    if (decision === "denied") return finish(config, store, reply, request, session.code, { status: "denied", lastError: "用户拒绝了这个 Agent 接入电话" });
    if (!session.agentName || !session.adapter) throw new HttpError(409, "agent claim is incomplete");
    const created = store.createAgent({
      name: session.agentName,
      adapter: session.adapter,
      adapterConfig: session.adapterConfig,
    });
    store.updateAgent(created.agent.id, {
      adapterConfig: { ...session.adapterConfig, gatewayToken: created.token },
    });
    return finish(config, store, reply, request, session.code, {
      status: "awaiting_number_request",
      agentId: created.agent.id,
      gatewayToken: created.token,
      lastError: null,
    });
  });

  app.post("/v1/connect/:code/authorize-number", async (request, reply) => {
    const session = load(store, codeOf(request));
    requireStatus(session, ["pending_number_authorization"]);
    const decision = decisionOf(request);
    if (decision === "denied") {
      return finish(config, store, reply, request, session.code, {
        status: "awaiting_number_request",
        requestedE164: null,
        lastError: "用户拒绝了这个号码，请另选一个",
      });
    }
    if (!session.agentId || !session.requestedE164) throw new HttpError(409, "number request is incomplete");
    try {
      await bindNumber(config, store, session.agentId, session.requestedE164);
    } catch (error) {
      const message = error instanceof Error ? error.message : "bind failed";
      store.updateConnectSession(session.code, {
        status: "awaiting_number_request",
        requestedE164: null,
        lastError: message,
      });
      if (isRedirect(request)) return reply.redirect(`/connect/${session.code}`, 303);
      throw new HttpError(502, message);
    }
    return finish(config, store, reply, request, session.code, {
      status: "awaiting_policy_request",
      lastError: null,
    });
  });

  app.post("/v1/connect/:code/authorize-policy", async (request, reply) => {
    const session = load(store, codeOf(request));
    requireStatus(session, ["pending_policy_authorization"]);
    const decision = decisionOf(request);
    if (decision === "denied") {
      return finish(config, store, reply, request, session.code, {
        status: "awaiting_policy_request",
        policyJson: null,
        lastError: "用户拒绝了这套通话权限，请按用户的要求改一版再提交",
      });
    }
    if (!session.agentId || !session.policyJson) throw new HttpError(409, "policy request is incomplete");
    const policy = JSON.parse(session.policyJson) as Policy & { name?: string };
    store.createPolicy({
      agentId: session.agentId,
      name: "连接时确认的权限",
      objective: policy.objective,
      allowedActions: policy.allowedActions,
      forbiddenActions: policy.forbiddenActions,
      approvalRules: policy.approvalRules,
      isDefault: true,
    });
    const bridge = await ensureHermesBridge(store, config, session.agentId);
    const bridgeStatus = session.adapter === "hermes" ? bridge.status : "agent_connects_gateway";
    return finish(config, store, reply, request, session.code, {
      status: "credentials_ready",
      bridgeStatus,
      bridgeError: bridge.error ?? null,
      lastError: null,
    });
  });
}

async function bindNumber(config: AppConfig, store: Store, agentId: string, e164: string) {
  if (store.numberForAgent(agentId)) return;
  if (!twilioConfigured(config)) {
    store.createNumber({ agentId, e164, localOnly: true });
    return;
  }
  const sid = await buyUsNumber(config, e164);
  try {
    store.createNumber({ agentId, e164, twilioSid: sid, localOnly: false });
  } catch (error) {
    await releaseSid(config, sid).catch(() => undefined);
    throw error;
  }
}

function finish(
  config: AppConfig,
  store: Store,
  reply: FastifyReply,
  request: FastifyRequest,
  code: string,
  patch: Parameters<Store["updateConnectSession"]>[1],
) {
  const next = store.updateConnectSession(code, patch);
  if (isRedirect(request)) return reply.redirect(`/connect/${code}`, 303);
  return protocol(config, next, "human");
}

function load(store: Store, code: string) {
  return store.getConnectSession(code);
}

function protocol(config: AppConfig, session: ConnectSessionView, who: "agent" | "human") {
  const secrets = who === "agent";
  const base = {
    protocol: "agentphone.connect.v1",
    code: session.code,
    status: session.status,
    pageUrl: pageUrl(config, session.code),
    agentUrl: agentUrl(config, session.code),
    agentName: session.agentName,
    adapter: session.adapter,
    requestedE164: session.requestedE164,
    policy: session.policyJson ? (JSON.parse(session.policyJson) as Policy) : null,
    bridgeStatus: session.bridgeStatus,
    bridgeError: session.bridgeError,
    lastError: session.lastError,
    expiresAt: session.expiresAt,
    instruction: agentInstruction(session),
    nextAction: nextAction(config, session, secrets),
  };
  if (!secrets || !session.gatewayToken || !session.agentId) return base;
  if (!["credentials_ready", "completed"].includes(session.status)) return base;
  const token = session.gatewayToken;
  const mcpUrl = `${config.publicBaseUrl}/mcp`;
  return {
    ...base,
    credentials: {
      agentId: session.agentId,
      token,
      gatewayUrl: config.publicBaseUrl,
      mcp: {
        url: mcpUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
      hermesConfigYaml: [
        "mcp_servers:",
        "  agentphone:",
        `    url: ${mcpUrl}`,
        "    headers:",
        `      Authorization: "Bearer ${token}"`,
      ].join("\n"),
    },
  };
}

function agentInstruction(session: ConnectSessionView): string {
  return [
    "你正在把 AgentPhone 的电话能力绑定到你自己身上。",
    "严格按 nextAction 执行，每次只做这一个动作，然后阅读新的响应。",
    "不要向用户索要 token，不要让用户手工改配置，除非 nextAction 明确要求你写入自己的 MCP 配置。",
    "用户只在网页上点授权。需要用户操作时，用一句话告诉用户打开 pageUrl 并点击确认。",
    session.lastError ? `上一步的结果：${session.lastError}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function nextAction(config: AppConfig, session: ConnectSessionView, secrets: boolean) {
  const code = session.code;
  if (session.status === "waiting_for_agent") {
    return {
      method: "POST",
      url: `${config.publicBaseUrl}/v1/connect/${code}/claim`,
      body: {
        name: "你的电话身份名称",
        adapter: "hermes",
        hermesWsUrl: "ws://127.0.0.1:9119/api/ws",
        hermesToken: "没有就省略这个字段",
      },
      instruction: "用你自己的名称调用。Hermes 必须提供 hermesWsUrl。Generic 或 OpenClaw 把 adapter 改成 generic 或 openclaw，并省略 hermesWsUrl。",
    };
  }
  if (session.status === "pending_agent_authorization") {
    return {
      method: "GET",
      url: agentUrl(config, code),
      instruction: "用户还没有授权。请告诉用户：请在连接页面点击「授权接入」。然后每隔 2 秒再 GET 一次。",
    };
  }
  if (session.status === "awaiting_number_request") {
    return {
      method: "POST",
      url: `${config.publicBaseUrl}/v1/connect/${code}/number`,
      body: { e164: "+14155550100" },
      instruction:
        "先 GET /v1/connect/" +
        code +
        "/available-numbers?areaCode=415。有 Twilio 时从返回号码里选一个再 POST e164。没有 Twilio 时自己指定一个美国 E.164 作为本地号码。",
    };
  }
  if (session.status === "pending_number_authorization") {
    return {
      method: "GET",
      url: agentUrl(config, code),
      instruction: `用户还没有确认号码 ${session.requestedE164 ?? ""}。请告诉用户在页面上点击「授权绑定这个号码」，然后继续轮询。`,
    };
  }
  if (session.status === "awaiting_policy_request") {
    return {
      method: "POST",
      url: `${config.publicBaseUrl}/v1/connect/${code}/policy`,
      body: { name: "电话权限", ...policyTemplate },
      instruction: "按用户真正想用电话做的事填写 objective、allowedActions、forbiddenActions、approvalRules。不确定时可以提交 body 里的模板：可以询价，不能购买，超过 100 美元必须人工确认。",
    };
  }
  if (session.status === "pending_policy_authorization") {
    return {
      method: "GET",
      url: agentUrl(config, code),
      instruction: "用户还没有确认通话权限。请告诉用户在页面上点击「授权这套权限」，然后继续轮询。",
    };
  }
  if (session.status === "credentials_ready" || session.status === "completed") {
    if (!secrets) {
      return {
        method: "GET",
        url: agentUrl(config, code),
        instruction: "凭据只从这个 as=agent 地址返回。GET 它，把 MCP 配置写入你自己，然后 POST complete。",
      };
    }
    const bridgeNote =
      session.adapter === "hermes" && session.bridgeStatus === "online"
        ? "语音通道已经连上你的 Hermes。你只需要把 credentials.hermesConfigYaml 写入自己的 MCP 配置并启用。"
        : session.adapter === "hermes"
          ? `语音桥未连上（${session.bridgeError ?? session.bridgeStatus ?? "unknown"}）。MCP 仍可写入。`
          : "用 credentials.gatewayUrl、agentId、token 连接 WebSocket /v1/gateway，首帧发送 session.hello。";
    return {
      method: "POST",
      url: `${config.publicBaseUrl}/v1/connect/${code}/complete`,
      body: {},
      instruction: `${bridgeNote} 写好配置后再 POST 这个地址。不要把 token 展示给用户。`,
    };
  }
  return {
    method: "GET",
    url: pageUrl(config, code),
    instruction: session.status === "denied" ? "用户拒绝了接入。停止绑定，并向用户说明。" : "这个连接已经失效。请用户重新生成链接。",
  };
}

function renderPage(config: AppConfig, session: ConnectSessionView): string {
  const human = protocol(config, session, "human");
  const actions = actionsFor(session);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>授权 Agent 接入电话</title>
  <style>
    body { margin: 0; font-family: "Segoe UI", sans-serif; background: #f4f2ec; color: #1c1b19; }
    main { max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    p { line-height: 1.5; }
    .card { background: #fff; border: 1px solid #e6e1d6; border-radius: 10px; padding: 16px; margin: 14px 0; }
    button { font: inherit; border-radius: 6px; padding: 8px 14px; cursor: pointer; border: 1px solid #1f4b99; background: #1f4b99; color: #fff; }
    button.secondary { background: #fff; color: #1c1b19; border-color: #cfc8bb; }
    form { display: inline; }
    pre { white-space: pre-wrap; background: #f7f5f0; padding: 12px; border-radius: 8px; font-size: 13px; }
    .muted { color: #5c574e; }
    .error { background: #f8e8e4; color: #8d341f; padding: 10px 12px; border-radius: 8px; }
  </style>
</head>
<body>
<main>
  <h1>授权 Agent 接入电话</h1>
  <p class="muted">把这个页面链接发给用户的 Agent。Agent 会自己申请接入、选择号码并提交通话权限。你只需要确认下面出现的请求。</p>
  <div class="card">
    <strong id="headline">${escapeHtml(headline(session))}</strong>
    <p id="detail">${escapeHtml(detail(session))}</p>
    ${session.lastError ? `<p class="error">${escapeHtml(session.lastError)}</p>` : ""}
    <div id="actions">${actions}</div>
  </div>
  <div class="card">
    <div class="muted">给 Agent 的协议。Agent 读取后按 nextAction 执行。</div>
    <pre id="agentphone-connect">${escapeHtml(JSON.stringify(human, null, 2))}</pre>
  </div>
</main>
<script>
setInterval(async () => {
  const response = await fetch(${JSON.stringify(`/v1/connect/${session.code}?as=human`)});
  if (!response.ok) return;
  const body = await response.json();
  if (body.status !== ${JSON.stringify(session.status)}) location.reload();
}, 2000);
</script>
</body>
</html>`;
}

function actionsFor(session: ConnectSessionView): string {
  if (session.status === "pending_agent_authorization") {
    return pair(
      session.code,
      "authorize-agent",
      "授权接入",
      "拒绝",
      `${escapeHtml(session.agentName ?? "这个 Agent")}（${escapeHtml(session.adapter ?? "")}）请求接入电话。授权后，它可以在绑定的号码上接听和拨打，并继续使用它自己的工具。`,
    );
  }
  if (session.status === "pending_number_authorization") {
    return pair(
      session.code,
      "authorize-number",
      "授权绑定这个号码",
      "换一个号码",
      `Agent 申请绑定 ${escapeHtml(session.requestedE164 ?? "")}。确认后，打给这个号码的电话会进入该 Agent。`,
    );
  }
  if (session.status === "pending_policy_authorization") {
    const policy = session.policyJson ? (JSON.parse(session.policyJson) as Policy) : null;
    const summary = policy
      ? `目标：${escapeHtml(policy.objective)}\n允许：${escapeHtml(policy.allowedActions.join(", ") || "未限制")}\n禁止：${escapeHtml(policy.forbiddenActions.join(", ") || "无")}`
      : "";
    return pair(session.code, "authorize-policy", "授权这套权限", "退回修改", summary);
  }
  return "";
}

function pair(code: string, action: string, approve: string, deny: string, text: string): string {
  return `<p>${text.replaceAll("\n", "<br>")}</p>
<form method="post" action="/v1/connect/${code}/${action}"><input type="hidden" name="decision" value="approved"><input type="hidden" name="redirect" value="1"><button type="submit">${approve}</button></form>
<form method="post" action="/v1/connect/${code}/${action}"><input type="hidden" name="decision" value="denied"><input type="hidden" name="redirect" value="1"><button class="secondary" type="submit">${deny}</button></form>`;
}

function headline(session: ConnectSessionView): string {
  switch (session.status) {
    case "waiting_for_agent":
      return "等待 Agent 打开这个链接";
    case "pending_agent_authorization":
      return "Agent 正在请求接入";
    case "awaiting_number_request":
      return "已授权 Agent，等待它选择号码";
    case "pending_number_authorization":
      return "请确认要绑定的号码";
    case "awaiting_policy_request":
      return "号码已绑定，等待 Agent 提交通话权限";
    case "pending_policy_authorization":
      return "请确认通话权限";
    case "credentials_ready":
    case "completed":
      return "绑定完成";
    case "denied":
      return "已拒绝接入";
    default:
      return "链接已失效";
  }
}

function detail(session: ConnectSessionView): string {
  switch (session.status) {
    case "waiting_for_agent":
      return "Agent 读取本页后会自己提交接入申请。在那之前，这里不会出现需要你填写的配置。";
    case "pending_agent_authorization":
    case "pending_number_authorization":
    case "pending_policy_authorization":
      return "请确认下面这项请求。拒绝号码或权限时，Agent 会换一个方案再问你。";
    case "awaiting_number_request":
      return "Agent 正在选择号码。选好后，这里会出现确认按钮。";
    case "awaiting_policy_request":
      return "Agent 正在提交这次电话允许做什么。提交后，这里会出现确认按钮。";
    case "credentials_ready":
    case "completed": {
      const bridge =
        session.bridgeStatus === "online"
          ? "语音通道已连上 Hermes。"
          : session.bridgeStatus === "agent_connects_gateway"
            ? "这个 Agent 会自己连上电话通道。"
            : session.bridgeStatus === "failed"
              ? `语音通道没有连上：${session.bridgeError ?? ""}`
              : "";
      return `号码 ${session.requestedE164 ?? ""} 已交给 ${session.agentName ?? "Agent"}。${bridge} 之后通话中的敏感动作仍会单独请你确认。`;
    }
    case "denied":
      return "这个 Agent 没有获得电话权限。";
    default:
      return "请重新生成一条连接链接。";
  }
}

function pageUrl(config: AppConfig, code: string): string {
  return `${config.publicBaseUrl}/connect/${code}`;
}

function agentUrl(config: AppConfig, code: string): string {
  return `${config.publicBaseUrl}/v1/connect/${code}?as=agent`;
}

function codeOf(request: FastifyRequest): string {
  return (request.params as { code: string }).code;
}

function audience(request: FastifyRequest): "agent" | "human" {
  return (request.query as { as?: string }).as === "agent" ? "agent" : "human";
}

function decisionOf(request: FastifyRequest): "approved" | "denied" {
  const body = request.body as { decision?: string } | undefined;
  if (body?.decision === "approved" || body?.decision === "denied") return body.decision;
  throw new HttpError(400, "decision must be approved or denied");
}

function isRedirect(request: FastifyRequest): boolean {
  const body = request.body as { redirect?: string } | undefined;
  return body?.redirect === "1";
}

function requireStatus(session: ConnectSessionView, allowed: string[]) {
  if (!allowed.includes(session.status)) {
    throw new HttpError(409, `connect status is ${session.status}, expected ${allowed.join(" or ")}`);
  }
}

function read<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
  return parsed.data;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
