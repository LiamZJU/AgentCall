import { startHermesBridge } from "@agentphone/adapter-hermes/bridge";
import type { AppConfig } from "./config.js";
import { log } from "./log.js";
import type { Store } from "./store.js";

const running = new Map<string, { close: () => void }>();

export async function ensureHermesBridge(
  store: Store,
  config: AppConfig,
  agentId: string,
): Promise<{ status: "online" | "failed" | "skipped"; error?: string }> {
  const bridge = store.listHermesBridges().find((item) => item.agentId === agentId);
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

export async function resumeHermesBridges(store: Store, config: AppConfig): Promise<void> {
  await Promise.all(store.listHermesBridges().map((bridge) => ensureHermesBridge(store, config, bridge.agentId)));
}

export function closeHermesBridges(): void {
  for (const bridge of running.values()) bridge.close();
  running.clear();
}
