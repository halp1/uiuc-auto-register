import index from "../web/index.html";
import { apiRoutes, configureOriginCheck } from "./api/routes";
import { createApp, swPath, type App } from "./app";
import { loadConfig } from "./core/config";

const config = loadConfig();

// `bun --hot` re-runs this file in the same process (globalThis survives). Two apps would mean two
// Banner sessions able to submit at once, so live mode refuses hot reload, and any earlier app is
// fully stopped before a new one starts.
const isHot = process.execArgv.includes("--hot");
if (isHot && config.mode === "live") {
  console.error("Live mode cannot run with hot reload. Use `bun start` instead of `bun dev`.");
  process.exit(1);
}
const g = globalThis as typeof globalThis & { __autoRegister?: { app: App; server: ReturnType<typeof Bun.serve> } };
if (g.__autoRegister) {
  const old = g.__autoRegister;
  g.__autoRegister = undefined;
  await old.server.stop(true).catch(() => {});
  await old.app.stop().catch(() => {});
}

const app = await createApp(config);

const sw = await Bun.build({ entrypoints: [swPath], target: "browser", minify: true });
if (!sw.success) throw new AggregateError(sw.logs, "Could not build the service worker");
const swCode = await sw.outputs[0]!.text();

const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.host);
configureOriginCheck({ loopbackOnly: loopback });
const { routes } = apiRoutes(app.services);

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: 0, // SSE streams stay open
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
  routes: {
    ...routes,
    "/sw.js": () =>
      new Response(swCode, {
        headers: { "content-type": "text/javascript; charset=utf-8", "service-worker-allowed": "/", "cache-control": "no-cache" },
      }),
    "/api/*": () => Response.json({ error: "Not found." }, { status: 404 }),
    "/*": index,
  },
});

g.__autoRegister = { app, server };
await app.start();

const modeLine = {
  simulated: "Simulated (nothing real happens)",
  rehearsal: "Test (real login, read only)",
  live: "Live (real registration when turned on in Settings)",
}[config.mode];
console.log(`UIUC Auto Register running at http://${loopback ? config.host : "localhost"}:${server.port}`);
console.log(`Mode: ${modeLine}`);
if (config.mode !== "simulated" && !config.hasCredentials) console.warn("Add UIUC_NETID, UIUC_PASSWORD, and UIUC_TOTP_SECRET to .env to log in.");

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
