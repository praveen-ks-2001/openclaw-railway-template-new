import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import express from "express";
import httpProxy from "http-proxy";
import pty from "node-pty";
import { WebSocketServer } from "ws";
import { runCommand, createOutputFilter } from "./command-runner.js";
import { createGatewayManager } from "./gateway-manager.js";
import { applyProxyPolicy } from "./proxy-policy.js";
import JSON5 from "json5";
import {
  AUTH_GROUPS_PUBLIC,
  requiresInteractiveOnboarding,
  buildOnboardArgs as makeOnboardArgs,
  validatePayload,
  ensureRequiredPlugins,
} from "./openclaw-compat.js";
import {
  inspectZipArchive,
  assertSafeStagedTree,
  findStagedDataRoot,
  readStagedLayout,
  createDirectoryTransaction,
  requireFreeSpace,
} from "./state-transfer.js";
import { createNormalizedSnapshot } from "./state-backup.js";
import {
  sanitizeImportedTrust,
  validateStagedMigrationInputs,
} from "./import-trust.js";
import {
  migrateWrapperConfig,
  readSourceStateSchema,
  relocateImportedConfig,
} from "./config-migration.js";
import { createUpgradeRecovery } from "./upgrade-recovery.js";
import { summarizeStagedImport } from "./import-summary.js";
import { migrateRetiredPluginIndex } from "./legacy-migration.js";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();
const INCOMPLETE_SETUP_PATH = path.join(STATE_DIR, ".wrapper-setup-incomplete");

const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() ||
  "/usr/local/lib/node_modules/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

const OPENCLAW_ROOT = path.dirname(path.dirname(path.resolve(OPENCLAW_ENTRY)));
const upgradeRecovery = createUpgradeRecovery({ stateDir: STATE_DIR, workspaceDir: WORKSPACE_DIR,
  configPath: configPath(), version: installedVersion(), openclawRoot: OPENCLAW_ROOT });
let recoveredBootFailure = null;
const pendingRecovery = upgradeRecovery.status();
if (["migrating", "restoring"].includes(pendingRecovery.status)) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: INTERNAL_GATEWAY_HOST, port: INTERNAL_GATEWAY_PORT });
    socket.setTimeout(2000);
    socket.once("connect", () => { socket.destroy(); reject(new Error("A gateway is still running; refusing to restore shared data while a writer may be active")); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Could not prove the gateway has stopped before upgrade recovery")); });
    socket.once("error", (error) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
  });
}
const recoveredUpgrade = upgradeRecovery.recover();
if (recoveredUpgrade.blocked) recoveredBootFailure = "A failed upgrade was recovered. Original data is restored; use Run Doctor to deliberately retry or inspect the retained recovery snapshot.";

function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    console.warn(
      `[gateway-token] could not read existing token: ${err.code || err.message}`,
    );
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn(
      `[gateway-token] could not persist token: ${err.code || err.message}`,
    );
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;
process.env.OPENCLAW_SUPERVISOR_MODE = "external";
process.env.OPENCLAW_SERVICE_REPAIR_POLICY = "external";

let cachedOpenclawVersion = null;
let cachedChannelsHelp = null;

async function getOpenclawInfo() {
  if (activeMutation || bootFailure)
    return {
      version: cachedOpenclawVersion || installedVersion(),
      channelsHelp: bootFailure ? "" : cachedChannelsHelp || "",
    };
  if (!cachedOpenclawVersion) {
    const [version, channelsHelp] = await Promise.all([
      runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
      runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
    ]);
    cachedOpenclawVersion = version.output.trim();
    cachedChannelsHelp = channelsHelp.output;
  }
  return { version: cachedOpenclawVersion, channelsHelp: cachedChannelsHelp };
}

const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.TUI_IDLE_TIMEOUT_MS ?? "300000",
  10,
);
const TUI_MAX_SESSION_MS = Number.parseInt(
  process.env.TUI_MAX_SESSION_MS ?? "1800000",
  10,
);

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

const LOG_RING_LIMIT = 500;
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const logRing = [];
const logSubscribers = new Set();
const wrapperLogPath = path.join(STATE_DIR, "wrapper.log");

function trimWrapperLogIfLarge() {
  try {
    const stat = fs.statSync(wrapperLogPath);
    if (stat.size <= LOG_FILE_MAX_BYTES) return;
    const fd = fs.openSync(wrapperLogPath, "r");
    const keepBytes = Math.floor(LOG_FILE_MAX_BYTES / 2);
    const buf = Buffer.alloc(keepBytes);
    fs.readSync(fd, buf, 0, keepBytes, stat.size - keepBytes);
    fs.closeSync(fd);
    fs.writeFileSync(wrapperLogPath, buf);
  } catch {
    // best-effort; don't disrupt normal operation
  }
}

function appendLog(level, source, message) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    source,
    message: String(message),
  };
  logRing.push(entry);
  while (logRing.length > LOG_RING_LIMIT) logRing.shift();

  const line = `${entry.ts} [${level.toUpperCase()}] [${source}] ${entry.message}\n`;
  const consoleFn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  consoleFn(line.trimEnd());

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(wrapperLogPath, line);
    trimWrapperLogIfLarge();
  } catch {
    // best-effort file write
  }

  for (const subscriber of logSubscribers) {
    try {
      subscriber.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      logSubscribers.delete(subscriber);
    }
  }
}

const serverLog = {
  info: (source, message) => appendLog("info", source, message),
  warn: (source, message) => appendLog("warn", source, message),
  error: (source, message) => appendLog("error", source, message),
  recent: (limit = LOG_RING_LIMIT) =>
    logRing.slice(Math.max(0, logRing.length - limit)),
  subscribe: (res) => {
    logSubscribers.add(res);
    return () => logSubscribers.delete(res);
  },
};

function stripAnsi(value) {
  return String(value)
    .replace(/\x1b\]8;;.*?\x1b\\|\x1b\]8;;\x1b\\/g, "")
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, "");
}

function isTransientProgressLine(line) {
  return /^[\s◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏.-]*(Requesting device code|Waiting for device authorization|Exchanging device code)/.test(
    line,
  );
}

function cleanPtyOutput(value) {
  const cleaned = stripAnsi(value)
    .split(/\r|\n/)
    .filter((line) => line && !isTransientProgressLine(line))
    .join("\n");
  return cleaned ? `${cleaned}\n` : "";
}

function resolveDeviceBootstrapSdkPath() {
  const entryPath = path.resolve(OPENCLAW_ENTRY);
  try {
    return createRequire(entryPath).resolve(
      "openclaw/plugin-sdk/device-bootstrap",
    );
  } catch {
    return path.join(
      path.dirname(path.dirname(entryPath)),
      "dist",
      "plugin-sdk",
      "device-bootstrap.js",
    );
  }
}
async function runSdkOperation(request) {
  if (bootFailure)
    throw new Error("Run Doctor to recover this deployment before accessing OpenClaw state");
  const result = await runCommand(
    OPENCLAW_NODE,
    [path.join(process.cwd(), "src", "sdk-worker.js")],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        WRAPPER_SDK_REQUEST: JSON.stringify(request),
      },
      timeoutMs: 60_000,
      signal: activeMutation?.controller.signal,
    },
  );
  const encoded = result.output.match(
    /WRAPPER_SDK_RESULT:([A-Za-z0-9+/=]+)/,
  )?.[1];
  if (!encoded)
    throw new Error(
      `OpenClaw state operation did not complete (exit ${result.code})`,
    );
  const message = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (result.code !== 0 || message.error)
    throw new Error(message.error || "OpenClaw state operation failed");
  return message.result;
}
async function loadDeviceBootstrapSdk() {
  const sdkPath = resolveDeviceBootstrapSdkPath();
  return {
    listDevicePairing: () =>
      runSdkOperation({ action: "devices-list", sdkPath }),
    approveDevicePairing: (requestId) =>
      runSdkOperation({ action: "devices-approve", sdkPath, requestId }),
  };
}

function devicePairingTimestamp(request) {
  const ts = request?.ts;
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function newestPendingDevicePairing(pending) {
  if (!Array.isArray(pending) || pending.length === 0) return null;
  return pending.reduce((latest, current) =>
    devicePairingTimestamp(current) > devicePairingTimestamp(latest)
      ? current
      : latest,
  );
}

function describeDeviceApprovalForbidden(result) {
  const scope = result?.scope || "unknown";
  const role = result?.role || "unknown";
  switch (result?.reason) {
    case "caller-scopes-required":
    case "caller-missing-scope":
      return `missing scope: ${scope}`;
    case "scope-outside-requested-roles":
      return `invalid scope for requested roles: ${scope}`;
    case "bootstrap-role-not-allowed":
      return `bootstrap profile does not allow role: ${role}`;
    case "bootstrap-scope-not-allowed":
      return `bootstrap profile does not allow scope: ${scope}`;
    default:
      return "Device approval is forbidden by bootstrap policy.";
  }
}

// Stage and rollback dirs MUST live outside STATE_DIR / WORKSPACE_DIR.
// Otherwise the apply step tries to rename STATE_DIR into its own subdirectory (EINVAL).
const WRAPPER_VOLUME_ROOT = path.dirname(STATE_DIR);
const IMPORT_STAGING_ROOT = path.join(
  WRAPPER_VOLUME_ROOT,
  ".wrapper-import-staging",
);
const IMPORT_ROLLBACK_DIR = path.join(
  WRAPPER_VOLUME_ROOT,
  ".wrapper-import-rollback",
);
const IMPORT_STAGE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function importStagingPath(stagingId) {
  // stagingId is a hex string we generate; never trust caller-supplied values into a path otherwise
  if (!/^[a-f0-9]{16,64}$/.test(String(stagingId || ""))) return null;
  return path.join(IMPORT_STAGING_ROOT, stagingId);
}

function cleanupStaleImportStages() {
  // Best-effort: remove leftover staging dirs from older builds that put them inside STATE_DIR
  // (those caused EINVAL on rename and never got cleaned up).
  for (const legacyName of [".import-staging", ".import-rollback"]) {
    try {
      const legacyPath = path.join(STATE_DIR, legacyName);
      if (fs.existsSync(legacyPath)) {
        fs.rmSync(legacyPath, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }
  try {
    if (!fs.existsSync(IMPORT_STAGING_ROOT)) return;
    const now = Date.now();
    for (const entry of fs.readdirSync(IMPORT_STAGING_ROOT)) {
      const full = path.join(IMPORT_STAGING_ROOT, entry);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > IMPORT_STAGE_TTL_MS) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {
        /* ignore individual entry errors */
      }
    }
  } catch {
    /* best-effort */
  }
}

function detectZipPasswordError(stderr, code) {
  const text = String(stderr || "").toLowerCase();
  if (
    text.includes("incorrect password") ||
    text.includes("password incorrect") ||
    text.includes("password required") ||
    text.includes("encrypted") ||
    text.includes("password needed") ||
    text.includes("skipped (incorrect password)")
  ) {
    return true;
  }
  // unzip(1) historically returns 82 for a password error on extract.
  return code === 82;
}

async function probeZipNeedsPassword(zipFile, password) {
  // unzip validation does not write files. All disk extraction is separately bounded.
  const result = await runCmd("unzip", ["-t", "-P", password ?? "", zipFile], {
    secrets: [password],
    timeoutMs: 120_000,
  });
  if (result.code === 0) return { ok: true };
  return {
    ok: false,
    needsPassword: detectZipPasswordError(result.output, result.code),
    output: result.output,
  };
}

async function extractZipTo(zipFile, password, destDir) {
  const result = await runCmd(
    "python3",
    [path.join(process.cwd(), "src", "extract-zip.py"), zipFile, destDir],
    {
      env: { WRAPPER_ARCHIVE_PASSWORD: password ?? "" },
      timeoutMs: 120_000,
    },
  );
  return { ok: result.code === 0, output: result.output };
}

function applyDeploymentFixesToStaged(
  stagedStateDir,
  destinationWorkspaceDir = WORKSPACE_DIR,
  destinationStateDir = STATE_DIR,
) {
  // Files we never want to inherit from the source deployment:
  const dropPaths = [
    "gateway.token", // wrapper-managed, must be the destination's token
    "identity", // CLI keypair tied to source's pairing scope
    "devices", // legacy paired browsers from another deployment
    "nodes", // legacy node pairing state
    "device-auth.json", // legacy CLI device credential
    "credentials/device-auth.json",
    "tui", // stale TUI session state
    "plugin-skills", // generated plugin skill symlink index
    "tasks", // stale runtime task state
    "wrapper.log", // logs from the source wrapper
    ".wrapper-setup-incomplete",
    ".import-staging", // legacy: old wrapper builds put staging inside STATE_DIR
    ".import-rollback", // legacy: same as above
    ".wrapper-import-staging",
    ".wrapper-import-rollback",
  ];
  for (const rel of dropPaths) {
    const full = path.join(stagedStateDir, rel);
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  // Patch openclaw.json so gateway settings match THIS deployment.
  const cfgPath = path.join(stagedStateDir, "openclaw.json");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(
      "Staged openclaw.json missing — cannot apply deployment fixes.",
    );
  }
  let cfg;
  try {
    cfg = migrateWrapperConfig(JSON5.parse(fs.readFileSync(cfgPath, "utf8")), {
      sourceStateSchema: readSourceStateSchema(stagedStateDir),
    });
  } catch (err) {
    throw new Error(`Staged openclaw.json is not valid JSON: ${err.message}`);
  }
  cfg.gateway = cfg.gateway || {};
  cfg.gateway.auth = cfg.gateway.auth || {};
  cfg.gateway.auth.mode = "token";
  cfg.gateway.auth.token = OPENCLAW_GATEWAY_TOKEN;
  cfg.gateway.bind = "loopback";
  cfg.gateway.port = INTERNAL_GATEWAY_PORT;
  cfg.gateway.trustedProxies = ["127.0.0.1", "::1"];
  cfg.gateway.controlUi = cfg.gateway.controlUi || {};
  delete cfg.gateway.controlUi.allowInsecureAuth;
  delete cfg.gateway.controlUi.dangerouslyDisableDeviceAuth;
  // Rewrite allowedOrigins to THIS deployment's public URL so the imported
  // config points at the right host. Falls back to deletion if RAILWAY_PUBLIC_DOMAIN
  // is missing (in which case syncAllowedOrigins runs at gateway start as a fallback).
  const publicDomain = (process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  if (publicDomain) {
    cfg.gateway.controlUi.allowedOrigins = [`https://${publicDomain}`];
    cfg.gateway.publicOrigin = `https://${publicDomain}`;
    serverLog.info(
      "import",
      `set allowedOrigins to [https://${publicDomain}] for imported config`,
    );
  } else {
    delete cfg.gateway.controlUi.allowedOrigins;
    delete cfg.gateway.publicOrigin;
    serverLog.warn(
      "import",
      "RAILWAY_PUBLIC_DOMAIN not set — allowedOrigins removed; gateway may reject browser connects",
    );
  }
  cfg.agents ||= {};
  cfg.agents.defaults ||= {};
  cfg = relocateImportedConfig(cfg, {
    stateDir: destinationStateDir,
    workspaceDir: destinationWorkspaceDir,
  });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath()) && !fs.existsSync(INCOMPLETE_SETUP_PATH);
  } catch {
    return false;
  }
}

function installedVersion() {
  return JSON.parse(
    fs.readFileSync(path.join(OPENCLAW_ROOT, "package.json"), "utf8"),
  ).version;
}
function readCurrentConfig() {
  return fs.existsSync(configPath())
    ? JSON5.parse(fs.readFileSync(configPath(), "utf8"))
    : {};
}
async function ensurePlugins(payload = {}, signal) {
  return ensureRequiredPlugins({
    config: readCurrentConfig(),
    payload,
    openclawRoot: OPENCLAW_ROOT,
    stateDir: STATE_DIR,
    version: installedVersion(),
    runCli: (args) =>
      runCmd(OPENCLAW_NODE, clawArgs(args), { timeoutMs: 300_000, signal }),
    log: (line) => serverLog.info("plugins", line.trim()),
  });
}
async function syncAllowedOrigins(signal, { installPlugins = true } = {}) {
  // The intermediate Doctor may replace both version metadata and legacy
  // layout. Retain the original source when preserving pre-upgrade defaults.
  const sourceConfig = readCurrentConfig();
  const sourceStateSchema = readSourceStateSchema(STATE_DIR);
  await migrateRetiredPluginIndex({
    stateDir: STATE_DIR,
    toolsDir: path.join(WRAPPER_VOLUME_ROOT, ".wrapper-migration-tools"),
    node: OPENCLAW_NODE,
    run: (cmd, args, options = {}) => runCmd(cmd, args, { ...options, signal }),
    log: (message) => serverLog.info("upgrade", message),
  });
  const current = readCurrentConfig();
  const patched = migrateWrapperConfig(current, {
    publicDomain: process.env.RAILWAY_PUBLIC_DOMAIN?.trim(),
    localPort: PORT,
    sourceConfig,
    sourceStateSchema,
  });
  if (JSON.stringify(patched) !== JSON.stringify(current)) {
    const filename = configPath();
    const temporary = `${filename}.wrapper-${crypto.randomBytes(6).toString("hex")}`;
    if (!fs.existsSync(`${filename}.before-wrapper-upgrade.bak`))
      fs.copyFileSync(filename, `${filename}.before-wrapper-upgrade.bak`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(patched, null, 2), {
        mode: 0o600,
      });
      fs.renameSync(temporary, filename);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  // Plugin CLI commands admit only current configuration. Let Doctor migrate
  // legacy core/channel fields first, then reconcile plugins during startup.
  if (installPlugins) await ensurePlugins({}, signal);
}

let shuttingDown = false;
let bootFailure = recoveredBootFailure;
let activeMutation = null;
let upgradeCanary = false;
const gatewayEnv = { ...process.env };
const canaryFlags = ["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS", "OPENCLAW_SKIP_CRON", "OPENCLAW_SKIP_GMAIL_WATCHER", "OPENCLAW_SKIP_CANVAS_HOST", "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "OPENCLAW_SKIP_STARTUP_MODEL_PREWARM", "OPENCLAW_NO_AUTO_UPDATE"];
function setUpgradeCanary(enabled) {
  upgradeCanary = enabled;
  for (const key of canaryFlags) {
    if (enabled) gatewayEnv[key] = "1";
    else if (process.env[key] === undefined) delete gatewayEnv[key];
    else gatewayEnv[key] = process.env[key];
  }
}
const gateway = createGatewayManager({
  entry: OPENCLAW_ENTRY,
  node: OPENCLAW_NODE,
  stateDir: STATE_DIR,
  workspaceDir: WORKSPACE_DIR,
  token: OPENCLAW_GATEWAY_TOKEN,
  host: INTERNAL_GATEWAY_HOST,
  port: INTERNAL_GATEWAY_PORT,
  isConfigured,
  env: gatewayEnv,
  getExtraGatewayArgs: () => upgradeCanary ? ["--update-canary"] : [],
  beforeStart: async ({ signal } = {}) => {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    await syncAllowedOrigins(signal);
  },
  log: serverLog,
  startupTimeoutMs: 180_000,
  preflightTimeoutMs: 300_000,
});
const ensureGatewayRunning = () =>
  bootFailure
    ? Promise.reject(new Error(bootFailure))
    : gateway.ensureRunning();
const isGatewayStarting = () => gateway.isStarting();
const isGatewayReady = () => gateway.isReady();

function exclusiveMutation(handler) {
  return async (req, res) => {
    if (activeMutation || shuttingDown)
      return res.status(409).json({
        ok: false,
        error:
          "Another maintenance operation is running. Try again when it finishes.",
      });
    let finish;
    const owner = {
      name: req.path,
      controller: new AbortController(),
      secrets: [],
      done: new Promise((resolve) => {
        finish = resolve;
      }),
    };
    activeMutation = owner;
    req.operationSignal = owner.controller.signal;
    const onClose = () => {
      if (!res.writableEnded) owner.controller.abort();
    };
    res.once("close", onClose);
    try {
      return await handler(req, res);
    } finally {
      res.off("close", onClose);
      if (activeMutation === owner) activeMutation = null;
      finish();
    }
  };
}

const setupRateLimiter = {
  attempts: new Map(),
  windowMs: 60_000,
  maxAttempts: 50,
  cleanupInterval: setInterval(function () {
    const now = Date.now();
    for (const [ip, data] of setupRateLimiter.attempts) {
      if (now - data.windowStart > setupRateLimiter.windowMs) {
        setupRateLimiter.attempts.delete(ip);
      }
    }
  }, 60_000),

  isRateLimited(ip) {
    const now = Date.now();
    const data = this.attempts.get(ip);
    if (!data || now - data.windowStart > this.windowMs) {
      this.attempts.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    data.count++;
    return data.count > this.maxAttempts;
  },
};

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (setupRateLimiter.isRateLimited(ip)) {
    return res
      .status(429)
      .type("text/plain")
      .send("Too many requests. Try again later.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  if (!verifySetupCredentials(req)) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use("/setup", express.json({ limit: "1mb" }));
const recoverySafeApiPaths = new Set([
  "/status", "/debug", "/logs", "/logs/stream", "/doctor",
  "/import/probe", "/import/apply", "/reset", "/wipe",
]);
app.use("/setup/api", (req, res, next) => {
  const route = req.path.toLowerCase().replace(/\/+$/, "") || "/";
  if (!bootFailure || recoverySafeApiPaths.has(route)) return next();
  // Even nominal reads can open/migrate SQLite through the newer CLI/SDK.
  // Keep restored old state offline until an explicit recovery transaction.
  return requireSetupAuth(req, res, () =>
    res.status(503).json({
      ok: false,
      error: "Upgrade recovery is required. Use Run Doctor before accessing OpenClaw state.",
    }),
  );
});

app.get("/healthz", async (_req, res) => {
  const configured = isConfigured();
  const reachable =
    configured && !activeMutation ? await gateway.probe() : false;
  res.json({
    ok: true,
    gateway: !configured ? "unconfigured" : reachable ? "ready" : "starting",
  });
});

app.get("/setup/healthz", async (_req, res) => {
  const configured = isConfigured();
  const reachable =
    configured && !activeMutation ? await gateway.probe() : false;
  res
    .status(configured && (!reachable || activeMutation || bootFailure) ? 503 : 200)
    .json({
      ok: true,
      wrapper: true,
      configured,
      gatewayRunning: reachable,
      gatewayStarting: isGatewayStarting(),
      gatewayReachable: reachable,
    });
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});

app.get("/logs", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "logs.html"));
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const { version, channelsHelp } = await getOpenclawInfo();

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version,
    channelsAddHelp: channelsHelp,
    authGroups: AUTH_GROUPS_PUBLIC,
    tuiEnabled: ENABLE_WEB_TUI,
    gatewayToken: OPENCLAW_GATEWAY_TOKEN,
    // Version compatibility floor: entrypoint.sh bumps an older requested
    // OPENCLAW_VERSION up to OPENCLAW_MINIMUM_VERSION before install and records
    // the original request here so the wizard can explain the bump.
    versionInfo: {
      requested: process.env.OPENCLAW_REQUESTED_VERSION || null,
      effective:
        process.env.OPENCLAW_EFFECTIVE_VERSION ||
        process.env.OPENCLAW_VERSION ||
        null,
      minimum: process.env.OPENCLAW_MINIMUM_VERSION || null,
      bumped: process.env.OPENCLAW_VERSION_BUMPED === "true",
    },
  });
});

function buildOnboardArgs(payload) {
  return makeOnboardArgs(payload, {
    workspaceDir: WORKSPACE_DIR,
    gatewayPort: INTERNAL_GATEWAY_PORT,
    gatewayToken: OPENCLAW_GATEWAY_TOKEN,
  });
}

function runCmd(cmd, args, opts = {}) {
  return runCommand(cmd, args, {
    ...opts,
    transform: opts.stripOutput ? stripAnsi : (s) => s,
    secrets: [
      OPENCLAW_GATEWAY_TOKEN,
      SETUP_PASSWORD,
      ...(activeMutation?.secrets || []),
      ...(opts.secrets || []),
    ],
    signal: opts.signal ?? activeMutation?.controller.signal,
    env: {
      ...process.env,
      ...opts.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });
}

function runPtyCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let proc,
      timer,
      killTimer,
      reason,
      finished = false,
      raw = "",
      output = "";
    const sent = new Set();
    const filter = createOutputFilter(
      [OPENCLAW_GATEWAY_TOKEN, SETUP_PASSWORD, ...(opts.secrets || [])],
      (chunk) => {
        output = (output + chunk).slice(-4 * 1024 * 1024);
        opts.onOutput?.(chunk);
      },
    );
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", abort);
      if (reason) filter.write(`\n[${reason}] onboarding did not complete\n`);
      filter.end();
      resolve({
        code: reason === "timeout" ? 124 : reason ? 130 : code,
        output,
      });
    };
    const stop = (why) => {
      if (finished || reason) return;
      reason = why;
      try {
        proc?.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        try {
          proc?.kill("SIGKILL");
        } catch {}
      }, 2000);
    };
    const abort = () => stop("aborted");
    if (opts.signal?.aborted) {
      reason = "aborted";
      finish(130);
      return;
    }
    try {
      proc = pty.spawn(cmd, args, {
        name: "xterm-color",
        cols: 100,
        rows: 30,
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          DISPLAY: ":0",
          WAYLAND_DISPLAY: "wayland-0",
          SSH_CLIENT: "",
          SSH_TTY: "",
          SSH_CONNECTION: "",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
      });
    } catch (err) {
      filter.write(`\n[spawn error] ${err.message}\n`);
      finish(127);
      return;
    }
    proc.onData((data) => {
      // Prompt matching uses unfiltered text; spinner filtering is display-only.
      raw = (raw + stripAnsi(data)).slice(-64 * 1024);
      for (const { pattern, input } of opts.autoInputs || []) {
        if (!sent.has(String(pattern)) && pattern.test(raw)) {
          sent.add(String(pattern));
          proc.write(input);
        }
      }
      filter.write(opts.cleanOutput ? cleanPtyOutput(data) : stripAnsi(data));
    });
    proc.onExit(({ exitCode, signal }) =>
      finish(exitCode ?? (signal ? 128 : 1)),
    );
    timer = setTimeout(() => stop("timeout"), opts.timeoutMs ?? 15 * 60_000);
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
  });
}

app.post(
  "/setup/api/run",
  requireSetupAuth,
  exclusiveMutation(async (req, res) => {
    const stream = (chunk) => {
      if (chunk) res.write(chunk);
    };

    try {
      if (isConfigured()) {
        await ensureGatewayRunning();
        return res
          .type("text/plain")
          .send(
            "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
          );
      }

      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

      const payload = req.body || {};
      const validationError = validatePayload(payload);
      if (validationError) {
        return res.status(400).type("text/plain").send(`${validationError}\n`);
      }

      res.set({
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });

      fs.writeFileSync(
        INCOMPLETE_SETUP_PATH,
        "Onboarding has not completed\n",
        { mode: 0o600 },
      );
      activeMutation.secrets = [
        payload.authSecret,
        payload.telegramToken,
        payload.discordToken,
        payload.slackBotToken,
        payload.slackAppToken,
      ];
      await ensurePlugins(payload, req.operationSignal);
      const onboardArgs = buildOnboardArgs(payload);
      const interactive = requiresInteractiveOnboarding(payload);
      stream(
        interactive
          ? "Starting provider device pairing. Use the URL and code below, then keep this page open until it completes.\n\n"
          : "Starting OpenClaw onboarding...\n\n",
      );

      const onboardRunner = interactive ? runPtyCmd : runCmd;
      const onboard = await onboardRunner(
        OPENCLAW_NODE,
        clawArgs(onboardArgs),
        {
          onOutput: stream,
          signal: req.operationSignal,
          secrets: [
            payload.authSecret,
            payload.telegramToken,
            payload.discordToken,
            payload.slackBotToken,
            payload.slackAppToken,
          ],
          cleanOutput: interactive,
          stripOutput: !interactive,
          autoInputs: interactive
            ? [{ pattern: /Enable hooks\?/, input: " \r" }]
            : [],
        },
      );

      stream(
        `\n[setup] Onboarding exit=${onboard.code} configured=${isConfigured()}\n`,
      );

      const ok = onboard.code === 0 && fs.existsSync(configPath());

      if (ok) {
        const persistence = await runSdkOperation({
          action: "verify-provider",
          options: {
            payload: {
              authChoice: payload.authChoice,
              authSecret: payload.authSecret ? "provided" : "",
              customBaseUrl: payload.customBaseUrl,
              customModelId: payload.customModelId,
            },
            openclawRoot: OPENCLAW_ROOT,
            stateDir: STATE_DIR,
            configPath: configPath(),
          },
        });
        if (!persistence.ok) throw new Error(persistence.error);
        stream("\n[setup] Configuring gateway settings...\n");

        const tokenResult = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "gateway.auth.token",
            OPENCLAW_GATEWAY_TOKEN,
          ]),
        );
        if (tokenResult.code !== 0)
          throw new Error("Could not configure gateway authentication");
        stream(`[config] gateway.auth.token exit=${tokenResult.code}\n`);

        const proxiesResult = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--strict-json",
            "gateway.trustedProxies",
            '["127.0.0.1", "::1"]',
          ]),
        );
        if (proxiesResult.code !== 0)
          throw new Error("Could not configure gateway proxy policy");
        stream(`[config] gateway.trustedProxies exit=${proxiesResult.code}\n`);

        if (payload.model?.trim()) {
          stream(`[setup] Setting model to ${payload.model.trim()}...\n`);
          const modelResult = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["models", "set", payload.model.trim()]),
            { onOutput: stream, stripOutput: true },
          );
          if (modelResult.code !== 0)
            throw new Error("Could not set the requested model");
          stream(`[models set] exit=${modelResult.code}\n`);
        }

        async function configureChannel(name, cfgObj) {
          const set = await runCmd(
            OPENCLAW_NODE,
            clawArgs([
              "config",
              "set",
              "--json",
              `channels.${name}`,
              JSON.stringify(cfgObj),
            ]),
          );
          if (set.code !== 0)
            throw new Error(
              `Could not configure ${name}. Review the server diagnostics.`,
            );
          stream(`\n[${name} config] saved successfully\n`);
        }

        if (payload.telegramToken?.trim()) {
          await configureChannel("telegram", {
            enabled: true,
            botToken: payload.telegramToken.trim(),
            streaming: { mode: "partial" },
          });
        }

        if (payload.discordToken?.trim()) {
          await configureChannel("discord", {
            enabled: true,
            token: payload.discordToken.trim(),
            groupPolicy: "allowlist",
            dmPolicy: "pairing",
          });
        }

        if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
          await configureChannel("slack", {
            enabled: true,
            botToken: payload.slackBotToken?.trim() || undefined,
            appToken: payload.slackAppToken?.trim() || undefined,
          });
        }

        // Start the gateway in the background. First boot can take ~30-60s
        // (plugin load + SQLite migrations); don't block the wizard's "Complete"
        // on full readiness — the loading screen + /healthz polling cover the gap.
        const validated = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "validate"]),
          { signal: req.operationSignal },
        );
        if (validated.code !== 0)
          throw new Error(
            "OpenClaw rejected the completed configuration. Run Doctor or reset setup before retrying.",
          );
        fs.rmSync(INCOMPLETE_SETUP_PATH, { force: true });
        bootFailure = null;
        stream(
          "\n[setup] Starting gateway in the background (first boot can take up to a minute)...\n",
        );
        ensureGatewayRunning().then(() => upgradeRecovery.adopt()).catch((err) => {
          serverLog.error(
            "setup",
            `gateway start after setup failed: ${err.message}`,
          );
        });
      }

      stream(
        ok
          ? "\n[setup] Complete. The gateway is finishing startup — open the OpenClaw UI (it may show a brief loading screen).\n"
          : "\n[setup] Failed. Review the output above.\n",
      );
      return res.end();
    } catch (err) {
      console.error("[/setup/api/run] error:", err);
      if (!res.headersSent) {
        return res
          .status(500)
          .type("text/plain")
          .send(`Internal error: ${String(err)}\n`);
      }
      stream(`\n[setup] Internal error: ${String(err)}\n`);
      return res.end();
    }
  }),
);

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  if (activeMutation)
    return res
      .status(409)
      .json({ ok: false, error: "Maintenance is in progress" });
  const v = bootFailure
    ? { output: installedVersion() }
    : await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = bootFailure
    ? { output: "" }
    : await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.post(
  "/setup/api/pairing/approve",
  requireSetupAuth,
  exclusiveMutation(async (req, res) => {
    const { channel, code } = req.body || {};
    if (!channel || !code) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing channel or code" });
    }
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["pairing", "approve", String(channel), String(code)]),
    );
    return res
      .status(r.code === 0 ? 200 : 500)
      .json({ ok: r.code === 0, output: r.output });
  }),
);

app.post(
  "/setup/api/reset",
  requireSetupAuth,
  exclusiveMutation(async (_req, res) => {
    try {
      await closeTuiSession();
      await gateway.stop();
      upgradeRecovery.forget({ successOnly: true });
      fs.rmSync(configPath(), { force: true });
      fs.rmSync(INCOMPLETE_SETUP_PATH, { force: true });
      bootFailure = null;
      res
        .type("text/plain")
        .send("OK - deleted config file. You can rerun setup now.");
    } catch (err) {
      res.status(500).type("text/plain").send(String(err));
    }
  }),
);

app.post(
  "/setup/api/wipe",
  requireSetupAuth,
  exclusiveMutation(async (req, res) => {
    const provided = String(req.body?.password ?? "");
    const expected = SETUP_PASSWORD ?? "";
    const providedBuf = Buffer.from(provided, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    const passwordOk =
      expected.length > 0 &&
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf);

    if (!passwordOk) {
      return res.status(401).json({
        ok: false,
        error: "Setup password did not match. Wipe aborted.",
      });
    }

    try {
      serverLog.warn(
        "wrapper",
        "wipe requested — stopping gateway and clearing all data",
      );
      await closeTuiSession();
      await gateway.stop();
      upgradeRecovery.forget();
      const wipeDirContents = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir)) {
          fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        }
      };
      wipeDirContents(STATE_DIR);
      wipeDirContents(WORKSPACE_DIR);
      for (const entry of fs.readdirSync(WRAPPER_VOLUME_ROOT)) {
        if (
          /^\.wrapper-(?:upgrade-snapshots$|upgrade-recovery$|upgrade-failed-|upgrade-restore-|import-staging$|import-rollback(?:\.|$))/.test(
            entry,
          )
        )
          fs.rmSync(path.join(WRAPPER_VOLUME_ROOT, entry), {
            recursive: true,
            force: true,
          });
      }
      bootFailure = null;
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

      cachedOpenclawVersion = null;
      cachedChannelsHelp = null;
      fs.writeFileSync(
        path.join(STATE_DIR, "gateway.token"),
        OPENCLAW_GATEWAY_TOKEN,
        { mode: 0o600 },
      );

      serverLog.warn("wrapper", "wipe complete — all data cleared");
      return res.json({
        ok: true,
        output: "All data cleared. Reload the page to start fresh.",
      });
    } catch (err) {
      serverLog.error("wrapper", `wipe failed: ${err?.message || String(err)}`);
      return res.status(500).json({
        ok: false,
        error: `Wipe failed: ${err?.message || String(err)}`,
      });
    }
  }),
);

const IMPORT_BODY_LIMIT = process.env.IMPORT_MAX_BYTES || "500mb";

app.post(
  "/setup/api/import/probe",
  requireSetupAuth,
  express.raw({
    type: ["application/zip", "application/octet-stream"],
    limit: IMPORT_BODY_LIMIT,
  }),
  exclusiveMutation(async (req, res) => {
    if (!req.body || !req.body.length) {
      return res
        .status(400)
        .json({ ok: false, error: "No file received in request body." });
    }
    cleanupStaleImportStages();
    const stagingId = crypto.randomBytes(16).toString("hex");
    const stageDir = importStagingPath(stagingId);
    const zipFile = path.join(IMPORT_STAGING_ROOT, `${stagingId}.zip`);
    const zipPassword =
      typeof req.headers["x-archive-password"] === "string"
        ? Buffer.from(req.headers["x-archive-password"], "base64").toString(
            "utf8",
          )
        : typeof req.query?.password === "string"
          ? req.query.password
          : "";

    try {
      fs.mkdirSync(IMPORT_STAGING_ROOT, { recursive: true });
      fs.writeFileSync(zipFile, req.body);

      const inventory = inspectZipArchive(req.body);
      requireFreeSpace(IMPORT_STAGING_ROOT, inventory.uncompressedBytes);
      const probe = await probeZipNeedsPassword(zipFile, zipPassword);
      if (!probe.ok) {
        if (probe.needsPassword) {
          // The UI resubmits the upload with its password. Do not retain an unused encrypted ZIP.
          fs.rmSync(zipFile, { force: true });
          return res.status(401).json({
            ok: false,
            needsPassword: true,
            stagingId,
            error:
              "This archive is password-protected. Enter the export password to continue.",
          });
        }
        // Bad zip: clean up immediately.
        try {
          fs.rmSync(zipFile, { force: true });
        } catch {
          /* */
        }
        return res.status(400).json({
          ok: false,
          error:
            "Could not read this archive. Make sure it's a valid OpenClaw export ZIP.",
          output: probe.output?.slice(-2000),
        });
      }

      const extract = await extractZipTo(zipFile, zipPassword, stageDir);
      if (!extract.ok) {
        try {
          fs.rmSync(stageDir, { recursive: true, force: true });
        } catch {
          /* */
        }
        try {
          fs.rmSync(zipFile, { force: true });
        } catch {
          /* */
        }
        return res.status(400).json({
          ok: false,
          error: "Failed to extract archive contents.",
          output: extract.output?.slice(-2000),
        });
      }

      assertSafeStagedTree(stageDir);
      const layout = findStagedDataRoot(stageDir);
      if (!layout.ok) {
        try {
          fs.rmSync(stageDir, { recursive: true, force: true });
        } catch {
          /* */
        }
        try {
          fs.rmSync(zipFile, { force: true });
        } catch {
          /* */
        }
        return res.status(400).json({
          ok: false,
          error:
            "Archive does not match the expected layout (data/.openclaw/openclaw.json). Imports only work with exports from this template.",
        });
      }

      const manifest = summarizeStagedImport(
        layout.stateDir,
        layout.workspaceDir,
      );

      // Persist the resolved layout next to the staged data so /apply can find it without re-scanning.
      fs.writeFileSync(
        path.join(stageDir, ".staging-meta.json"),
        JSON.stringify(
          {
            stagingId,
            zipFile,
            stateDir: layout.stateDir,
            workspaceDir: layout.workspaceDir,
            manifest,
          },
          null,
          2,
        ),
      );

      // The zip can be removed now — extracted data is what we'll apply.
      try {
        fs.rmSync(zipFile, { force: true });
      } catch {
        /* */
      }

      serverLog.info(
        "import",
        `staged ${stagingId} sessions=${manifest.sessionCount} workspace=${manifest.hasWorkspace}`,
      );
      return res.json({ ok: true, stagingId, manifest });
    } catch (err) {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch {
        /* */
      }
      try {
        fs.rmSync(zipFile, { force: true });
      } catch {
        /* */
      }
      serverLog.error("import", `probe failed: ${err.message || String(err)}`);
      return res.status(500).json({
        ok: false,
        error: `Probe failed: ${err.message || String(err)}`,
      });
    }
  }),
);

app.post(
  "/setup/api/import/apply",
  requireSetupAuth,
  exclusiveMutation(async (req, res) => {
    const stagingId = String(req.body?.stagingId || "");
    const provided = Buffer.from(String(req.body?.setupPassword || ""));
    const expected = Buffer.from(SETUP_PASSWORD || "");
    if (
      !expected.length ||
      provided.length !== expected.length ||
      !crypto.timingSafeEqual(provided, expected)
    ) {
      return res.status(401).json({
        ok: false,
        error:
          "Setup password did not match. Import aborted (no data was changed).",
      });
    }
    if (
      path.resolve(configPath()) !== path.resolve(STATE_DIR, "openclaw.json")
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Custom configuration paths require the OpenClaw backup CLI for restoration.",
      });
    }
    const stageDir = importStagingPath(stagingId);
    if (!stageDir || !fs.existsSync(stageDir))
      return res.status(404).json({
        ok: false,
        error: "Staged import not found or expired. Re-upload the archive.",
      });
    let transaction;
    let stopped = false;
    const previousBootFailure = bootFailure;
    try {
      const layout = readStagedLayout(stageDir);
      requireFreeSpace(
        stageDir,
        summarizeStagedImport(layout.stateDir, layout.workspaceDir)
          .importedSize,
      );
      const stagedWorkspaceDir =
        layout.workspaceDir || path.join(layout.stateDir, "workspace");
      await closeTuiSession();
      await gateway.stop();
      stopped = true;
      applyDeploymentFixesToStaged(
        layout.stateDir,
        stagedWorkspaceDir,
        layout.stateDir,
      );
      validateStagedMigrationInputs(layout.stateDir, {
        stagingRoot: stageDir,
        workspaceDir: stagedWorkspaceDir,
      });
      const stagedConfig = JSON5.parse(
        fs.readFileSync(path.join(layout.stateDir, "openclaw.json"), "utf8"),
      );
      const runStaged = (args) =>
        runCommand(OPENCLAW_NODE, clawArgs(args), {
          cwd: stageDir,
          env: {
            PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
            HOME: stageDir,
            TMPDIR: stageDir,
            OPENCLAW_HOME: stageDir,
            OPENCLAW_OAUTH_DIR: path.join(layout.stateDir, "credentials"),
            OPENCLAW_GATEWAY_TOKEN,
            OPENCLAW_SUPERVISOR_MODE: "external",
            OPENCLAW_STATE_DIR: layout.stateDir,
            OPENCLAW_WORKSPACE_DIR: stagedWorkspaceDir,
            OPENCLAW_CONFIG_PATH: path.join(layout.stateDir, "openclaw.json"),
          },
          timeoutMs: 300_000,
          signal: req.operationSignal,
          secrets: [OPENCLAW_GATEWAY_TOKEN, SETUP_PASSWORD],
        });
      await ensureRequiredPlugins({
        config: stagedConfig,
        openclawRoot: OPENCLAW_ROOT,
        stateDir: layout.stateDir,
        version: installedVersion(),
        runCli: runStaged,
        allowOperatorPaths: false,
      });
      const repair = await runStaged([
        "doctor",
        "--non-interactive",
        "--repair",
      ]);
      if (repair.code !== 0)
        throw new Error(
          "Imported state could not be migrated safely. Existing data was retained.",
        );
      // Only verified official installers/Doctor ran after the first preflight.
      // Rebuild their executable payload and generated links at the destination.
      for (const generated of ["plugin-skills", "extensions", "npm/projects"])
        fs.rmSync(path.join(layout.stateDir, generated), {
          recursive: true,
          force: true,
        });
      validateStagedMigrationInputs(layout.stateDir, { stagingRoot: stageDir });
      sanitizeImportedTrust(layout.stateDir, {
        stagingRoot: stageDir,
        liveStateDir: STATE_DIR,
      });
      applyDeploymentFixesToStaged(layout.stateDir);
      requireFreeSpace(
        stageDir,
        summarizeStagedImport(layout.stateDir, stagedWorkspaceDir).importedSize,
      );
      transaction = createDirectoryTransaction({
        stateDir: STATE_DIR,
        workspaceDir: WORKSPACE_DIR,
        rollbackBase: `${IMPORT_ROLLBACK_DIR}.${crypto.randomBytes(8).toString("hex")}`,
      });
      transaction.replaceFrom({
        stateDir: layout.stateDir,
        workspaceDir: stagedWorkspaceDir,
      });
      bootFailure = null;
      fs.writeFileSync(
        path.join(STATE_DIR, "gateway.token"),
        OPENCLAW_GATEWAY_TOKEN,
        { mode: 0o600 },
      );
      cachedOpenclawVersion = null;
      cachedChannelsHelp = null;
      await ensureGatewayRunning();
      const committed = transaction.commit();
      upgradeRecovery.adopt();
      for (const error of committed?.cleanupErrors || [])
        serverLog.warn(
          "import",
          `rollback cleanup: ${error.path || ""} ${error.error?.message || error.message || String(error)}`,
        );
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch (error) {
        serverLog.warn(
          "import",
          `staging cleanup after successful import: ${error.message}`,
        );
      }
      return res.json({
        ok: true,
        output:
          "Import complete. Reload the page to use the imported configuration.",
      });
    } catch (err) {
      let restored = false;
      try {
        if (
          transaction &&
          ["replacing", "replaced"].includes(transaction.phase)
        ) {
          await gateway.stop();
          transaction.rollback();
          restored = true;
          bootFailure = previousBootFailure;
        }
        if (
          !transaction ||
          ["new", "rolled-back"].includes(transaction.phase)
        ) {
          try {
            fs.rmSync(stageDir, { recursive: true, force: true });
          } catch (cleanupError) {
            serverLog.warn(
              "import",
              `failed-stage cleanup: ${cleanupError.message}`,
            );
          }
        }
        if (stopped && isConfigured()) await ensureGatewayRunning();
      } catch (recoveryError) {
        serverLog.error("import", `recovery failed: ${recoveryError.message}`);
        return res.status(500).json({
          ok: false,
          error: `Import failed: ${err.message}. Recovery needs attention; rollback snapshots were retained.`,
        });
      }
      return res.status(500).json({
        ok: false,
        error: `Import failed: ${err.message}${restored ? " (existing data was restored)" : " (existing data was retained)"}`,
      });
    }
  }),
);

app.post(
  "/setup/api/doctor",
  requireSetupAuth,
  exclusiveMutation(async (req, res) => {
    await closeTuiSession();
    await gateway.stop();
    let attempt, committed = false;
    try {
      if (isConfigured()) {
        attempt = upgradeRecovery.begin({ force: true });
        bootFailure = null;
        await syncAllowedOrigins(req.operationSignal, { installPlugins: false });
      }
      const result = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--non-interactive", "--repair"]), { timeoutMs: 300_000 });
      if (result.code !== 0) throw new Error(`Doctor failed (exit ${result.code})`);
      if (isConfigured()) {
        setUpgradeCanary(true);
        await ensureGatewayRunning();
        if (attempt?.needed) upgradeRecovery.commit();
        committed = true;
        await gateway.stop();
        setUpgradeCanary(false);
        await ensureGatewayRunning();
      }
      bootFailure = null;
      return res.json({ ok: true, output: result.output });
    } catch (error) {
      try {
        await gateway.stop();
        setUpgradeCanary(false);
        if (attempt?.needed && !committed) upgradeRecovery.rollback();
      } catch (recoveryError) { serverLog.error("doctor", `Recovery needs attention: ${recoveryError.message}`); }
      const recoveryNote = attempt?.needed ? "Recovery snapshot was retained." : "No new recovery snapshot was captured.";
      bootFailure = `Doctor repair failed: ${error.message}. ${recoveryNote}`;
      return res.status(500).json({ ok: false, output: bootFailure });
    }
  }),
);

app.get(
  "/setup/api/devices",
  requireSetupAuth,
  exclusiveMutation(async (_req, res) => {
    try {
      const { listDevicePairing } = await loadDeviceBootstrapSdk();
      const data = await listDevicePairing();
      return res.json({ ok: true, data });
    } catch (err) {
      const message = err?.message || String(err);
      console.warn(`[devices] local list failed: ${message}`);
      return res.status(500).json({ ok: false, error: message });
    }
  }),
);

app.post(
  "/setup/api/devices/approve",
  requireSetupAuth,
  exclusiveMutation(async (req, res) => {
    const requestId = String(req.body?.requestId || "").trim();

    try {
      const { approveDevicePairing, listDevicePairing } =
        await loadDeviceBootstrapSdk();
      const pairings = await listDevicePairing();
      const pending = Array.isArray(pairings?.pending) ? pairings.pending : [];

      let targetRequestId = requestId;
      if (targetRequestId) {
        const exists = pending.some(
          (request) => request?.requestId === targetRequestId,
        );
        if (!exists) {
          return res.status(404).json({
            ok: false,
            error: `Unknown pending device pairing request: ${targetRequestId}`,
          });
        }
      } else {
        const latest = newestPendingDevicePairing(pending);
        targetRequestId = latest?.requestId || "";
        if (!targetRequestId) {
          return res.status(404).json({
            ok: false,
            error: "No pending device pairing requests.",
          });
        }
      }

      const result = await approveDevicePairing(targetRequestId, {
        // /setup is guarded by SETUP_PASSWORD and runs in the same state volume
        // as the gateway, so it acts as the trusted bootstrap admin surface.
        callerScopes: ["operator.admin"],
      });

      if (!result) {
        return res.status(404).json({
          ok: false,
          error: `Unknown pending device pairing request: ${targetRequestId}`,
        });
      }

      if (result.status === "forbidden") {
        return res.status(403).json({
          ok: false,
          error: describeDeviceApprovalForbidden(result),
          reason: result.reason,
        });
      }

      return res.json({
        ok: true,
        requestId: targetRequestId,
        device: result.device,
        output: `Approved device pairing request ${targetRequestId}.`,
      });
    } catch (err) {
      const message = err?.message || String(err);
      console.warn(`[devices] local approve failed: ${message}`);
      return res.status(500).json({ ok: false, error: message });
    }
  }),
);

app.post(
  "/setup/api/devices/reject",
  requireSetupAuth,
  exclusiveMutation(async (req, res) => {
    const { requestId } = req.body || {};
    if (!requestId) {
      return res.status(400).json({ ok: false, error: "Missing requestId" });
    }
    const args = [
      "devices",
      "reject",
      String(requestId),
      "--token",
      OPENCLAW_GATEWAY_TOKEN,
    ];
    const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
    return res
      .status(result.code === 0 ? 200 : 500)
      .json({ ok: result.code === 0, output: result.output });
  }),
);

app.get("/setup/api/logs", requireSetupAuth, (req, res) => {
  const limitParam = Number.parseInt(req.query?.limit ?? "", 10);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 200;
  res.json({ ok: true, entries: serverLog.recent(limit) });
});

app.get("/setup/api/logs/stream", requireSetupAuth, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  for (const entry of serverLog.recent(100)) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  const unsubscribe = serverLog.subscribe(res);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.get(
  "/setup/api/export",
  requireSetupAuth,
  exclusiveMutation(async (_req, res) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-export-"));
    const archive = path.join(scratch, "export.zip");
    const cleanup = () => fs.rmSync(scratch, { recursive: true, force: true });
    try {
      const snapshot = await createNormalizedSnapshot({
        scratchDir: scratch,
        runCli: (args) =>
          runCmd(OPENCLAW_NODE, clawArgs(args), { timeoutMs: 300_000 }),
      });
      const zip = await runCmd(
        "zip",
        ["-r", "-P", SETUP_PASSWORD, archive, "data"],
        {
          cwd: path.dirname(snapshot.dataRoot),
          timeoutMs: 300_000,
        },
      );
      if (zip.code !== 0)
        throw new Error("Could not create the protected export archive");
      inspectZipArchive(fs.readFileSync(archive));
      // Normalized exports retain the established data/.openclaw + data/workspace layout.
      return await new Promise((resolve) => {
        res.download(
          archive,
          `openclaw-export-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`,
          (error) => {
            cleanup();
            if (error && !res.headersSent && !res.destroyed)
              res
                .status(500)
                .json({ ok: false, error: "Export download failed" });
            resolve();
          },
        );
      });
    } catch (err) {
      cleanup();
      if (!res.headersSent)
        return res.status(500).json({ ok: false, error: err.message });
    }
  }),
);

app.get("/tui", requireSetupAuth, (_req, res) => {
  if (bootFailure)
    return res.status(503).type("text/plain").send("Run Doctor to recover this deployment before opening the terminal.");
  if (!ENABLE_WEB_TUI) {
    return res
      .status(403)
      .type("text/plain")
      .send("Web TUI is disabled. Set ENABLE_WEB_TUI=true to enable it.");
  }
  if (!isConfigured()) {
    return res.redirect("/setup");
  }
  res.sendFile(path.join(process.cwd(), "src", "public", "tui.html"));
});

let activeTuiSession = null;
function closeTuiSession() {
  const session = activeTuiSession;
  if (!session) return;
  activeTuiSession = null;
  try {
    session.ws.close(1001, "Maintenance in progress");
    session.pty?.kill();
  } catch {}
}

function verifySetupCredentials(req) {
  if (!SETUP_PASSWORD) return false;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto
    .createHash("sha256")
    .update(SETUP_PASSWORD)
    .digest();
  return crypto.timingSafeEqual(passwordHash, expectedHash);
}

function createTuiWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket?.remoteAddress || "unknown";
    console.log(`[tui] session started from ${clientIp}`);

    let ptyProcess = null;
    let idleTimer = null;
    let maxSessionTimer = null;

    activeTuiSession = {
      ws,
      pty: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };

    function resetIdleTimer() {
      if (activeTuiSession?.ws === ws) {
        activeTuiSession.lastActivity = Date.now();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log("[tui] session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);
    }

    function spawnPty(cols, rows) {
      if (ptyProcess) return;

      console.log(`[tui] spawning PTY with ${cols}x${rows}`);
      ptyProcess = pty.spawn(OPENCLAW_NODE, clawArgs(["tui"]), {
        name: "xterm-256color",
        cols,
        rows,
        cwd: WORKSPACE_DIR,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          TERM: "xterm-256color",
        },
      });

      if (!isConfigured() || activeTuiSession) {
        activeTuiSession.pty = ptyProcess;
      }

      resetIdleTimer();

      ptyProcess.onData((data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[tui] PTY exited code=${exitCode} signal=${signal}`);
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, "Process exited");
        }
      });
    }

    resetIdleTimer();
    maxSessionTimer = setTimeout(
      () => ws.close(4002, "Max session duration"),
      TUI_MAX_SESSION_MS,
    );
    ws.on("message", (message) => {
      if (activeTuiSession?.ws !== ws || activeMutation || shuttingDown) return;
      resetIdleTimer();
      try {
        const msg = JSON.parse(message.toString());
        if (
          msg.type === "resize" &&
          Number.isInteger(msg.cols) &&
          Number.isInteger(msg.rows)
        ) {
          const cols = Math.min(Math.max(msg.cols, 10), 500);
          const rows = Math.min(Math.max(msg.rows, 5), 200);
          if (!ptyProcess) {
            spawnPty(cols, rows);
          } else {
            ptyProcess.resize(cols, rows);
          }
        } else if (
          msg.type === "input" &&
          typeof msg.data === "string" &&
          ptyProcess
        ) {
          ptyProcess.write(msg.data);
        }
      } catch (err) {
        console.warn(`[tui] invalid message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      console.log("[tui] session closed");
      clearTimeout(idleTimer);
      clearTimeout(maxSessionTimer);
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {}
      }
      if (activeTuiSession?.ws === ws) activeTuiSession = null;
    });

    ws.on("error", (err) => {
      console.error(`[tui] WebSocket error: ${err.message}`);
    });
  });

  return wss;
}

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  changeOrigin: true,
  proxyTimeout: 120_000,
  timeout: 120_000,
});

proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err);
  if (res && typeof res.headersSent !== "undefined" && !res.headersSent) {
    res.writeHead(503, { "Content-Type": "text/html" });
    try {
      const html = fs.readFileSync(
        path.join(process.cwd(), "src", "public", "loading.html"),
        "utf8",
      );
      res.end(html);
    } catch {
      res.end("Gateway unavailable. Retrying...");
    }
  }
});

proxy.on("proxyReq", (proxyReq, req) =>
  applyProxyPolicy(proxyReq, req, verifySetupCredentials(req) ? OPENCLAW_GATEWAY_TOKEN : undefined),
);
proxy.on("proxyReqWs", (proxyReq, req) =>
  applyProxyPolicy(proxyReq, req, verifySetupCredentials(req) ? OPENCLAW_GATEWAY_TOKEN : undefined),
);

app.use(async (req, res) => {
  if (activeMutation || shuttingDown || bootFailure)
    return res
      .status(503)
      .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    if (!isGatewayReady()) {
      try {
        await ensureGatewayRunning();
      } catch {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }

      if (!isGatewayReady()) {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }
    }
  }

  if (activeMutation || shuttingDown || !isConfigured())
    return res
      .status(503)
      .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

app.use((err, _req, res, _next) => {
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({
    ok: false,
    error:
      err.status === 413
        ? "Request body is too large"
        : err.status === 400
          ? "Invalid request body"
          : "Request failed; review server diagnostics",
  });
});

const server = app.listen(PORT, () => {
  serverLog.info("wrapper", `listening on port ${PORT}`);
  serverLog.info("wrapper", `setup wizard: http://localhost:${PORT}/setup`);
  serverLog.info(
    "wrapper",
    `web TUI: ${ENABLE_WEB_TUI ? "enabled" : "disabled"}`,
  );
  serverLog.info("wrapper", `configured: ${isConfigured()}`);

  if (isConfigured() && !bootFailure) {
    const boot = { name: "boot migration", controller: new AbortController(), secrets: [] };
    activeMutation = boot;
    boot.done = (async () => {
      let attempt;
      let committed = false;
      try {
        await gateway.stop();
        attempt = upgradeRecovery.begin();
        if (attempt.needed) {
          serverLog.info("upgrade", `Recovery snapshot retained at ${attempt.snapshotPath}`);
          await syncAllowedOrigins(boot.controller.signal, { installPlugins: false });
          const dr = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--non-interactive", "--repair"]), { timeoutMs: 300_000 });
          if (dr.code !== 0) throw new Error(`Doctor failed (exit ${dr.code})`);
          // Target's own update canary suppresses hooks, channels, scheduled work
          // and discovery until database migration is committed.
          setUpgradeCanary(true);
          await ensureGatewayRunning();
          upgradeRecovery.commit();
          committed = true;
          await gateway.stop();
          setUpgradeCanary(false);
        }
        await ensureGatewayRunning();
      } catch (error) {
        try {
          await gateway.stop();
          setUpgradeCanary(false);
          if (attempt?.needed && !committed) {
            const restored = upgradeRecovery.rollback();
            serverLog.warn("upgrade", `Original data restored from ${restored.snapshotPath}`);
          }
        } catch (recoveryError) {
          serverLog.error("upgrade", `Recovery needs attention: ${recoveryError.message}; original snapshot was retained`);
        }
        bootFailure = `Boot upgrade failed: ${error.message}. Recovery data is retained; use Run Doctor to deliberately retry.`;
        serverLog.error("wrapper", bootFailure);
      } finally { if (activeMutation === boot) activeMutation = null; }
    })();
  } else if (bootFailure) serverLog.error("wrapper", bootFailure);

});

const tuiWss = createTuiWebSocketServer(server);

server.on("upgrade", async (req, socket, head) => {
  if (activeMutation || shuttingDown || bootFailure) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(req.url, "http://wrapper.invalid");

  if (url.pathname === "/tui/ws") {
    if (!ENABLE_WEB_TUI) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!verifySetupCredentials(req)) {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="OpenClaw TUI"\r\n\r\n',
      );
      socket.destroy();
      return;
    }

    if (!isConfigured() || activeTuiSession) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }

    tuiWss.handleUpgrade(req, socket, head, (ws) => {
      tuiWss.emit("connection", ws, req);
    });
    return;
  }

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch (err) {
    console.warn(`[websocket] gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }
  if (activeMutation || shuttingDown || !isConfigured() || !isGatewayReady()) {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

async function gracefulShutdown(signal) {
  serverLog.info("wrapper", `received ${signal}, shutting down`);
  shuttingDown = true;

  if (setupRateLimiter.cleanupInterval) {
    clearInterval(setupRateLimiter.cleanupInterval);
  }

  const operation = activeMutation;
  operation?.controller.abort();
  await closeTuiSession();
  server.close();
  try {
    await gateway.stop({ shutdown: true });
  } catch (err) {
    serverLog.warn("wrapper", `error stopping gateway: ${err.message}`);
  }
  if (operation?.done) {
    let deadline;
    try {
      await Promise.race([
        operation.done,
        new Promise((resolve) => {
          deadline = setTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
