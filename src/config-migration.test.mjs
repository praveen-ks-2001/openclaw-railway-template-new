import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  migrateWrapperConfig,
  relocateImportedConfig,
  readSourceStateSchema,
} from "./config-migration.js";
test("migrates the wrapper's retired keys without widening channel policy", () => {
  const original = {
    gateway: {
      controlUi: {
        allowInsecureAuth: true,
        dangerouslyDisableDeviceAuth: true,
        allowedOrigins: ["https://custom.example"],
      },
    },
    channels: {
      discord: {
        token: "credential",
        dm: { policy: "allowlist" },
        groupPolicy: "allowlist",
      },
    },
    agents: { defaults: { model: "openai/example" } },
  };
  const next = migrateWrapperConfig(original, {
    publicDomain: "railway.example",
  });
  assert.equal(next.channels.discord.dmPolicy, "allowlist");
  assert.equal(next.channels.discord.token, "credential");
  assert.equal(next.channels.discord.groupPolicy, "allowlist");
  assert.equal(next.gateway.controlUi.allowInsecureAuth, undefined);
  assert.deepEqual(next.gateway.controlUi.allowedOrigins, [
    "https://custom.example",
    "https://railway.example",
  ]);
  assert.equal(original.channels.discord.dm.policy, "allowlist");
  assert.deepEqual(
    migrateWrapperConfig(next, { publicDomain: "railway.example" }),
    next,
  );
});
test("modern source paths are relocated into staging without reading the source deployment", () => {
  const original = {
    agents: {
      defaults: { workspace: "/source/workspace" },
      entries: {
        main: {
          workspace: "/source/workspace",
          agentDir: "/source/state/agents/main/agent",
        },
      },
    },
  };
  const next = relocateImportedConfig(original, {
    stateDir: "/stage/data/.openclaw",
    workspaceDir: "/stage/data/workspace",
  });
  assert.equal(
    next.agents.entries.main.agentDir,
    "/stage/data/.openclaw/agents/main/agent",
  );
  assert.equal(next.agents.entries.main.workspace, "/stage/data/workspace");
  assert.throws(
    () =>
      relocateImportedConfig(
        { agents: { entries: { main: { agentDir: "/unowned/database" } } } },
        { stateDir: "/stage/state", workspaceDir: "/stage/workspace" },
      ),
    /External agent/,
  );
});

function legacyConfig(extra = {}) {
  return {
    meta: { lastTouchedVersion: "2026.6.6" },
    agents: { defaults: { model: "minimax/MiniMax-M2.7" }, list: [{ id: "main" }] },
    ...extra,
  };
}
const dreaming = (config) => config.plugins?.entries?.["memory-core"]?.config?.dreaming;

test("preserves measured pre-8.1 implicit background defaults without changing model or user state", () => {
  const original = legacyConfig();
  const next = migrateWrapperConfig(original, { sourceStateSchema: 1 });
  assert.equal(dreaming(next).enabled, false);
  assert.deepEqual(next.skills.workshop, { autonomous: { mode: "off" }, approvalPolicy: "pending" });
  assert.deepEqual(next.agents, original.agents);
  assert.equal(original.plugins, undefined);
  assert.equal(original.skills, undefined);
  assert.deepEqual(migrateWrapperConfig(next, { sourceStateSchema: 1 }), next);
  assert.deepEqual(migrateWrapperConfig(next, { sourceStateSchema: 20 }), next, "later boots retain the explicit preserved choice");
});

test("does not infer old defaults for newer, ambiguous or already-canonical deployments", () => {
  for (const version of [undefined, null, "unknown", "2026.6.6-beta.1", "2026.8.1", "2026.8.1-beta.1", "2026.9.33", "2026.10.4", "2027.1.1"]) {
    const config = legacyConfig({ meta: { lastTouchedVersion: version } });
    const result = migrateWrapperConfig(config, { sourceStateSchema: 1 });
    assert.equal(dreaming(result), undefined, String(version));
    assert.equal(result.skills, undefined, String(version));
  }
  for (const sourceStateSchema of ["unknown", 0, 2, 14, 15, 20, Number.NaN]) {
    const result = migrateWrapperConfig(legacyConfig(), { sourceStateSchema });
    assert.equal(dreaming(result), undefined, String(sourceStateSchema));
    assert.equal(result.skills, undefined, String(sourceStateSchema));
  }
  const canonical = legacyConfig({ agents: { entries: { main: { workspace: "/data/workspace" } } } });
  assert.equal(dreaming(migrateWrapperConfig(canonical, { sourceStateSchema: 1 })), undefined);
  const configOnly = migrateWrapperConfig(legacyConfig(), { sourceStateSchema: null });
  assert.equal(dreaming(configOnly).enabled, false, "known old config-only backup retains legacy behavior");
});

test("retains explicit dreaming and workshop choices, including upstream boolean migration", () => {
  for (const enabled of [true, false]) {
    const config = legacyConfig({
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled, frequency: "0 5 * * *", model: "minimax/custom", phases: { deep: { limit: 2 } } } } } } },
      skills: { workshop: { autonomous: { enabled }, approvalPolicy: "auto", maxPending: 7 } },
    });
    const result = migrateWrapperConfig(config, { sourceStateSchema: 1 });
    assert.deepEqual(dreaming(result), dreaming(config));
    assert.deepEqual(result.skills.workshop, { autonomous: { mode: enabled ? "propose" : "off" }, approvalPolicy: "auto", maxPending: 7 });
    assert.equal(config.skills.workshop.autonomous.enabled, enabled);
  }
  const modern = legacyConfig({
    plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
    skills: { workshop: { autonomous: { enabled: false, mode: "auto" }, approvalPolicy: "pending" } },
  });
  const result = migrateWrapperConfig(modern, { sourceStateSchema: 1 });
  assert.equal(dreaming(result).enabled, true);
  assert.deepEqual(result.skills.workshop, { autonomous: { mode: "auto" }, approvalPolicy: "pending" });
  const optedIn = migrateWrapperConfig(legacyConfig({ skills: { workshop: { autonomous: { enabled: true } } } }), { sourceStateSchema: 1 });
  assert.deepEqual(optedIn.skills.workshop, { autonomous: { mode: "propose" }, approvalPolicy: "pending" });
});

test("uses pre-bridge source version, layout and schema rather than intermediate Doctor output", () => {
  const sourceConfig = legacyConfig();
  const intermediate = { meta: { lastTouchedVersion: "2026.9.5" }, agents: { entries: { main: { workspace: "/data/workspace" } } } };
  const result = migrateWrapperConfig(intermediate, { sourceConfig, sourceStateSchema: 1 });
  assert.equal(dreaming(result).enabled, false);
  assert.deepEqual(result.skills.workshop, { autonomous: { mode: "off" }, approvalPolicy: "pending" });
  const current = migrateWrapperConfig(intermediate, { sourceConfig, sourceStateSchema: 20 });
  assert.equal(dreaming(current), undefined, "newer state overrules an old config write stamp");
  assert.equal(current.skills, undefined);
});

test("does not activate disabled/custom memory owners or rewrite malformed explicit containers", () => {
  for (const plugins of [
    { slots: { memory: "none" } },
    { slots: { memory: "memory-lancedb" } },
    { enabled: false },
    { entries: { "memory-core": { enabled: false } } },
    { entries: { "memory-core": { config: { dreaming: null } } } },
  ]) {
    const original = legacyConfig({ plugins });
    const result = migrateWrapperConfig(original, { sourceStateSchema: 1 });
    assert.deepEqual(result.plugins, plugins);
  }
  const malformed = legacyConfig({ skills: { workshop: { autonomous: null } } });
  assert.deepEqual(migrateWrapperConfig(malformed, { sourceStateSchema: 1 }).skills, malformed.skills);
});

test("reads source schema without creating state or trusting inconsistent metadata", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-source-schema-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readSourceStateSchema(root), null);
  assert.equal(fs.existsSync(path.join(root, "state")), false);
  fs.mkdirSync(path.join(root, "state"));
  const filename = path.join(root, "state", "openclaw.sqlite");
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY,role TEXT,schema_version INTEGER); PRAGMA user_version=1; INSERT INTO schema_meta VALUES ('primary','global',1)");
  db.close();
  const before = fs.readFileSync(filename);
  assert.equal(readSourceStateSchema(root), 1);
  assert.deepEqual(fs.readFileSync(filename), before);
  for (const [version, role, metadataVersion, expected] of [[20, "global", 20, 20], [1, "agent", 1, "unknown"], [1, "global", 20, "unknown"], [0, "global", 0, "unknown"]]) {
    const writer = new DatabaseSync(filename);
    writer.exec(`PRAGMA user_version=${version}`);
    writer.prepare("UPDATE schema_meta SET role=?,schema_version=?").run(role, metadataVersion);
    writer.close();
    assert.equal(readSourceStateSchema(root), expected);
  }
  fs.writeFileSync(filename, "unrecognized database payload");
  assert.equal(readSourceStateSchema(root), "unknown");
});
