import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  sanitizeImportedTrust,
  validateStagedMigrationInputs,
} from "./import-trust.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-import-trust-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stagingRoot = path.join(root, "stage");
  const stagedStateDir = path.join(stagingRoot, "data/.openclaw");
  const liveStateDir = path.join(root, "live/.openclaw");
  fs.mkdirSync(path.join(stagedStateDir, "state"), { recursive: true });
  fs.mkdirSync(liveStateDir, { recursive: true });
  const databasePath = path.join(stagedStateDir, "state/openclaw.sqlite");
  return { root, stagingRoot, stagedStateDir, liveStateDir, databasePath };
}

function database(f) {
  const db = new DatabaseSync(f.databasePath);
  db.exec(
    fs.readFileSync(
      new URL("./fixtures/import-trust-schema-v20.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(`
    PRAGMA user_version=20;
    CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, app_version TEXT);
    INSERT INTO schema_meta VALUES ('primary', 'global', 20, '2026.10.4');
    CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT);
    CREATE TABLE worker_environments (environment_id TEXT);
    CREATE TABLE provider_credentials (provider TEXT, credential TEXT);
    INSERT INTO provider_credentials VALUES ('synthetic', 'provider-secret-preserved');
    CREATE TABLE session_history (session_id TEXT, transcript TEXT);
    INSERT INTO session_history VALUES ('synthetic-session', 'conversation-preserved');
    CREATE TABLE cron_jobs (job_id TEXT, schedule TEXT);
    INSERT INTO cron_jobs VALUES ('synthetic-job', '0 8 * * *');
  `);
  const trustTables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('schema_meta','config_machine_state','worker_environments','provider_credentials','session_history','cron_jobs')",
    )
    .all()
    .map(({ name }) => name);
  for (const table of trustTables) {
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
    db.prepare(
      `INSERT INTO "${table}" VALUES (${columns.map(() => "?").join(",")})`,
    ).run(
      ...columns.map((column) =>
        column.type === "INTEGER" ? 1 : "synthetic-device-secret-only",
      ),
    );
  }
  return { db, trustTables };
}

test("staged cleanup removes device authority while preserving provider credentials, histories and schedules", (t) => {
  const f = fixture(t);
  const { db, trustTables } = database(f);
  db.exec("PRAGMA journal_mode=WAL");
  db.close();
  const result = sanitizeImportedTrust(f.stagedStateDir, f);
  assert.equal(result.removedRows, 12);
  assert.equal(result.legacy, false);
  const inspected = new DatabaseSync(f.databasePath, { readOnly: true });
  for (const table of trustTables)
    assert.equal(
      inspected.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n,
      0,
    );
  assert.equal(
    inspected.prepare("SELECT credential FROM provider_credentials").get()
      .credential,
    "provider-secret-preserved",
  );
  assert.equal(
    inspected.prepare("SELECT transcript FROM session_history").get()
      .transcript,
    "conversation-preserved",
  );
  assert.equal(
    inspected.prepare("SELECT schedule FROM cron_jobs").get().schedule,
    "0 8 * * *",
  );
  inspected.close();
  assert.equal(
    fs
      .readFileSync(f.databasePath)
      .includes(Buffer.from("synthetic-device-secret-only")),
    false,
    "removed secrets must not remain in unused SQLite pages",
  );
});

for (const [description, mutate, expected] of [
  [
    "future schema",
    (db) => db.exec("PRAGMA user_version=21"),
    /reviewed OpenClaw/,
  ],
  [
    "future content schema",
    (db) =>
      db.exec(
        "INSERT INTO config_machine_state VALUES ('state.schema.contentVersion','21')",
      ),
    /reviewed OpenClaw/,
  ],
  [
    "unreviewed app version",
    (db) => db.exec("UPDATE schema_meta SET app_version='2026.10.5'"),
    /reviewed OpenClaw/,
  ],
  [
    "agent database substituted for global",
    (db) => db.exec("UPDATE schema_meta SET role='agent'"),
    /reviewed OpenClaw/,
  ],
  [
    "extra trust columns",
    (db) =>
      db.exec("ALTER TABLE device_auth_tokens ADD COLUMN future_token TEXT"),
    /unreviewed schema/,
  ],
  [
    "missing trust table",
    (db) => db.exec("DROP TABLE device_bootstrap_tokens"),
    /missing reviewed/,
  ],
  [
    "new device trust table",
    (db) => db.exec("CREATE TABLE device_future_auth (token TEXT)"),
    /unreviewed device trust table/,
  ],
  [
    "new approval authority table",
    (db) =>
      db.exec("CREATE TABLE operator_approval_future_authority (token TEXT)"),
    /unreviewed device trust table/,
  ],
  [
    "delete trigger",
    (db) =>
      db.exec(
        "CREATE TRIGGER trust_delete AFTER DELETE ON device_auth_tokens BEGIN DELETE FROM provider_credentials; END",
      ),
    /unreviewed triggers/,
  ],
  [
    "foreign key cascade",
    (db) =>
      db.exec(
        "CREATE TABLE foreign_consumer (device_id TEXT, role TEXT, FOREIGN KEY(device_id,role) REFERENCES device_auth_tokens(device_id,role) ON DELETE CASCADE)",
      ),
    /unreviewed foreign keys/,
  ],
  [
    "external workers",
    (db) =>
      db.exec("INSERT INTO worker_environments VALUES ('leased-resource')"),
    /external worker environments/,
  ],
]) {
  test(`unknown ${description} fails without clearing source trust or unrelated state`, (t) => {
    const f = fixture(t);
    const { db } = database(f);
    mutate(db);
    db.close();
    assert.throws(() => sanitizeImportedTrust(f.stagedStateDir, f), expected);
    const inspected = new DatabaseSync(f.databasePath, { readOnly: true });
    assert.equal(
      inspected.prepare("SELECT COUNT(*) AS n FROM device_auth_tokens").get().n,
      1,
    );
    assert.equal(
      inspected.prepare("SELECT COUNT(*) AS n FROM provider_credentials").get()
        .n,
      1,
    );
    inspected.close();
  });
}

test("live roots, unbounded stages, database hardlinks, and symlinks cannot be sanitized", (t) => {
  const f = fixture(t);
  const { db } = database(f);
  db.close();
  assert.throws(
    () => sanitizeImportedTrust(f.stagedStateDir),
    /explicit staging/,
  );
  assert.throws(
    () =>
      sanitizeImportedTrust(f.stagedStateDir, {
        ...f,
        liveStateDir: f.stagedStateDir,
      }),
    /never live/,
  );
  assert.throws(
    () =>
      sanitizeImportedTrust(f.stagedStateDir, {
        ...f,
        stagingRoot: f.liveStateDir,
      }),
    /never live/,
  );
  const linked = path.join(f.liveStateDir, "linked.sqlite");
  fs.linkSync(f.databasePath, linked);
  assert.throws(
    () => sanitizeImportedTrust(f.stagedStateDir, f),
    /standalone regular file/,
  );
  fs.unlinkSync(linked);
  fs.symlinkSync(f.liveStateDir, path.join(f.stagingRoot, "link"));
  assert.throws(() => sanitizeImportedTrust(f.stagedStateDir, f), /link/);
});

test("legacy state without a shared database leaves migration to the caller", (t) => {
  const f = fixture(t);
  assert.deepEqual(sanitizeImportedTrust(f.stagedStateDir, f), {
    legacy: true,
    removedRows: 0,
    clearedTables: [],
  });
  assert.equal(fs.existsSync(f.databasePath), false);
});

test("reviewed schema migrated by Doctor may retain its legitimate null app version", (t) => {
  const f = fixture(t);
  const { db } = database(f);
  db.exec("UPDATE schema_meta SET app_version=NULL");
  db.close();
  assert.equal(
    sanitizeImportedTrust(f.stagedStateDir, f).clearedTables.length,
    12,
  );
});

test("Gateway-created lazy approval descendants clear before parents without losing schedules", (t) => {
  const f = fixture(t);
  const { db } = database(f);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(
    fs.readFileSync(
      new URL("./fixtures/import-trust-lazy-schema-v20.sql", import.meta.url),
      "utf8",
    ),
  );
  const lazyTables = [
    "operator_approval_execution_identities",
    "operator_approval_standing_grants",
    "operator_approval_standing_grant_generations",
    "web_push_approval_deliveries",
  ];
  for (const table of lazyTables) {
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
    db.prepare(
      `INSERT INTO "${table}" VALUES (${columns.map(() => "?").join(",")})`,
    ).run(
      ...columns.map((column) =>
        column.type === "INTEGER" ? 1 : "synthetic-device-secret-only",
      ),
    );
  }
  db.close();
  const result = sanitizeImportedTrust(f.stagedStateDir, f);
  assert.equal(result.removedRows, 16);
  assert.equal(result.clearedTables.length, 16);
  const inspected = new DatabaseSync(f.databasePath, { readOnly: true });
  assert.deepEqual(inspected.prepare("PRAGMA foreign_key_check").all(), []);
  for (const table of lazyTables)
    assert.equal(
      inspected.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n,
      0,
    );
  assert.equal(
    inspected.prepare("SELECT schedule FROM cron_jobs").get().schedule,
    "0 8 * * *",
  );
  assert.equal(
    inspected.prepare("SELECT credential FROM provider_credentials").get()
      .credential,
    "provider-secret-preserved",
  );
  inspected.close();
});

function authoredConfig(f, patch = {}) {
  fs.writeFileSync(
    path.join(f.stagedStateDir, "openclaw.json"),
    JSON.stringify({
      agents: {
        defaults: { workspace: path.join(f.stagingRoot, "data/workspace") },
      },
      ...patch,
    }),
  );
}

function agentRegistry(db, storedPath) {
  db.exec(
    "CREATE TABLE agent_databases (agent_id TEXT NOT NULL, path TEXT NOT NULL, schema_version INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, size_bytes INTEGER, PRIMARY KEY(agent_id,path)) STRICT",
  );
  db.prepare("INSERT INTO agent_databases VALUES ('main',?,1,1,NULL)").run(
    storedPath,
  );
}

for (const [description, patch] of [
  ["config includes", { $include: "/outside/config.json" }],
  [
    "executable secrets",
    {
      secrets: {
        providers: { shell: { source: "exec", command: "/outside/command" } },
      },
    },
  ],
  [
    "external file secrets",
    {
      secrets: {
        providers: { local: { source: "file", path: "/outside/secrets.json" } },
      },
    },
  ],
  [
    "custom plugin paths",
    { plugins: { load: { paths: ["/outside/plugin"] } } },
  ],
  [
    "per-agent list paths",
    { agents: { list: [{ id: "main", agentDir: "/outside/agent" }] } },
  ],
  [
    "per-agent entry paths",
    { agents: { entries: { main: { workspace: "/outside/workspace" } } } },
  ],
  ["shell environment import", { env: { shellEnv: { enabled: true } } }],
  [
    "operator plugin installs",
    {
      plugins: {
        installs: {
          discord: { source: "path", sourcePath: "/outside/discord" },
        },
      },
      channels: { discord: {} },
    },
  ],
]) {
  test(`migration preflight refuses ${description} before imported code or dependencies run`, (t) => {
    const f = fixture(t);
    authoredConfig(f, patch);
    assert.throws(() => validateStagedMigrationInputs(f.stagedStateDir, f));
    assert.equal(fs.existsSync(f.databasePath), false);
  });
}

test("migration preflight validates the durable agent registry before Doctor can follow paths", (t) => {
  const f = fixture(t);
  authoredConfig(f);
  const { db } = database(f);
  agentRegistry(db, "/outside/agent.sqlite");
  db.close();
  assert.throws(
    () => validateStagedMigrationInputs(f.stagedStateDir, f),
    /absolute or external/,
  );
});

test("migration preflight accepts contained existing agent databases and preserves their bytes", (t) => {
  const f = fixture(t);
  authoredConfig(f);
  const { db } = database(f);
  agentRegistry(db, "agents/main/agent/openclaw-agent.sqlite");
  db.close();
  const agent = path.join(
    f.stagedStateDir,
    "agents/main/agent/openclaw-agent.sqlite",
  );
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.writeFileSync(agent, "synthetic-agent-database-preserved");
  assert.equal(
    validateStagedMigrationInputs(f.stagedStateDir, f).agentDatabaseCount,
    1,
  );
  assert.equal(
    fs.readFileSync(agent, "utf8"),
    "synthetic-agent-database-preserved",
  );
});

test("migration preflight accepts default per-agent paths after destination relocation", (t) => {
  const f = fixture(t);
  authoredConfig(f, {
    agents: {
      entries: {
        main: {
          agentDir: path.join(f.stagedStateDir, "agents/main/agent"),
          workspace: path.join(f.stagingRoot, "data/workspace"),
        },
      },
    },
  });
  assert.equal(validateStagedMigrationInputs(f.stagedStateDir, f).legacy, true);
});

test("baseline absolute default agent registry paths reanchor to staged files before Doctor", (t) => {
  const f = fixture(t);
  authoredConfig(f);
  const { db } = database(f);
  db.exec(
    "PRAGMA user_version=1; UPDATE schema_meta SET schema_version=1,app_version=NULL",
  );
  agentRegistry(
    db,
    "/source/data/.openclaw/agents/main/agent/openclaw-agent.sqlite",
  );
  db.close();
  const agent = path.join(
    f.stagedStateDir,
    "agents/main/agent/openclaw-agent.sqlite",
  );
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.writeFileSync(agent, "preserved-agent-database");
  const result = validateStagedMigrationInputs(f.stagedStateDir, f);
  assert.equal(result.reanchoredAgentDatabases, 1);
  const inspected = new DatabaseSync(f.databasePath, { readOnly: true });
  assert.equal(
    inspected.prepare("SELECT path FROM agent_databases").get().path,
    "agents/main/agent/openclaw-agent.sqlite",
  );
  inspected.close();
  assert.equal(fs.readFileSync(agent, "utf8"), "preserved-agent-database");
});

test("recognized official plugin payloads are discarded and their code never executes", (t) => {
  const f = fixture(t);
  const record = {
    source: "npm",
    spec: "@openclaw/discord@2026.9.9",
    resolvedName: "@openclaw/discord",
    installPath: "/source/.openclaw/extensions/discord",
  };
  authoredConfig(f, {
    channels: { discord: {} },
    plugins: { installs: { discord: record } },
  });
  const { db } = database(f);
  db.prepare("INSERT INTO config_machine_state VALUES (?,?)").run(
    "plugins.installedIndex",
    JSON.stringify({ index: { installRecords: { discord: record } } }),
  );
  db.close();
  const extension = path.join(f.stagedStateDir, "extensions/discord");
  fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(
    path.join(extension, "index.js"),
    'throw new Error("untrusted code must never execute")',
  );
  const project = path.join(f.stagedStateDir, "npm/projects/official-discord");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ dependencies: { "@openclaw/discord": "2026.9.9" } }),
  );
  assert.deepEqual(
    validateStagedMigrationInputs(f.stagedStateDir, f).rebuildPlugins,
    ["discord"],
  );
  assert.equal(fs.existsSync(extension), false);
  assert.equal(fs.existsSync(project), false);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(f.stagedStateDir, "openclaw.json"), "utf8"),
    ).plugins.installs,
    undefined,
  );
  const inspected = new DatabaseSync(f.databasePath, { readOnly: true });
  assert.equal(
    inspected
      .prepare(
        "SELECT 1 FROM config_machine_state WHERE state_key='plugins.installedIndex'",
      )
      .get(),
    undefined,
  );
  assert.equal(
    inspected.prepare("SELECT COUNT(*) AS n FROM provider_credentials").get().n,
    1,
  );
  inspected.close();
});

test("unknown extension payloads remain intact and require an explicit CLI restore", (t) => {
  const f = fixture(t);
  authoredConfig(f);
  const extension = path.join(f.stagedStateDir, "extensions/custom");
  fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(path.join(extension, "user-code.js"), "preserve");
  assert.throws(
    () => validateStagedMigrationInputs(f.stagedStateDir, f),
    /custom extension/,
  );
  assert.equal(
    fs.readFileSync(path.join(extension, "user-code.js"), "utf8"),
    "preserve",
  );
});

test("pre-July plugin index requests its required intermediate migration", (t) => {
  const f = fixture(t);
  authoredConfig(f);
  fs.mkdirSync(path.join(f.stagedStateDir, "plugins"));
  fs.writeFileSync(path.join(f.stagedStateDir, "plugins/installs.json"), "{}");
  assert.throws(
    () => validateStagedMigrationInputs(f.stagedStateDir, f),
    /2026.9.5/,
  );
});
