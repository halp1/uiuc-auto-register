import index from "../web/index.html";
import { apiRoutes, configureOriginCheck } from "./api/routes";
import { createApp, swPath, type App } from "./app";
import { makeConfig, parseArgs } from "./core/config";
import { Store } from "./core/db";

// Flags only (no environment variables): bun src/index.ts [--port 3000] [--host 127.0.0.1] [--data ./data]
const cli = parseArgs(process.argv.slice(2));
const hotReload = process.execArgv.includes("--hot");

// `bun --hot` re-runs this file in the same process (globalThis survives). Two apps would mean two
// Banner sessions able to submit at once, so any earlier app is fully stopped before a new one starts,
// and Live registration stays off under hot reload (see liveGate).
type Running = { app: App; server: ReturnType<typeof Bun.serve> };
const g = globalThis as typeof globalThis & { __autoRegister?: Running };
if (g.__autoRegister) {
  const old = g.__autoRegister;
  g.__autoRegister = undefined;
  await old.server.stop(true).catch(() => {});
  await old.app.stop().catch(() => {});
}

const sw = await Bun.build({ entrypoints: [swPath], target: "browser", minify: true });
if (!sw.success) throw new AggregateError(sw.logs, "Could not build the service worker");
const swCode = await sw.outputs[0]!.text();

const loopback = ["127.0.0.1", "localhost", "::1"].includes(cli.host);
configureOriginCheck({ loopbackOnly: loopback });

const modeLine = {
  simulated: "Simulated (nothing real happens)",
  rehearsal: "Test (real login, read only)",
  live: "Live (real registration when turned on in Settings)",
} as const;

let restarting = false;
let restartQueued = false;

/** Open the store and build the app in the saved mode. */
async function boot(): Promise<{ app: App; routes: Record<string, unknown> }> {
  const store = Store.open(cli.dataDir);
  const config = makeConfig(store.getSettings().mode, { ...cli, hotReload });
  const app = await createApp(config, { store, restart: requestRestart, restarting: () => restarting });
  const { routes } = apiRoutes(app.services);
  return { app, routes };
}

function serverRoutes(api: Record<string, unknown>) {
  return {
    ...api,
    "/sw.js": () =>
      new Response(swCode, {
        headers: { "content-type": "text/javascript; charset=utf-8", "service-worker-allowed": "/", "cache-control": "no-cache" },
      }),
    "/api/*": () => Response.json({ error: "Not found." }, { status: 404 }),
    "/*": index,
    ...(api["/api/*"] ? { "/api/*": api["/api/*"] } : {}),
  } as any;
}

const restartingRoutes = serverRoutes({
  "/healthz": () => new Response("ok"),
  "/api/*": () => Response.json({ error: "Restarting. Try again in a few seconds." }, { status: 503, headers: { "retry-after": "2" } }),
});

const first = await boot();
const server = Bun.serve({
  hostname: cli.host,
  port: cli.port,
  idleTimeout: 0, // SSE streams stay open
  development: hotReload && { hmr: true, console: true },
  routes: serverRoutes(first.routes),
});
g.__autoRegister = { app: first.app, server };
await first.app.start();

console.log(`UIUC Auto Register running at http://${loopback ? cli.host : "localhost"}:${server.port}`);
console.log(`Mode: ${modeLine[first.app.services.config.mode]}`);

/** Stop the app (Banner session, poller, orchestrator) and boot it again in the saved mode. One at a time. */
function requestRestart() {
  if (restarting) {
    restartQueued = true;
    return;
  }
  restarting = true;
  void (async () => {
    do {
      restartQueued = false;
      const current = g.__autoRegister;
      current?.app.services.bus.publish({ type: "status", status: current.app.services.status() });
      server.reload({ routes: restartingRoutes });
      // Stopping closes every open event stream, so browsers reconnect and get the new app's state.
      if (current) await current.app.stop().catch(error => console.error("stop failed", error));
      try {
        const next = await boot();
        g.__autoRegister = { app: next.app, server };
        await next.app.start();
        server.reload({ routes: serverRoutes(next.routes) });
        console.log(`Restarted. Mode: ${modeLine[next.app.services.config.mode]}`);
      } catch (error) {
        console.error("Restart failed", error);
        process.exit(1);
      }
    } while (restartQueued);
    restarting = false;
    g.__autoRegister?.app.services.bus.publish({ type: "status", status: g.__autoRegister.app.services.status() });
  })();
}

const flags = globalThis as typeof globalThis & { __autoRegisterSignals?: boolean };
if (!flags.__autoRegisterSignals) {
  flags.__autoRegisterSignals = true;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const current = g.__autoRegister;
    if (current) {
      await current.server.stop(true).catch(() => {});
      await current.app.stop().catch(() => {});
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
