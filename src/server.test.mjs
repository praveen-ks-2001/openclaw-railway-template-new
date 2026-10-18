import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";

const repository = fileURLToPath(new URL("../", import.meta.url));
const password = "wrapper-fixture-password";
const gatewayToken = "wrapper-fixture-gateway-token";
const apiSecret = "api-secret-fixture";
const basic = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The real-process fixtures launch several CLIs per request. Keep their outer
// IO budget independent of native-host speed and slower emulated Linux runs;
// cancellation and process-deadline tests still use their explicit limits.
const FIXTURE_IO_TIMEOUT_MS = 30_000;

async function waitUntil(predicate, description, timeoutMs = FIXTURE_IO_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function fixture(
  t,
  {
    configured = false,
    onboardDelayMs = 0,
    doctorDelayMs = 0,
    doctorFailures = 0,
    enforceMigratedPluginConfig = false,
    onboardFailures = 0,
    emptyProfiles = false,
    ignoreOnboardTerm = false,
    gatewayReadyDelayMs = 0,
    canaryReadyDelayMs = gatewayReadyDelayMs,
    pairingApprovalDelayMs = 0,
    tuiIdleTimeoutMs = 300_000,
    tuiMaxSessionMs = 1_800_000,
    prepareState = async () => {},
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wrapper-integration-"));
  let child;
  let output = "";
  const stopWrapper = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await exited;
      } finally {
        clearTimeout(killTimer);
      }
    }
  };
  t.after(async () => {
    await stopWrapper();
    await fs.rm(root, { recursive: true, force: true });
  });
  const state = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  const entry = path.join(root, "openclaw", "dist", "entry.mjs");
  const sdk = path.join(
    root,
    "openclaw",
    "dist",
    "plugin-sdk",
    "device-bootstrap.js",
  );
  const config = path.join(state, "openclaw.json");
  const eventsFile = path.join(root, "events.ndjson");
  const failuresFile = path.join(root, "onboard-failures");
  const doctorFailuresFile = path.join(root, "doctor-failures");
  await Promise.all([
    fs.mkdir(state, { recursive: true }),
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(path.dirname(sdk), { recursive: true }),
    fs.mkdir(path.join(root, "home"), { recursive: true }),
  ]);
  await fs.writeFile(
    path.join(root, "openclaw", "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.10.4",
      type: "module",
      exports: {
        "./plugin-sdk/device-bootstrap":
          "./dist/plugin-sdk/device-bootstrap.js",
      },
    }),
  );
  await fs.writeFile(failuresFile, String(onboardFailures));
  await fs.writeFile(doctorFailuresFile, String(doctorFailures));
  await fs.writeFile(
    path.join(state, "fixture-device-marker"),
    "fixture-request",
  );
  await fs.writeFile(
    sdk,
    `
    import fs from "node:fs";
    import path from "node:path";
    // Model a state owner captured when its SDK module is first loaded. A
    // long-lived importing process would retain this value across a path swap.
    const stateOwner = fs.readFileSync(path.join(process.env.OPENCLAW_STATE_DIR, "fixture-device-marker"), "utf8");
    fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({ type: "device-sdk-import", pid: process.pid, time: Date.now() }) + "\\n");
    export async function listDevicePairing() { return { pending: [{ requestId: stateOwner, ts: Date.now() }], paired: [], fixtureReaderPid: process.pid }; }
    export async function approveDevicePairing(requestId, options) {
      fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({ type: "pairing-start", pid: process.pid, time: Date.now() }) + "\\n");
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.FIXTURE_PAIRING_DELAY)));
      return options.callerScopes.includes("operator.admin") ? { status: "approved", device: { deviceId: requestId } } : { status: "forbidden" };
    }
  `,
  );
  await fs.writeFile(
    path.join(path.dirname(sdk), "provider-auth.js"),
    `
    import fs from "node:fs";
    import path from "node:path";
    export function ensureAuthProfileStore() {
      try { return JSON.parse(fs.readFileSync(path.join(process.env.OPENCLAW_STATE_DIR, "fixture-auth.json"), "utf8")); }
      catch { return { profiles: {} }; }
    }
    export function listProfilesForProvider(store, provider) {
      return Object.keys(store.profiles || {}).filter((id) => store.profiles[id].provider === provider);
    }
    export function isProviderApiKeyConfigured({ provider }) {
      const store = ensureAuthProfileStore();
      return listProfilesForProvider(store, provider).some((id) => Boolean(store.profiles[id].key));
    }
  `,
  );
  const wsImport = pathToFileURL(
    path.join(repository, "node_modules", "ws", "wrapper.mjs"),
  ).href;
  await fs.writeFile(
    entry,
    `
    import fs from "node:fs";
    import path from "node:path";
    import http from "node:http";
    import { WebSocketServer } from ${JSON.stringify(wsImport)};
    const args = process.argv.slice(2);
    const state = process.env.OPENCLAW_STATE_DIR;
    const config = path.join(state, "openclaw.json");
    const event = (type, details = {}) => fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({ type, pid: process.pid, time: Date.now(), ...details }) + "\\n");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const read = () => fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, "utf8")) : { gateway: { mode: "local" } };
    const admitPluginConfig = () => {
      if (process.env.FIXTURE_CURRENT_PLUGIN_CONFIG === "true" && read().agents?.list) {
        event("plugin-legacy-config-refused");
        console.error("Legacy agents.list requires Doctor before plugin commands");
        process.exit(1);
      }
    };
    event("cli-start", { command: args[0] || "", subcommand: args[1] || "" });
    if (args[0] === "--version") console.log("OpenClaw 2026.10.4");
    else if (args[0] === "plugins" && args[1] === "install") {
      admitPluginConfig();
      const spec = args[2]; const divider = spec.lastIndexOf("@");
      const name = spec.slice(0, divider), version = spec.slice(divider + 1);
      const id = name.split("/").at(-1).replace(/-provider$/, "");
      const directory = path.join(state, "extensions", id); fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "openclaw.plugin.json"), JSON.stringify({ id }));
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version }));
      if (!fs.existsSync(config)) fs.writeFileSync(config, JSON.stringify({ gateway: { mode: "local" } }));
      event("plugin-installed");
    } else if (args[0] === "plugins" && args[1] === "inspect") {
      admitPluginConfig();
      const directory = path.join(state, "extensions", args[2]);
      if (fs.existsSync(path.join(directory, "package.json"))) {
        console.log(JSON.stringify({ plugin: { id: args[2], rootDir: directory, enabled: true, origin: "global" }, install: { source: "npm", installPath: directory } }));
      } else { process.exitCode = 1; }
    } else if (args[0] === "doctor") {
      event("doctor-start");
      await sleep(Number(process.env.FIXTURE_DOCTOR_DELAY));
      const failures = Number(fs.readFileSync(process.env.FIXTURE_DOCTOR_FAILURES_FILE, "utf8"));
      if (failures > 0) {
        fs.writeFileSync(process.env.FIXTURE_DOCTOR_FAILURES_FILE, String(failures - 1));
        const cfg = read(); cfg.partialMigration = "must-be-rolled-back";
        fs.writeFileSync(config, JSON.stringify(cfg));
        fs.writeFileSync(path.join(state, "persistent-fixture.txt"), "partially migrated history");
        fs.writeFileSync(path.join(process.env.OPENCLAW_WORKSPACE_DIR, "user-notes.md"), "partially migrated notes");
        fs.writeFileSync(path.join(state, "doctor-new-secret.fixture"), "synthetic-partial-migration-secret");
        event("doctor-failed"); process.exit(1);
      }
      const cfg = read();
      if (cfg.agents?.list) {
        cfg.agents.entries = Object.fromEntries(cfg.agents.list.map(({ id, ...entry }) => [id, entry]));
        delete cfg.agents.list;
        if (cfg.agents.defaults) delete cfg.agents.defaults.memorySearch;
      }
      cfg.doctorCompleted = true; fs.writeFileSync(config, JSON.stringify(cfg));
      event("doctor-complete");
    } else if (args[0] === "onboard") {
      if (process.env.FIXTURE_IGNORE_ONBOARD_TERM === "true") process.on("SIGTERM", () => event("onboard-term-ignored"));
      event("onboard-start");
      if (args.includes("--classic")) {
        console.log("Visit https://fixture.invalid/device and enter ABCD-EFGH");
      }
      process.stdout.write("api-");
      await sleep(5);
      console.log("secret-fixture");
      await sleep(Number(process.env.FIXTURE_ONBOARD_DELAY));
      const failures = Number(fs.readFileSync(process.env.FIXTURE_FAILURES_FILE, "utf8"));
      if (failures > 0) {
        fs.writeFileSync(process.env.FIXTURE_FAILURES_FILE, String(failures - 1));
        event("onboard-failed"); process.exit(1);
      }
      fs.writeFileSync(config, JSON.stringify({ gateway: { mode: "local" }, agents: { defaults: { model: "openai/fixture-model" }, entries: { main: { default: true } } }, auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } } }));
      const deviceMarker = path.join(state, "fixture-device-marker");
      if (!fs.existsSync(deviceMarker)) fs.writeFileSync(deviceMarker, "fixture-request");
      if (process.env.FIXTURE_EMPTY_PROFILES !== "true") {
        const device = args.includes("--classic");
        fs.writeFileSync(path.join(state, "fixture-auth.json"), JSON.stringify({ profiles: { "openai:default": { provider: "openai", type: device ? "oauth" : "api_key", key: "fixture-synthetic-key", access: "fixture-synthetic-access", expires: Date.now() + 60_000 } } }));
      }
      event("onboard-complete");
    } else if (args[0] === "config" && args[1] === "set") {
      const positional = args.slice(2).filter((arg) => !["--json", "--strict-json"].includes(arg));
      const cfg = read(); const keys = positional[0].split("."); let target = cfg;
      for (const key of keys.slice(0, -1)) target = target[key] ||= {};
      let value = positional[1]; try { value = JSON.parse(value); } catch {}
      target[keys.at(-1)] = value; fs.writeFileSync(config, JSON.stringify(cfg));
    } else if (args[0] === "gateway" && args[1] === "run") {
      const canary = args.includes("--update-canary");
      event(canary ? "gateway-canary-start" : "gateway-start", {
        canary,
        skipChannels: process.env.OPENCLAW_SKIP_CHANNELS || null,
        skipCron: process.env.OPENCLAW_SKIP_CRON || null,
      });
      const readyAt = Date.now() + Number(canary ? process.env.FIXTURE_CANARY_READY_DELAY : process.env.FIXTURE_GATEWAY_READY_DELAY);
      const server = http.createServer(async (req, res) => {
        if (req.url === "/startupz") { res.statusCode = Date.now() >= readyAt ? 204 : 503; res.end(); return; }
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        res.setHeader("content-type", "application/json");
        if (req.url === "/tools/invoke") {
          res.statusCode = req.headers.authorization === "Bearer " + process.env.OPENCLAW_GATEWAY_TOKEN ? 404 : 401;
          res.end(JSON.stringify({ error: res.statusCode === 401 ? "Unauthorized" : "Tool not available" })); return;
        }
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
      });
      const wss = new WebSocketServer({ noServer: true });
      server.on("upgrade", (req, socket, head) => {
        if (req.url === "/protected-socket" && req.headers.authorization !== "Bearer " + process.env.OPENCLAW_GATEWAY_TOKEN) {
          socket.end("HTTP/1.1 401 Unauthorized\\r\\nContent-Length: 0\\r\\n\\r\\n"); return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      });
      wss.on("connection", (ws, req) => { ws.send(JSON.stringify({ headers: req.headers, url: req.url })); ws.on("message", (data) => ws.send(data.toString())); });
      const parentPid = process.ppid;
      setInterval(() => { if (process.ppid !== parentPid) process.exit(0); }, 100).unref();
      server.listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
    } else if (args[0] === "tui") {
      event("tui-start");
      console.log("TUI-FIXTURE-READY"); process.stdin.resume(); process.stdin.on("data", (data) => process.stdout.write(data));
    } else if (args[0] === "channels") console.log("channels add fixture help");
  `,
  );
  if (configured)
    await fs.writeFile(config, JSON.stringify({ gateway: { mode: "local" } }));
  await prepareState({ root, state, workspace, config });
  const reservations = await Promise.all([reservePort(), reservePort()]);
  const [wrapperPort, gatewayPort] = reservations.map(({ port }) => port);
  await Promise.all(reservations.map(({ close }) => close()));
  const wrapperEnv = {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: root,
      NO_PROXY: "127.0.0.1,localhost",
      LANG: "en_US.UTF-8",
      PORT: String(wrapperPort),
      INTERNAL_GATEWAY_PORT: String(gatewayPort),
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_WORKSPACE_DIR: workspace,
      OPENCLAW_ENTRY: entry,
      OPENCLAW_NODE: process.execPath,
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      SETUP_PASSWORD: password,
      RAILWAY_PUBLIC_DOMAIN: "wrapper-fixture.example",
      ENABLE_WEB_TUI: "true",
      TUI_IDLE_TIMEOUT_MS: String(tuiIdleTimeoutMs),
      TUI_MAX_SESSION_MS: String(tuiMaxSessionMs),
      FIXTURE_EVENTS: eventsFile,
      FIXTURE_ONBOARD_DELAY: String(onboardDelayMs),
      FIXTURE_DOCTOR_DELAY: String(doctorDelayMs),
      FIXTURE_DOCTOR_FAILURES_FILE: doctorFailuresFile,
      FIXTURE_CURRENT_PLUGIN_CONFIG: String(enforceMigratedPluginConfig),
      FIXTURE_FAILURES_FILE: failuresFile,
      FIXTURE_EMPTY_PROFILES: String(emptyProfiles),
      FIXTURE_IGNORE_ONBOARD_TERM: String(ignoreOnboardTerm),
      FIXTURE_GATEWAY_READY_DELAY: String(gatewayReadyDelayMs),
      FIXTURE_CANARY_READY_DELAY: String(canaryReadyDelayMs),
      FIXTURE_PAIRING_DELAY: String(pairingApprovalDelayMs),
  };
  const startWrapper = () => {
    child = spawn(process.execPath, [path.join(repository, "src", "server.js")], {
    cwd: repository,
    stdio: ["ignore", "pipe", "pipe"],
    env: wrapperEnv,
  });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output = (output + chunk).slice(-1_000_000);
      });
  };
  startWrapper();
  const base = `http://127.0.0.1:${wrapperPort}`;
  const request = (url, options = {}) =>
    fetch(`${base}${url}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(FIXTURE_IO_TIMEOUT_MS),
    });
  const authorized = (url, options = {}) =>
    request(url, {
      ...options,
      headers: { Authorization: basic, ...options.headers },
    });
  const events = async () => {
    try {
      return (await fs.readFile(eventsFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  const waitListening = async () => {
    try {
    await waitUntil(async () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Wrapper exited early: ${output}`);
      try {
        return (await request("/healthz")).status === 200;
      } catch {
        return false;
      }
    }, "wrapper HTTP listener");
    } catch (error) {
      throw new Error(`${error.message}\n${output}`);
    }
  };
  await waitListening();
  return {
    base,
    request,
    authorized,
    events,
    get child() { return child; },
    restart: async () => {
      await stopWrapper();
      startWrapper();
      await waitListening();
    },
    root,
    state,
    workspace,
    config,
    logs: () => output,
    websocket: (url, headers = {}) =>
      new WebSocket(`ws://127.0.0.1:${wrapperPort}${url}`, {
        headers,
        handshakeTimeout: 5_000,
      }),
    waitReady: () =>
      waitUntil(
        async () =>
          (await (await request("/setup/healthz")).json()).gatewayReachable,
        "gateway startup readiness",
      ),
  };
}

async function rejectedUpgrade(client) {
  return new Promise((resolve, reject) => {
    client.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
      client.terminate();
    });
    client.once("error", (error) => {
      if (!client._req?.res) reject(error);
    });
    client.once("open", () => {
      client.close();
      reject(new Error("Unexpected successful WebSocket upgrade"));
    });
  });
}

async function firstMessage(client) {
  const timeout = setTimeout(() => client.terminate(), 5_000);
  try {
    const [data] = await Promise.race([
      once(client, "message"),
      once(client, "close").then(() => {
        throw new Error("WebSocket closed before its first message");
      }),
    ]);
    return data.toString();
  } finally {
    clearTimeout(timeout);
  }
}

test("unconfigured HTTP and WebSocket endpoints preserve authentication and validation contracts", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/setup")).status, 401);
  assert.equal((await f.request("/setup/api/status")).status, 401);
  assert.deepEqual(await (await f.request("/healthz")).json(), {
    ok: true,
    gateway: "unconfigured",
  });
  const root = await f.request("/", { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/setup");
  const status = await (await f.authorized("/setup/api/status")).json();
  assert.equal(status.configured, false);
  assert.ok(status.authGroups.some((group) => group.value === "openai"));
  const invalid = await f.authorized("/setup/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authChoice: "not-a-real-provider" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(
    (await f.events()).some((event) => event.type === "onboard-start"),
    false,
  );
  assert.equal(await rejectedUpgrade(f.websocket("/tui/ws")), 401);
  assert.equal(
    await rejectedUpgrade(f.websocket("/tui/ws", { Authorization: basic })),
    409,
  );
});

test("HTTP and WebSocket proxying substitutes gateway credentials only for server-validated Setup Basic", async (t) => {
  const f = await fixture(t, { configured: true });
  await f.waitReady();
  const wrongBasic = `Basic ${Buffer.from("admin:wrong-password").toString("base64")}`;
  const body = '{ "tool": "deliberately-nonexistent-fixture-tool", "args": {} }';
  for (const authorization of [undefined, wrongBasic, "Basic ???", "Bearer invalid-gateway-token"]) {
    const response = await f.request("/tools/invoke", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wrapper-authenticated": "true",
        "x-forwarded-for": "127.0.0.1",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body,
    });
    assert.equal(response.status, 401, authorization || "anonymous");
    assert.equal((await response.json()).error, "Unauthorized");
    const echo = await (await f.request("/api/echo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body,
    })).json();
    assert.equal(echo.headers.authorization, authorization);
    assert.equal(echo.body, body);
  }
  for (const authorization of [basic, `Bearer ${gatewayToken}`]) {
    const response = await f.request("/tools/invoke", {
      method: "POST", headers: { authorization, "content-type": "application/json" }, body,
    });
    assert.equal(response.status, 404, "valid caller reaches only the deliberately nonexistent mock tool");
    const origin = authorization === basic ? f.base : "https://explicit-bearer-client.example";
    const echo = await (await f.request("/api/echo", {
      headers: { authorization, origin },
    })).json();
    assert.equal(echo.headers.authorization, `Bearer ${gatewayToken}`);
    assert.equal(echo.headers.origin, origin);
    const ws = f.websocket("/protected-socket", { authorization });
    const upstream = JSON.parse(await firstMessage(ws));
    assert.equal(upstream.headers.authorization, `Bearer ${gatewayToken}`);
    const closed = once(ws, "close"); ws.close(); await closed;
  }
  for (const authorization of [undefined, wrongBasic, "Basic ???", "Bearer invalid-gateway-token"])
    assert.equal(await rejectedUpgrade(f.websocket("/protected-socket", authorization === undefined ? {} : { authorization })), 401);

  for (const origin of ["null", "https://foreign.example"]) {
    const response = await f.request("/tools/invoke", {
      method: "POST",
      headers: { authorization: basic, origin, "x-forwarded-host": "foreign.example", "x-forwarded-proto": "https", "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 401, "cached Basic must not become a cross-site Gateway bearer");
    const echoed = await (await f.request("/api/echo", { headers: { authorization: basic, origin } })).json();
    assert.equal(echoed.headers.authorization, basic);
    assert.equal(echoed.headers.origin, origin);
    assert.equal(await rejectedUpgrade(f.websocket("/protected-socket", { authorization: basic, origin })), 401);
  }
  assert.equal((await f.request("/tools/invoke", {
    method: "POST", headers: { authorization: basic, origin: f.base, "content-type": "application/json" }, body,
  })).status, 404, "same-origin cached Basic retains compatibility");
  assert.equal((await f.request("/tools/invoke", {
    method: "POST", headers: { authorization: `Bearer ${gatewayToken}`, origin: "https://foreign.example", "content-type": "application/json" }, body,
  })).status, 404, "explicit bearer stays under native Gateway validation");

  for (const route of ["/hooks", "/hooks/fixture", "/j/one-time-code", "/__openclaw__/worker", "/__openclaw__/worker-bundle/artifact", "/__openclaw__/worker-transfer/transfer", "/__openclaw__/worker-bootstrap/bootstrap"]) {
    for (const authorization of [basic, "Bearer independent-capability"]) {
      const echoed = await (await f.request(route, { headers: { authorization } })).json();
      assert.equal(echoed.headers.authorization, authorization, route);
    }
  }
  assert.equal((await f.request("/")).status, 200, "public dashboard/static admission is left to the Gateway");
});

test("onboarding, JSON proxy bodies, hook auth, gateway WebSocket, pairing, TUI and reset work together", async (t) => {
  const f = await fixture(t);
  const setup = await f.authorized("/setup/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authChoice: "openai-api-key",
      authSecret: apiSecret,
    }),
  });
  const setupOutput = await setup.text();
  assert.match(setupOutput, /\[setup\] Complete\./);
  assert.equal(setupOutput.includes(apiSecret), false);
  await f.waitReady();
  const body = JSON.stringify({
    arbitrary: "preserve raw request bytes",
    count: 7,
  });
  const proxied = await (
    await f.authorized("/api/echo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body,
    })
  ).json();
  assert.equal(proxied.body, body);
  assert.equal(proxied.headers.authorization, `Bearer ${gatewayToken}`);
  assert.equal(proxied.headers["x-forwarded-for"], "192.0.2.1");
  const hook = await (
    await f.request("/hooks/test", {
      method: "POST",
      headers: {
        authorization: "Bearer separate-hook-secret",
        "content-type": "application/json",
      },
      body,
    })
  ).json();
  assert.equal(hook.headers.authorization, "Bearer separate-hook-secret");
  assert.equal(hook.body, body);
  const ws = f.websocket("/socket", {
    Authorization: basic,
    Origin: f.base,
    "x-forwarded-for": "127.0.0.1",
  });
  const handshake = JSON.parse(await firstMessage(ws));
  assert.equal(handshake.headers.authorization, `Bearer ${gatewayToken}`);
  assert.equal(handshake.headers.origin, f.base);
  assert.equal(handshake.headers["x-forwarded-for"], "192.0.2.1");
  ws.close();
  const devices = await (await f.authorized("/setup/api/devices")).json();
  assert.equal(devices.data.pending[0].requestId, "fixture-request");
  const approved = await (
    await f.authorized("/setup/api/devices/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "fixture-request" }),
    })
  ).json();
  assert.equal(approved.ok, true);
  const tui = f.websocket("/tui/ws", { Authorization: basic });
  await once(tui, "open");
  const tuiOutput = firstMessage(tui);
  tui.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
  let terminalOutput;
  try {
    terminalOutput = await tuiOutput;
  } catch (error) {
    throw new Error(`${error.message}\n${f.logs()}`);
  }
  assert.match(terminalOutput, /TUI-FIXTURE-READY/);
  const tuiClosed = once(tui, "close");
  tui.close();
  await tuiClosed;
  const reset = await f.authorized("/setup/api/reset", { method: "POST" });
  const resetOutput = await reset.text();
  assert.equal(reset.status, 200, `${resetOutput}\n${f.logs()}`);
  assert.equal((await f.request("/", { redirect: "manual" })).status, 302);
  await assert.rejects(fs.access(f.config), { code: "ENOENT" });
});

test("a running onboarding operation rejects competing mutations and public gateway upgrades", async (t) => {
  const f = await fixture(t, { onboardDelayMs: 800 });
  const setup = await f.authorized("/setup/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authChoice: "openai-api-key",
      authSecret: apiSecret,
    }),
  });
  await waitUntil(
    async () =>
      (await f.events()).some((event) => event.type === "onboard-start"),
    "onboarding child",
  );
  assert.equal(
    (await f.authorized("/setup/api/reset", { method: "POST" })).status,
    409,
  );
  assert.equal((await f.request("/gateway")).status, 503);
  assert.equal(await rejectedUpgrade(f.websocket("/socket")), 503);
  assert.match(await setup.text(), /\[setup\] Complete\./);
});

test("HTTP and WebSocket requests recheck maintenance after awaiting gateway readiness", async (t) => {
  const f = await fixture(t, {
    gatewayReadyDelayMs: 600,
    pairingApprovalDelayMs: 1_300,
  });
  const setup = await f.authorized("/setup/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authChoice: "openai-api-key",
      authSecret: apiSecret,
    }),
  });
  assert.match(await setup.text(), /\[setup\] Complete\./);
  const pendingHttp = f.request("/pending-before-maintenance");
  const socket = f.websocket("/pending-before-maintenance");
  const socketOutcome = new Promise((resolve) => {
    socket.once("open", () => {
      resolve("upgraded");
      socket.close();
    });
    socket.once("error", () => resolve("rejected"));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve("rejected");
      socket.terminate();
    });
  });
  await pause(50);
  const approving = f.authorized("/setup/api/devices/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "fixture-request" }),
  });
  await waitUntil(
    async () =>
      (await f.events()).some((event) => event.type === "pairing-start"),
    "overlapping maintenance mutation",
  );
  assert.equal((await pendingHttp).status, 503);
  assert.equal(await socketOutcome, "rejected");
  assert.equal((await approving).status, 200);
  await f.waitReady();
});

test("aborting a streamed onboarding request terminates its child and releases the mutation", async (t) => {
  const f = await fixture(t, { onboardDelayMs: 3_000 });
  const controller = new AbortController();
  const setup = await f.authorized("/setup/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      authChoice: "openai-api-key",
      authSecret: apiSecret,
    }),
  });
  const body = setup.text().catch(() => {});
  await waitUntil(
    async () =>
      (await f.events()).some((event) => event.type === "onboard-start"),
    "onboarding child",
  );
  controller.abort();
  await body;
  assert.equal(
    (await (await f.authorized("/setup/api/status")).json()).configured,
    false,
  );
  await fs.access(f.config);
  await waitUntil(
    async () =>
      (await f.authorized("/setup/api/reset", { method: "POST" })).status ===
      200,
    "cancelled onboarding to release maintenance lock",
    2_000,
  );
  assert.equal(
    (await f.events()).some((event) => event.type === "onboard-complete"),
    false,
  );
  assert.equal((await f.request("/healthz")).status, 200);
});

test("wrapper shutdown awaits kill escalation for an onboarding child that ignores SIGTERM", async (t) => {
  const f = await fixture(t, {
    onboardDelayMs: 4_000,
    ignoreOnboardTerm: true,
  });
  const setup = await f.authorized("/setup/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authChoice: "openai-api-key",
      authSecret: apiSecret,
    }),
  });
  const body = setup.text().catch(() => {});
  await waitUntil(
    async () =>
      (await f.events()).some((event) => event.type === "onboard-start"),
    "onboarding child before shutdown",
  );
  const onboardPid = (await f.events()).find(
    (event) => event.type === "onboard-start",
  ).pid;
  t.after(() => {
    try {
      process.kill(onboardPid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  const exited = once(f.child, "exit");
  f.child.kill("SIGTERM");
  const [code, signal] = await exited;
  await body;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.ok(
    (await f.events()).some((event) => event.type === "onboard-term-ignored"),
  );
  assert.equal(
    (await f.events()).some((event) => event.type === "onboard-complete"),
    false,
  );
  assert.throws(() => process.kill(onboardPid, 0), { code: "ESRCH" });
});

test("a plugin-created config from failed onboarding remains unconfigured and can be retried", async (t) => {
  const f = await fixture(t, { onboardFailures: 1 });
  const payload = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authChoice: "openai-api-key",
      authSecret: apiSecret,
    }),
  };
  const first = await f.authorized("/setup/api/run", payload);
  assert.match(await first.text(), /\[setup\] Failed\./);
  await fs.access(f.config);
  assert.equal(
    (await (await f.authorized("/setup/api/status")).json()).configured,
    false,
  );
  assert.equal((await f.request("/", { redirect: "manual" })).status, 302);
  assert.equal(
    (await f.events()).some((event) => event.type === "gateway-start"),
    false,
  );
  const retried = await f.authorized("/setup/api/run", payload);
  assert.match(await retried.text(), /\[setup\] Complete\./);
  await f.waitReady();
});

test("device SDK state owners are fresh after reset and replacing the same state path", async (t) => {
  const f = await fixture(t);
  const payload = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authChoice: "openai-api-key",
      authSecret: apiSecret,
    }),
  };
  assert.match(
    await (await f.authorized("/setup/api/run", payload)).text(),
    /\[setup\] Complete\./,
  );
  await f.waitReady();
  const before = await (await f.authorized("/setup/api/devices")).json();
  assert.equal(before.data.pending[0].requestId, "fixture-request");
  assert.equal(
    (await f.authorized("/setup/api/reset", { method: "POST" })).status,
    200,
  );
  await fs.rename(f.state, `${f.state}-previous`);
  await fs.mkdir(f.state);
  await fs.writeFile(
    path.join(f.state, "fixture-device-marker"),
    "after-state-swap",
  );
  assert.match(
    await (await f.authorized("/setup/api/run", payload)).text(),
    /\[setup\] Complete\./,
  );
  await f.waitReady();
  const after = await (await f.authorized("/setup/api/devices")).json();
  assert.equal(after.data.pending[0].requestId, "after-state-swap");
  assert.notEqual(after.data.fixtureReaderPid, before.data.fixtureReaderPid);
});

test("authenticated full wipe stops gateway/TUI, removes recovery secrets, retains token and permits fresh setup", async (t) => {
  const f = await fixture(t, { configured: true });
  await f.waitReady();
  const recoveryRoot = path.join(f.root, ".wrapper-upgrade-recovery");
  const attempts = await fs.readdir(path.join(recoveryRoot, "attempts"));
  assert.equal(attempts.length, 1);
  const attemptRoot = path.join(recoveryRoot, "attempts", attempts[0]);
  const recoveryManifest = JSON.parse(
    await fs.readFile(path.join(attemptRoot, "manifest.json"), "utf8"),
  );
  const canonicalState = await fs.realpath(f.state);
  const stateRecord = recoveryManifest.records.findIndex(
    (record) => record.target === canonicalState,
  );
  assert.ok(stateRecord >= 0);
  const recoveryMetadata = [
    path.join(recoveryRoot, "last-success.json"),
    path.join(attemptRoot, "manifest.json"),
  ];
  const metadataBefore = await Promise.all(
    recoveryMetadata.map((filename) => fs.readFile(filename, "utf8")),
  );
  const privateFiles = [
    path.join(f.state, "credentials", "private.fixture"),
    path.join(f.workspace, "private.fixture"),
    path.join(attemptRoot, "snapshot", String(stateRecord), "private.fixture"),
    path.join(recoveryRoot, "transaction-private.fixture"),
    path.join(f.root, ".wrapper-upgrade-snapshots", "2026.10.4", "private.fixture"),
    path.join(f.root, ".wrapper-upgrade-failed-fixture", "private.fixture"),
    path.join(f.root, ".wrapper-upgrade-restore-fixture", "private.fixture"),
    path.join(f.root, ".wrapper-import-staging", "pending", "private.fixture"),
    path.join(f.root, ".wrapper-import-rollback", "private.fixture"),
    path.join(
      f.root,
      ".wrapper-import-rollback.abcdef.state",
      "private.fixture",
    ),
    path.join(
      f.root,
      ".wrapper-import-rollback.abcdef.workspace",
      "private.fixture",
    ),
  ];
  await Promise.all(
    privateFiles.map(async (filename) => {
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, "synthetic-private-content");
    }),
  );
  const terminal = f.websocket("/tui/ws", { Authorization: basic });
  await once(terminal, "open");
  const terminalOutput = firstMessage(terminal);
  terminal.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
  assert.match(await terminalOutput, /TUI-FIXTURE-READY/);
  const pids = (await f.events())
    .filter((event) => ["gateway-start", "tui-start"].includes(event.type))
    .map((event) => event.pid);
  assert.equal(pids.length, 2);
  const wipe = (provided, authenticated = true) =>
    (authenticated ? f.authorized : f.request)("/setup/api/wipe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: provided }),
    });
  assert.equal((await wipe(password, false)).status, 401);
  assert.equal((await wipe("incorrect-password")).status, 401);
  for (const filename of privateFiles)
    assert.equal(await fs.readFile(filename, "utf8"), "synthetic-private-content");
  assert.deepEqual(
    await Promise.all(recoveryMetadata.map((filename) => fs.readFile(filename, "utf8"))),
    metadataBefore,
  );
  assert.equal(terminal.readyState, WebSocket.OPEN);
  assert.equal((await f.request("/still-running")).status, 200);
  const closed = once(terminal, "close");
  const result = await wipe(password);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).ok, true);
  const [code] = await closed;
  assert.equal(code, 1001);
  await waitUntil(
    () =>
      pids.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if (error.code === "ESRCH") return true;
          throw error;
        }
      }),
    "gateway and terminal children to exit",
  );
  for (const filename of privateFiles)
    await assert.rejects(fs.access(filename), { code: "ENOENT" });
  const roots = await fs.readdir(f.root);
  assert.equal(
    roots.some((name) =>
      /^\.wrapper-(?:upgrade-snapshots$|upgrade-recovery$|upgrade-failed-|upgrade-restore-|import-staging$|import-rollback(?:\.|$))/.test(
        name,
      ),
    ),
    false,
  );
  await assert.rejects(fs.access(recoveryRoot), { code: "ENOENT" });
  await assert.rejects(fs.access(f.config), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(f.workspace), []);
  assert.deepEqual((await fs.readdir(f.state)).sort(), [
    "gateway.token",
    "wrapper.log",
  ]);
  assert.equal(
    await fs.readFile(path.join(f.state, "gateway.token"), "utf8"),
    gatewayToken,
  );
  const status = await (await f.authorized("/setup/api/status")).json();
  assert.equal(status.configured, false);
  assert.equal(status.gatewayToken, gatewayToken);
  assert.equal((await f.request("/", { redirect: "manual" })).status, 302);
  const setup = await f.authorized("/setup/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authChoice: "openai-api-key",
      authSecret: apiSecret,
    }),
  });
  assert.match(await setup.text(), /\[setup\] Complete\./);
  await f.waitReady();
  const upstream = await (await f.authorized("/fresh-state")).json();
  assert.equal(upstream.headers.authorization, `Bearer ${gatewayToken}`);
});

test("onboarding exit zero without a persisted provider credential never marks setup complete", async (t) => {
  const f = await fixture(t, { emptyProfiles: true });
  const setup = await f.authorized("/setup/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authChoice: "openai-api-key",
      authSecret: apiSecret,
    }),
  });
  const output = await setup.text();
  assert.doesNotMatch(output, /\[setup\] Complete\./);
  assert.equal(
    (await (await f.authorized("/setup/api/status")).json()).configured,
    false,
  );
  assert.equal(
    (await f.events()).some((event) => event.type === "gateway-start"),
    false,
  );
});

test("configured boot completes Doctor before lazy HTTP startup can launch the gateway", async (t) => {
  const f = await fixture(t, { configured: true, doctorDelayMs: 300 });
  const requestingGateway = f.request("/probe");
  await requestingGateway;
  await f.waitReady();
  const events = await f.events();
  const completed = events.findIndex(
    (event) => event.type === "doctor-complete",
  );
  const started = events.findIndex((event) => event.type === "gateway-start");
  assert.ok(
    completed >= 0 && started > completed,
    `Gateway must start after Doctor; observed ${JSON.stringify(events)}`,
  );
});

async function writeLegacyPluginConfig({ config, workspace }) {
  await fs.writeFile(config, JSON.stringify({
    gateway: { mode: "local" },
    agents: {
      defaults: { workspace, memorySearch: { enabled: true, provider: "none" } },
      list: [{ id: "main" }],
    },
    channels: {
      discord: { enabled: false, token: "retained-disabled-discord-token", dm: { policy: "pairing" } },
      slack: { enabled: false, botToken: "retained-disabled-slack-token" },
    },
  }));
}

test("configured upgrade migrates legacy core fields before reconciling disabled channel plugins", async (t) => {
  const f = await fixture(t, {
    configured: true,
    enforceMigratedPluginConfig: true,
    prepareState: writeLegacyPluginConfig,
  });
  await f.waitReady();
  const events = await f.events();
  const repaired = events.findIndex((event) => event.type === "doctor-complete");
  const installed = events.findIndex((event) => event.type === "plugin-installed");
  assert.ok(repaired >= 0 && installed > repaired);
  assert.equal(events.some((event) => event.type === "plugin-legacy-config-refused"), false);
  const config = JSON.parse(await fs.readFile(f.config, "utf8"));
  assert.equal(config.agents.list, undefined);
  assert.deepEqual(Object.keys(config.agents.entries), ["main"]);
  assert.equal(config.channels.discord.enabled, false);
  assert.equal(config.channels.discord.token, "retained-disabled-discord-token");
  assert.equal(config.channels.discord.dmPolicy, "pairing");
  assert.equal(config.channels.slack.enabled, false);
  assert.equal(config.channels.slack.botToken, "retained-disabled-slack-token");
});

test("explicit retry also repairs legacy configuration before channel plugin commands", async (t) => {
  const f = await fixture(t, {
    configured: true,
    doctorFailures: 1,
    enforceMigratedPluginConfig: true,
    prepareState: writeLegacyPluginConfig,
  });
  await waitUntil(() => f.logs().includes("Boot upgrade failed"), "legacy upgrade failure to restore");
  assert.equal((await f.events()).filter((event) => event.type === "doctor-start").length, 1);
  assert.equal((await f.events()).some((event) => event.type === "plugin-installed"), false);
  assert.ok(JSON.parse(await fs.readFile(f.config, "utf8")).agents.list);
  const retried = await f.authorized("/setup/api/doctor", { method: "POST" });
  assert.equal(retried.status, 200, await retried.clone().text());
  await f.waitReady();
  const events = await f.events();
  const repaired = events.findIndex((event) => event.type === "doctor-complete");
  const installed = events.findIndex((event) => event.type === "plugin-installed");
  assert.ok(repaired >= 0 && installed > repaired);
  assert.equal(events.some((event) => event.type === "plugin-legacy-config-refused"), false);
});

test("the intermediate bridge cannot erase source-version evidence for old opt-in defaults", async (t) => {
  const f = await fixture(t, {
    configured: true,
    prepareState: async ({ root, state, workspace, config }) => {
      await fs.writeFile(config, JSON.stringify({
        meta: { lastTouchedVersion: "2026.6.6" },
        gateway: { mode: "local" },
        agents: { defaults: { workspace }, list: [{ id: "main" }] },
      }));
      await fs.mkdir(path.join(state, "plugins"));
      await fs.writeFile(path.join(state, "plugins", "installs.json"), "{}");
      await fs.mkdir(path.join(state, "state"));
      const db = new DatabaseSync(path.join(state, "state", "openclaw.sqlite"));
      try {
        db.exec("PRAGMA user_version=1; CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY,role TEXT,schema_version INTEGER,app_version TEXT); INSERT INTO schema_meta VALUES ('primary','global',1,'2026.6.6')");
      } finally { db.close(); }
      const prefix = path.join(root, ".wrapper-migration-tools", "2026.9.5");
      const tool = path.join(prefix, "node_modules", "openclaw");
      await fs.mkdir(path.join(tool, "dist"), { recursive: true });
      await fs.writeFile(path.join(tool, "package.json"), JSON.stringify({
        name: "openclaw", version: "2026.9.5", type: "module",
        openclaw: { schemaVersions: { state: 17, agent: 21 } },
      }));
      await fs.writeFile(path.join(prefix, ".wrapper-install-complete"), "2026.9.5");
      await fs.writeFile(path.join(tool, "dist", "entry.js"), `
        import fs from "node:fs";
        import path from "node:path";
        import { DatabaseSync } from "node:sqlite";
        const filename = process.env.OPENCLAW_CONFIG_PATH || path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json");
        const config = JSON.parse(fs.readFileSync(filename, "utf8"));
        config.meta.lastTouchedVersion = "2026.9.5";
        config.agents.entries = Object.fromEntries(config.agents.list.map(({ id, ...entry }) => [id, entry]));
        delete config.agents.list;
        const db = new DatabaseSync(path.join(process.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"));
        try { db.exec("PRAGMA user_version=17; UPDATE schema_meta SET schema_version=17,app_version='2026.9.5'"); }
        finally { db.close(); }
        fs.writeFileSync(filename, JSON.stringify(config));
        fs.rmSync(path.join(process.env.OPENCLAW_STATE_DIR, "plugins", "installs.json"));
        fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({ type: "bridge-complete", pid: process.pid, time: Date.now() }) + "\\n");
      `);
    },
  });
  await f.waitReady();
  const config = JSON.parse(await fs.readFile(f.config, "utf8"));
  assert.equal(config.meta.lastTouchedVersion, "2026.9.5");
  assert.equal(config.agents.list, undefined);
  assert.equal(config.plugins.entries["memory-core"].config.dreaming.enabled, false);
  assert.equal(config.skills.workshop.autonomous.mode, "off");
  assert.equal(config.skills.workshop.approvalPolicy, "pending");
  assert.equal((await f.events()).filter((event) => event.type === "bridge-complete").length, 1);
});

test("a current SQLite schema prevents stale old config metadata from disabling newer defaults", async (t) => {
  const f = await fixture(t, {
    configured: true,
    prepareState: async ({ state, workspace, config }) => {
      await fs.writeFile(config, JSON.stringify({
        meta: { lastTouchedVersion: "2026.6.6" }, gateway: { mode: "local" },
        agents: { defaults: { workspace }, list: [{ id: "main" }] },
      }));
      await fs.mkdir(path.join(state, "state"));
      const db = new DatabaseSync(path.join(state, "state", "openclaw.sqlite"));
      try {
        db.exec("PRAGMA user_version=20; CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY,role TEXT,schema_version INTEGER,app_version TEXT); INSERT INTO schema_meta VALUES ('primary','global',20,'2026.10.4')");
      } finally { db.close(); }
    },
  });
  await f.waitReady();
  const config = JSON.parse(await fs.readFile(f.config, "utf8"));
  assert.equal(config.plugins?.entries?.["memory-core"]?.config?.dreaming, undefined);
  assert.equal(config.skills?.workshop, undefined);
});

test("deployment health waits through Doctor, migration canary, and normal gateway readiness", async (t) => {
  const f = await fixture(t, {
    configured: true,
    doctorDelayMs: 400,
    canaryReadyDelayMs: 700,
    gatewayReadyDelayMs: 700,
  });
  const waitEvent = (type) => waitUntil(
    async () => (await f.events()).some((event) => event.type === type),
    type,
  );
  await waitEvent("doctor-start");
  assert.equal((await f.request("/setup/healthz")).status, 503);
  assert.equal((await f.request("/dashboard-during-doctor")).status, 503);
  await waitEvent("gateway-canary-start");
  assert.equal((await f.request("/setup/healthz")).status, 503);
  assert.equal((await f.request("/dashboard-during-canary")).status, 503);
  await waitEvent("gateway-start");
  assert.equal((await f.request("/setup/healthz")).status, 503);
  await f.waitReady();
  assert.equal((await f.request("/setup/healthz")).status, 200);
  assert.equal((await f.request("/dashboard-after-activation")).status, 200);
  const events = await f.events();
  const doctor = events.findIndex((event) => event.type === "doctor-complete");
  const canary = events.findIndex((event) => event.type === "gateway-canary-start");
  const normal = events.findIndex((event) => event.type === "gateway-start");
  assert.ok(doctor >= 0 && canary > doctor && normal > canary);
  assert.equal(events[canary].skipChannels, "1");
  assert.equal(events[canary].skipCron, "1");
  assert.equal(events[normal].skipChannels, null);
  assert.equal(events[normal].skipCron, null);
});

test("failed boot restores user data, stays blocked after restart, and permits only authenticated Doctor retry", async (t) => {
  const originalConfig = JSON.stringify({ gateway: { mode: "local" }, userFixture: "retain custom config" });
  const f = await fixture(t, {
    configured: true,
    doctorFailures: 1,
    prepareState: async ({ state, workspace, config }) => {
      await fs.writeFile(config, originalConfig);
      await fs.writeFile(path.join(state, "persistent-fixture.txt"), "original conversation history");
      await fs.writeFile(path.join(workspace, "user-notes.md"), "original memory and notes");
    },
  });
  await waitUntil(() => f.logs().includes("Boot upgrade failed"), "failed upgrade to settle and restore");
  assert.equal((await f.request("/setup/healthz")).status, 503);
  assert.equal((await f.request("/blocked-gateway")).status, 503);
  assert.equal(await fs.readFile(f.config, "utf8"), originalConfig);
  assert.equal(await fs.readFile(path.join(f.state, "persistent-fixture.txt"), "utf8"), "original conversation history");
  assert.equal(await fs.readFile(path.join(f.workspace, "user-notes.md"), "utf8"), "original memory and notes");
  await assert.rejects(fs.access(path.join(f.state, "doctor-new-secret.fixture")), { code: "ENOENT" });
  const recoveryRoot = path.join(f.root, ".wrapper-upgrade-recovery");
  const firstAttempt = await fs.readdir(path.join(recoveryRoot, "attempts"));
  assert.equal(firstAttempt.length, 1);
  await fs.access(path.join(recoveryRoot, "attempts", firstAttempt[0], "manifest.json"));
  assert.equal(JSON.parse(await fs.readFile(path.join(recoveryRoot, "active.json"), "utf8")).status, "rolled-back");
  assert.equal((await f.events()).filter((event) => event.type === "doctor-start").length, 1);
  await f.restart();
  await pause(150);
  assert.equal((await f.request("/setup/healthz")).status, 503);
  assert.equal((await f.request("/still-blocked")).status, 503);
  assert.equal((await f.events()).filter((event) => event.type === "doctor-start").length, 1);
  assert.equal((await f.events()).some((event) => event.type.startsWith("gateway-")), false);
  const blockedEvents = await f.events();
  // Passive diagnostics must not initialize the newer CLI or SDK against the
  // restored old schema. All other live-state APIs fail closed until recovery.
  assert.equal((await f.authorized("/setup/api/status")).status, 200);
  const debug = await f.authorized("/setup/api/debug");
  assert.equal(debug.status, 200);
  assert.equal((await debug.json()).openclaw.version, "2026.10.4");
  assert.equal((await f.authorized("/setup/api/logs")).status, 200);
  for (const [method, url] of [
    ["GET", "/setup/api/devices"],
    ["POST", "/setup/api/devices/approve"],
    ["POST", "/setup/api/devices/reject"],
    ["POST", "/setup/api/pairing/approve"],
    ["GET", "/setup/api/export"],
    ["POST", "/setup/api/run"],
    ["GET", "/setup/api/future-live-state-route"],
    ["GET", "/tui"],
  ]) {
    const response = await f.authorized(url, { method });
    assert.equal(response.status, 503, `${method} ${url}`);
  }
  assert.equal((await f.request("/setup/api/devices")).status, 401);
  assert.equal(await rejectedUpgrade(f.websocket("/tui/ws", { Authorization: basic })), 503);
  assert.equal(await rejectedUpgrade(f.websocket("/socket", { Authorization: basic })), 503);
  assert.deepEqual(await f.events(), blockedEvents);
  assert.equal((await f.request("/setup/api/doctor", { method: "POST" })).status, 401);
  assert.equal((await f.authorized("/setup/api/doctor", {
    method: "POST", headers: { Authorization: "Basic aW52YWxpZDp3cm9uZw==" },
  })).status, 401);
  assert.equal((await f.events()).filter((event) => event.type === "doctor-start").length, 1);
  const retried = await f.authorized("/setup/api/doctor", { method: "POST" });
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal((await retried.json()).ok, true);
  await f.waitReady();
  assert.equal((await f.events()).filter((event) => event.type === "doctor-start").length, 2);
  assert.equal((await fs.readdir(path.join(recoveryRoot, "attempts"))).length, 2);
  assert.equal(await fs.readFile(path.join(f.state, "persistent-fixture.txt"), "utf8"), "original conversation history");
  assert.equal(await fs.readFile(path.join(f.workspace, "user-notes.md"), "utf8"), "original memory and notes");
});

test("ordinary same-version restart preserves new user data without rerunning Doctor or stale rollback", async (t) => {
  const f = await fixture(t, { configured: true });
  await f.waitReady();
  const recoveryRoot = path.join(f.root, ".wrapper-upgrade-recovery");
  const originalAttempts = await fs.readdir(path.join(recoveryRoot, "attempts"));
  assert.equal(originalAttempts.length, 1);
  const config = JSON.parse(await fs.readFile(f.config, "utf8"));
  config.newUserSetting = "created after successful upgrade";
  await fs.writeFile(f.config, JSON.stringify(config));
  await fs.writeFile(path.join(f.state, "post-upgrade-history.txt"), "new conversations");
  await fs.writeFile(path.join(f.workspace, "post-upgrade-memory.md"), "new memory");
  await f.restart();
  await f.waitReady();
  assert.equal((await f.events()).filter((event) => event.type === "doctor-start").length, 1);
  assert.equal((await f.events()).filter((event) => event.type === "gateway-canary-start").length, 1);
  assert.deepEqual(await fs.readdir(path.join(recoveryRoot, "attempts")), originalAttempts);
  assert.equal(await fs.readFile(path.join(f.state, "post-upgrade-history.txt"), "utf8"), "new conversations");
  assert.equal(await fs.readFile(path.join(f.workspace, "post-upgrade-memory.md"), "utf8"), "new memory");
  assert.equal(JSON.parse(await fs.readFile(f.config, "utf8")).newUserSetting, "created after successful upgrade");
  // Explicit maintenance is a fresh recovery transaction even on this release.
  assert.equal((await f.request("/setup/api/doctor", { method: "POST" })).status, 401);
  assert.equal((await f.events()).filter((event) => event.type === "doctor-start").length, 1);
  const repair = await f.authorized("/setup/api/doctor", { method: "POST" });
  assert.equal(repair.status, 200, await repair.clone().text());
  await f.waitReady();
  assert.equal((await f.events()).filter((event) => event.type === "doctor-start").length, 2);
  assert.equal((await fs.readdir(path.join(recoveryRoot, "attempts"))).length, 2);
  assert.equal(await fs.readFile(path.join(f.state, "post-upgrade-history.txt"), "utf8"), "new conversations");
});

test("device-code onboarding streams its URL/code through a real PTY and persists OAuth credentials", async (t) => {
  const f = await fixture(t);
  const setup = await f.authorized("/setup/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authChoice: "openai-device-code" }),
  });
  const output = await setup.text();
  assert.match(output, /https:\/\/fixture\.invalid\/device/);
  assert.match(output, /ABCD-EFGH/);
  assert.match(output, /\[setup\] Complete\./);
  await f.waitReady();
});

test("terminal sessions expire before any resize or PTY spawn", async (t) => {
  const f = await fixture(t, {
    configured: true,
    tuiIdleTimeoutMs: 150,
    tuiMaxSessionMs: 1_000,
  });
  await f.waitReady();
  const client = f.websocket("/tui/ws", { Authorization: basic });
  await once(client, "open");
  const [code, reason] = await once(client, "close");
  assert.equal(code, 4002);
  assert.match(reason.toString(), /Idle timeout/);
  assert.doesNotMatch(f.logs(), /spawning PTY/);
  assert.equal((await f.request("/healthz")).status, 200);
});

test("terminal malformed JSON recovers and oversized frames close without crashing the wrapper", async (t) => {
  const f = await fixture(t, {
    configured: true,
    tuiIdleTimeoutMs: 2_000,
    tuiMaxSessionMs: 5_000,
  });
  await f.waitReady();
  const client = f.websocket("/tui/ws", { Authorization: basic });
  await once(client, "open");
  client.send("not json");
  client.send(JSON.stringify({ type: "resize", cols: "invalid", rows: null }));
  const output = firstMessage(client);
  client.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
  assert.match(await output, /TUI-FIXTURE-READY/);
  const closed = once(client, "close");
  client.close();
  await closed;
  await pause(30);
  const oversized = f.websocket("/tui/ws", { Authorization: basic });
  await once(oversized, "open");
  const closing = once(oversized, "close");
  oversized.send(Buffer.alloc(70 * 1024, 65));
  const [code] = await closing;
  assert.equal(code, 1009);
  assert.equal((await f.request("/healthz")).status, 200);
});
