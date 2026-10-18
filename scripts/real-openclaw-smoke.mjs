import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const repository = fileURLToPath(new URL("../", import.meta.url));
const entry = process.env.OPENCLAW_ENTRY;
if (!entry || !path.isAbsolute(entry)) {
  throw new Error(
    "Set OPENCLAW_ENTRY to the installed target package absolute dist/entry.js path. This test never installs packages or uses existing user state.",
  );
}
await fs.access(entry);
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const n = server.address().port;
  await new Promise((r) => server.close(r));
  return n;
}
const publicPort = await port(),
  internalPort = await port();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-real-wrapper-"));
const password = "development-only-setup-password";
const auth = "Basic " + Buffer.from("admin:" + password).toString("base64");
const env = {
  PATH: process.env.PATH,
  HOME: root,
  TMPDIR: root,
  PORT: String(publicPort),
  INTERNAL_GATEWAY_PORT: String(internalPort),
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
  OPENCLAW_ENTRY: entry,
  OPENCLAW_NODE: process.execPath,
  OPENCLAW_GATEWAY_TOKEN: "development-only-gateway-token",
  SETUP_PASSWORD: password,
};
let logs = "";
function launchWrapper() {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: repository,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (s) => (logs = (logs + s).slice(-20000)));
  child.stderr.on("data", (s) => (logs = (logs + s).slice(-20000)));
  return child;
}
let child = launchWrapper();
async function stopWrapper() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => {});
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 15000);
  await exited;
  clearTimeout(timer);
}
const base = `http://127.0.0.1:${publicPort}`;
async function request(url, options = {}) {
  return fetch(base + url, {
    ...options,
    headers: { Authorization: auth, ...options.headers },
    signal: AbortSignal.timeout(310000),
  });
}
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Readiness timeout");
}
try {
  await until(async () => (await fetch(base + "/healthz")).ok, 10000);
  console.log("PASS real wrapper unconfigured boot");
  let response = await request("/setup/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authChoice: "apiKey",
      authSecret: "development-dummy-anthropic-key",
    }),
  });
  const result = await response.text();
  assert.ok(result.includes("[setup] Complete."), result);
  console.log("PASS real package onboarding and SDK credential persistence");
  await until(
    async () =>
      (await (await fetch(base + "/healthz")).json()).gateway === "ready",
    120000,
  );
  console.log("PASS real package gateway /startupz readiness");
  response = await request("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /html/);
  console.log("PASS actual gateway dashboard proxy");
  response = await request("/setup/api/devices");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  console.log("PASS real public pairing SDK via isolated worker");
  // Seed only this disposable fixture while its Gateway and wrapper are stopped.
  // Approval itself must go through the real authenticated wrapper with Gateway live.
  await stopWrapper();
  const publicKey = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .subarray(-32);
  const deviceId = createHash("sha256").update(publicKey).digest("hex");
  const requestId = randomUUID();
  const database = new DatabaseSync(
    path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"),
  );
  try {
    database
      .prepare(
        `INSERT INTO device_pairing_pending
      (request_id, device_id, public_key, display_name, client_id, client_mode,
       role, roles_json, scopes_json, silent, is_repair, ts, refreshed_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        deviceId,
        publicKey.toString("base64url"),
        "Synthetic smoke device",
        "openclaw-control-ui",
        "webchat",
        "operator",
        JSON.stringify(["operator"]),
        JSON.stringify(["operator.read"]),
        0,
        0,
        Date.now(),
        Date.now(),
      );
  } finally {
    database.close();
  }
  child = launchWrapper();
  await until(
    async () =>
      (await (await fetch(base + "/healthz")).json()).gateway === "ready",
    120000,
  );
  response = await request("/setup/api/devices");
  const beforeApproval = await response.json();
  assert.ok(
    beforeApproval.data?.pending?.some(
      (pending) => pending.requestId === requestId,
    ),
    "Synthetic pending device must survive boot migration",
  );
  response = await request("/setup/api/devices/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId }),
  });
  const approved = await response.json();
  assert.equal(
    approved.ok,
    true,
    approved.error || `Approval failed with status ${response.status}`,
  );
  response = await request("/setup/api/devices");
  const afterApproval = await response.json();
  assert.ok(
    afterApproval.data?.paired?.some((device) => device.deviceId === deviceId),
    "Public SDK must see committed approval while Gateway is ready",
  );
  assert.ok(
    !afterApproval.data?.pending?.some(
      (pending) => pending.requestId === requestId,
    ),
  );
  assert.equal(
    (await (await fetch(base + "/healthz")).json()).gateway,
    "ready",
    "Gateway must stay ready after external SDK approval",
  );
  console.log(
    "PASS real synthetic Ed25519 device approval with live Gateway and fresh SDK workers",
  );
  response = await request("/setup/api/export");
  assert.equal(response.status, 200, await response.clone().text());
  const archive = Buffer.from(await response.arrayBuffer());
  console.log(
    "PASS real SQLite-safe protected ZIP export",
    archive.length,
    "bytes",
  );
  response = await request("/setup/api/import/probe", {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      "X-Archive-Password": Buffer.from(password).toString("base64"),
    },
    body: archive,
  });
  const stage = await response.json();
  assert.equal(stage.ok, true, JSON.stringify(stage));
  console.log("PASS real ZIP import probe and manifest");
  response = await request("/setup/api/import/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stagingId: stage.stagingId,
      setupPassword: password,
    }),
  });
  const applied = await response.json();
  assert.equal(applied.ok, true, JSON.stringify(applied));
  console.log(
    "PASS real migrated import, device cleanup, state swap and restart",
  );
  response = await request("/setup/api/devices");
  assert.equal(response.status, 200);
  const restoredDevices = await response.json();
  assert.equal(restoredDevices.ok, true);
  assert.ok(
    !restoredDevices.data?.paired?.some(
      (device) => device.deviceId === deviceId,
    ),
    "Imported source-device authority must be removed",
  );
  console.log("PASS SDK after actual state swap");
  console.log("REAL_SMOKE_ALL_PASSED");
} catch (error) {
  console.log("REAL_SMOKE_FAILED", error.message);
  console.log(
    logs
      .slice(-1500)
      .replaceAll("development-dummy-anthropic-key", "[redacted]"),
  );
  process.exitCode = 1;
} finally {
  await stopWrapper();
  await fs.rm(root, { recursive: true, force: true });
}
