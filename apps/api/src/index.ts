import { pathToFileURL } from "node:url";
import { buildApp } from "./app.js";
import { closeHermesBridges, resumeHermesBridges } from "./bridges.js";
import { loadConfig, loadEnvFiles, type AppConfig } from "./config.js";
import { log } from "./log.js";
import { createRuntime } from "./runtime.js";
import { createStore } from "./store.js";
import { twilioConfigured } from "./twilio.js";

export async function start(overrides: Partial<AppConfig> = {}) {
  loadEnvFiles();
  const config = loadConfig(overrides);
  const store = createStore(config.databasePath);
  store.resetPresence();
  const runtime = createRuntime(store, config);
  const app = await buildApp({ config, store, runtime });
  await app.listen({ port: config.port, host: config.host });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a port");
  const url = `http://${config.host}:${address.port}`;
  const timer = setInterval(() => {
    void runtime.tickCallbacks();
  }, 15_000);
  timer.unref?.();
  void resumeHermesBridges(store, config);
  log(`listening ${url}`, {
    twilio: twilioConfigured(config),
    devSimulate: config.devSimulate,
    publicBaseUrl: config.publicBaseUrl,
  });
  return {
    app,
    store,
    runtime,
    config,
    url,
    close: async () => {
      clearInterval(timer);
      closeHermesBridges();
      await app.close();
      store.close();
    },
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  start().catch((error: unknown) => {
    log("fatal", { error: error instanceof Error ? error.message : "unknown" });
    process.exit(1);
  });
}
