import { startHermesBridge } from "@agentphone/adapter-hermes/bridge";
import type { AppConfig } from "./config.js";
import { log } from "./log.js";
import { startOpenClawBridge } from "./openclaw-bridge.js";
import type { Store } from "./store.js";

const running = new Map<string, { close: () => void }>();

export async function ensureHermesBridge(
  store: Store,
  config: AppConfig,
  agentId: string,
): Promise<{ status: "online" | "failed" | "skipped"; error?: string }> {
  const bridge = store.listVoiceBridges().find((item) => item.agentId === agentId && item.kind === "hermes");
  if (!bridge) return { status: "skipped" };
  if (running.has(agentId)) return { status: "online" };
  try {
    const handle = await startHermesBridge({
      agentphoneUrl: config.publicBaseUrl,
      agentId: bridge.agentId,
      token: bridge.gatewayToken,
      hermesWsUrl: bridge.hermesWsUrl,
      hermesToken: bridge.hermesToken,
    });
    running.set(agentId, handle);
    log(`hermes bridge online ${agentId}`);
    return { status: "online" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "bridge failed";
    log(`hermes bridge failed ${agentId}`, { error: message });
    return { status: "failed", error: message };
  }
}

export async function ensureOpenClawBridge(
  store: Store,
  config: AppConfig,
  agentId: string,
): Promise<{ status: "online" | "failed" | "skipped"; error?: string }> {
  const bridge = store.listVoiceBridges().find((item) => item.agentId === agentId && item.kind === "openclaw");
  if (!bridge) return { status: "skipped" };
  if (running.has(agentId)) return { status: "online" };
  try {
    const handle = await startOpenClawBridge({
      agentphoneUrl: config.publicBaseUrl,
      agentId: bridge.agentId,
      token: bridge.gatewayToken,
    });
    running.set(agentId, handle);
    return { status: "online" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "bridge failed";
    log(`openclaw bridge failed ${agentId}`, { error: message });
    return { status: "failed", error: message };
  }
}

export async function startAgentBridge(store: Store, config: AppConfig, agentId: string) {
  const agent = store.getAgent(agentId);
  if (agent.adapter === "openclaw") return ensureOpenClawBridge(store, config, agentId);
  if (agent.adapter === "hermes") return ensureHermesBridge(store, config, agentId);
  return { status: "agent_connects_gateway" as const };
}

export async function resumeVoiceBridges(store: Store, config: AppConfig): Promise<void> {
  for (const bridge of store.listVoiceBridges()) {
    if (bridge.kind === "hermes") await ensureHermesBridge(store, config, bridge.agentId);
    if (bridge.kind === "openclaw") await ensureOpenClawBridge(store, config, bridge.agentId);
  }
}

export function closeHermesBridges(): void {
  for (const bridge of running.values()) bridge.close();
  running.clear();
}
