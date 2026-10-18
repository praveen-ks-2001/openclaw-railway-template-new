import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSON5 from "json5";
import { assertSafeStagedTree } from "./state-transfer.js";
import { requiredOfficialPlugins } from "./openclaw-compat.js";

// This narrow migration adapter is deliberately coupled to the reviewed release and SQLite shape.
// Device deletion is not exposed by a public offline SDK; never import private hashed modules.
const REVIEWED_VERSION = "2026.10.4";
const REVIEWED_SCHEMA = 20;
const TABLE_SHAPES = {
  device_auth_tokens:
    "992bfab3e5cf094d44799a0ce108d38c74c594c97a96f8317179af1528646c60",
  device_bootstrap_tokens:
    "23bb7b600418eaef6a4664a190b74c449380feb8a1700b276805ab25d6b629e4",
  device_identities:
    "13ddd1d0caf6e2c7550ad49dfea5bb2b36261246588e8605e03c3c5cf31443fc",
  device_pair_setup_completions:
    "dc5f3fe995a64271aa5506956c093a6d88444a93c59b487a240e9e9bc4fc1ccd",
  device_pairing_join_codes:
    "791ed72b47a22de34ef85d6b4b907c76488b48c5bbf8528726177969469fdea3",
  device_pairing_paired:
    "0193821a417f8329c4eb536770da0608f94352930544f53ad728a20b3b90a03e",
  device_pairing_pending:
    "0652adffefb3afed439f178be3b5f6b840c76b7b0f1a919568c7ed0b68c29fc7",
  gateway_origin_device_tokens:
    "bb589ef99abb82b411162d7ce3cfa96f3cb910a004b975d003fce305aca1dd8e",
  web_push_subscriptions:
    "5bd9c0a230ea830e79ceda70e69119225ebf53dd97e7cada11b4d27c8718ea83",
  apns_registrations:
    "6d67d645bd89dcd19b5ba1e46181181367fee6fbd2a900d8d43475434178835a",
  apns_registration_tombstones:
    "4ad88a1d88a6da3b0872aa01b30c3b178f9bd979d04e1ff6d5ad7bb6cebfb7a8",
  operator_approvals:
    "ce73c7c453d865c29146e8d93f639986602a8d25fd912a3efec9dfe75bfb78ad",
};
// These reviewed approval owners are created lazily when Gateway features first run.
// Keep descendants before parents so cleanup also works with foreign_keys enabled.
const OPTIONAL_TABLE_SHAPES = {
  operator_approval_standing_grant_generations:
    "6e0c560ae2042268dd5577338909ec599888f9e18be0bd28d0cce0f5e5ba224e",
  operator_approval_execution_identities:
    "59e6d29b30ea9d7d36ca638077d27ed9862fed3810073cef1008863257069e9d",
  web_push_approval_deliveries:
    "79c999cff49790602f1371ceb1e5cb635d5863791e26341b946d7416bcc72c05",
  operator_approval_standing_grants:
    "05a54b77daa2f55965d775e9d08499ed2ed4f9c3cfa7a1a9961807c3d157891e",
};
const ALL_TABLE_SHAPES = { ...OPTIONAL_TABLE_SHAPES, ...TABLE_SHAPES };
const REVIEWED_FOREIGN_KEYS = {
  operator_approval_execution_identities: [
    [
      "operator_approvals",
      "approval_id",
      "approval_id",
      "NO ACTION",
      "CASCADE",
      "NONE",
    ],
  ],
  operator_approval_standing_grants: [
    [
      "operator_approvals",
      "minted_by_approval_id",
      "approval_id",
      "NO ACTION",
      "CASCADE",
      "NONE",
    ],
  ],
  operator_approval_standing_grant_generations: [
    [
      "operator_approval_standing_grants",
      "grant_id",
      "grant_id",
      "NO ACTION",
      "CASCADE",
      "NONE",
    ],
  ],
  web_push_approval_deliveries: [
    [
      "operator_approvals",
      "approval_id",
      "approval_id",
      "NO ACTION",
      "CASCADE",
      "NONE",
    ],
    [
      "web_push_subscriptions",
      "subscription_id",
      "subscription_id",
      "NO ACTION",
      "CASCADE",
      "NONE",
    ],
  ],
};
const PRESERVED_TRUST_NAMES = new Set([
  "channel_pairing_allow_entries",
  "channel_pairing_requests",
  "workspace_generated_bootstrap_hashes",
]);

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function canonicalPath(raw) {
  let cursor = path.resolve(raw);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    suffix.unshift(path.basename(cursor));
    cursor = path.dirname(cursor);
  }
  return path.join(fs.realpathSync(cursor), ...suffix);
}

function validateSchema(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  const metadata = db
    .prepare(
      "SELECT role, schema_version, app_version FROM schema_meta WHERE meta_key = 'primary'",
    )
    .get();
  const content = db
    .prepare(
      "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
    )
    .get();
  const contentVersion = content ? JSON.parse(content.value_json) : version;
  // Doctor preserves NULL app_version when migrating baseline schema-1 databases.
  // Physical schema/version and every affected table shape remain mandatory guards.
  if (
    version !== REVIEWED_SCHEMA ||
    contentVersion !== REVIEWED_SCHEMA ||
    metadata?.role !== "global" ||
    metadata.schema_version !== REVIEWED_SCHEMA ||
    (metadata.app_version !== REVIEWED_VERSION && metadata.app_version !== null)
  ) {
    throw new Error(
      `Imported SQLite state is not the reviewed OpenClaw ${REVIEWED_VERSION} schema. Run the supported migration in staging or use the OpenClaw backup CLI.`,
    );
  }
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'")
    .all();
  const tableNames = new Set(tables.map(({ name }) => name));
  for (const { name } of tables) {
    if (
      /(?:device|bootstrap|pairing|^operator_approval|^web_push_approval)/i.test(
        name,
      ) &&
      !Object.hasOwn(ALL_TABLE_SHAPES, name) &&
      !PRESERVED_TRUST_NAMES.has(name)
    ) {
      throw new Error(
        `Imported SQLite state has an unreviewed device trust table: ${name}`,
      );
    }
    const escaped = name.replaceAll('"', '""');
    const relationships = db
      .prepare(`PRAGMA foreign_key_list("${escaped}")`)
      .all();
    const signature = (keys) =>
      JSON.stringify(
        keys
          .map((row) =>
            Array.isArray(row)
              ? row
              : [
                  row.table,
                  row.from,
                  row.to,
                  row.on_update,
                  row.on_delete,
                  row.match,
                ],
          )
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      );
    if (
      Object.hasOwn(ALL_TABLE_SHAPES, name)
        ? signature(relationships) !==
          signature(REVIEWED_FOREIGN_KEYS[name] ?? [])
        : relationships.some((row) =>
            Object.hasOwn(ALL_TABLE_SHAPES, row.table),
          )
    ) {
      throw new Error(
        "Imported SQLite state has unreviewed foreign keys involving device trust.",
      );
    }
  }
  if (!tableNames.has("worker_environments"))
    throw new Error(
      "Imported SQLite state is missing its worker ownership inventory.",
    );
  if (db.prepare("SELECT 1 FROM worker_environments LIMIT 1").get()) {
    throw new Error(
      "The import contains external worker environments. Release or migrate those resources on the source deployment before importing.",
    );
  }
  for (const [table, expected] of Object.entries(ALL_TABLE_SHAPES)) {
    if (!tableNames.has(table)) {
      if (Object.hasOwn(OPTIONAL_TABLE_SHAPES, table)) continue;
      throw new Error(
        `Imported SQLite state is missing reviewed trust table: ${table}`,
      );
    }
    const columns = db
      .prepare(`PRAGMA table_xinfo("${table}")`)
      .all()
      .map(({ name, type, notnull, pk, hidden }) => [
        name,
        type,
        notnull,
        pk,
        hidden,
      ]);
    const shape = crypto
      .createHash("sha256")
      .update(JSON.stringify(columns))
      .digest("hex");
    const definition = tables.find(({ name }) => name === table).sql;
    if (
      shape !== expected ||
      !/\)\s*STRICT\s*$/i.test(definition) ||
      /^CREATE\s+VIRTUAL/i.test(definition)
    ) {
      throw new Error(
        `Imported SQLite state has an unreviewed schema for ${table}.`,
      );
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? LIMIT 1",
        )
        .get(table)
    ) {
      throw new Error(
        `Imported SQLite state has unreviewed triggers on ${table}.`,
      );
    }
  }
  return Object.keys(ALL_TABLE_SHAPES).filter((table) => tableNames.has(table));
}

/** Check migration inputs before any imported plugin or configuration dependency can execute. */
export function validateStagedMigrationInputs(
  stagedStateDir,
  { stagingRoot } = {},
) {
  if (!stagingRoot)
    throw new Error(
      "Staged migration validation requires an explicit staging root.",
    );
  const stage = canonicalPath(stagingRoot);
  const state = canonicalPath(stagedStateDir);
  if (stage === state || !inside(stage, state))
    throw new Error(
      "Migration inputs must be contained in isolated staged state.",
    );
  assertSafeStagedTree(stage);
  const config = JSON5.parse(
    fs.readFileSync(path.join(state, "openclaw.json"), "utf8"),
  );
  const checkIncludes = (value) => {
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "$include"))
      throw new Error(
        "Imported configuration uses $include files. Use the OpenClaw backup CLI to restore its configuration graph.",
      );
    for (const child of Object.values(value)) checkIncludes(child);
  };
  checkIncludes(config);
  for (const agent of [
    ...(config.agents?.list ?? []),
    ...Object.values(config.agents?.entries ?? {}),
  ]) {
    if (
      agent.agentDir &&
      (typeof agent.agentDir !== "string" ||
        !inside(state, canonicalPath(agent.agentDir)))
    ) {
      throw new Error(
        "External per-agent database paths require the OpenClaw backup CLI for restoration.",
      );
    }
    if (
      agent.workspace &&
      (typeof agent.workspace !== "string" ||
        !inside(stage, canonicalPath(agent.workspace)))
    ) {
      throw new Error(
        "External per-agent workspace paths require the OpenClaw backup CLI for restoration.",
      );
    }
  }
  const workspace = config.agents?.defaults?.workspace;
  if (
    workspace &&
    (typeof workspace !== "string" || !inside(stage, canonicalPath(workspace)))
  ) {
    throw new Error(
      "The migration workspace must be rewritten into the staging directory before validation.",
    );
  }
  for (const provider of Object.values(config.secrets?.providers ?? {})) {
    if (provider?.source === "exec")
      throw new Error(
        "Executable secret providers cannot run during staged import. Use the OpenClaw backup CLI for this configuration.",
      );
    if (
      provider?.source === "file" &&
      (typeof provider.path !== "string" ||
        !inside(stage, canonicalPath(provider.path)))
    ) {
      throw new Error(
        "External secret-provider files require the OpenClaw backup CLI for restoration.",
      );
    }
  }
  if (
    config.plugins?.load?.paths?.length ||
    config.hooks?.internal?.load?.extraDirs?.length
  ) {
    throw new Error(
      "Custom plugin or hook load paths require the OpenClaw backup CLI for restoration.",
    );
  }
  if (config.env?.shellEnv?.enabled)
    throw new Error(
      "Shell environment import is unsupported during staged restoration.",
    );
  const official = new Map(
    requiredOfficialPlugins({ config }).map((plugin) => [
      plugin.plugin,
      plugin.package,
    ]),
  );
  const installRecords = new Map();
  const acceptRecords = (records) => {
    if (!records || typeof records !== "object" || Array.isArray(records))
      throw new Error(
        "Imported plugin registry is not a recognized record map.",
      );
    for (const [id, record] of Object.entries(records)) {
      const expected = official.get(id);
      const packageName = (value) =>
        typeof value === "string" && !/[\s:]/.test(value)
          ? value.match(/^(@[^/]+\/[^@]+)(?:@.+)?$/)?.[1]
          : null;
      if (
        !expected ||
        record?.source !== "npm" ||
        record.sourcePath ||
        record.artifactKind ||
        packageName(record.spec) !== expected ||
        (record.resolvedName && record.resolvedName !== expected) ||
        (record.resolvedSpec && packageName(record.resolvedSpec) !== expected)
      ) {
        throw new Error(
          "Custom or unrecognized plugin installations require the OpenClaw backup CLI for restoration.",
        );
      }
      installRecords.set(id, expected);
    }
  };
  acceptRecords(config.plugins?.installs ?? {});
  const legacyIndex = path.join(state, "plugins/installs.json");
  if (fs.existsSync(legacyIndex))
    throw new Error(
      "This import has a plugin index from before July 2026. Migrate it with OpenClaw 2026.9.5 Doctor before importing.",
    );
  const databasePath = path.join(state, "state/openclaw.sqlite");
  let agentDatabaseCount = 0;
  let hasPluginIndex = false;
  const registryUpdates = [];
  const legacy = !fs.existsSync(databasePath);
  if (!legacy) {
    if (fs.lstatSync(databasePath).nlink !== 1)
      throw new Error("Staged SQLite state must be a standalone regular file.");
    const db = new DatabaseSync(databasePath, {
      readOnly: true,
      allowExtension: false,
    });
    try {
      db.exec("PRAGMA trusted_schema = OFF");
      const registry = db
        .prepare(
          "SELECT type FROM sqlite_schema WHERE name = 'agent_databases'",
        )
        .get();
      if (registry && registry.type !== "table")
        throw new Error(
          "Imported agent database registry is not a regular table.",
        );
      const agents = registry
        ? db.prepare("SELECT agent_id, path FROM agent_databases").all()
        : [];
      for (const agent of agents) {
        if (
          typeof agent.path !== "string" ||
          agent.path.includes("\0") ||
          agent.path.includes("\\") ||
          /^[a-z]:/i.test(agent.path)
        ) {
          throw new Error(
            "Imported SQLite registry refers to an absolute or external agent database. Use the OpenClaw backup CLI for restoration.",
          );
        }
        let resolved = path.resolve(state, agent.path);
        if (path.isAbsolute(agent.path)) {
          const canonical = canonicalPath(agent.path);
          if (inside(state, canonical)) resolved = canonical;
          else if (
            typeof agent.agent_id === "string" &&
            /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agent.agent_id) &&
            agent.path.endsWith(
              `/agents/${agent.agent_id}/agent/openclaw-agent.sqlite`,
            )
          ) {
            resolved = path.join(
              state,
              "agents",
              agent.agent_id,
              "agent/openclaw-agent.sqlite",
            );
          } else
            throw new Error(
              "Imported SQLite registry refers to an absolute or external agent database. Use the OpenClaw backup CLI for restoration.",
            );
          registryUpdates.push({
            agentId: agent.agent_id,
            original: agent.path,
            relative: path.relative(state, resolved),
          });
        }
        if (!inside(state, resolved))
          throw new Error(
            "Imported SQLite registry refers to an external agent database.",
          );
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
          throw new Error(
            "An imported agent database is missing from the staged payload.",
          );
      }
      agentDatabaseCount = agents.length;
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='config_machine_state'",
          )
          .get()
      ) {
        const pluginIndex = db
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key='plugins.installedIndex'",
          )
          .get();
        if (pluginIndex) {
          const parsed = JSON.parse(pluginIndex.value_json);
          acceptRecords(parsed?.index?.installRecords);
          hasPluginIndex = true;
        }
      }
    } finally {
      db.close();
    }
  }
  const extensions = path.join(state, "extensions");
  for (const id of fs.existsSync(extensions)
    ? fs.readdirSync(extensions)
    : []) {
    if (!installRecords.has(id))
      throw new Error(
        "Archived custom extension code requires the OpenClaw backup CLI for restoration.",
      );
  }
  const projects = path.join(state, "npm/projects");
  for (const project of fs.existsSync(projects)
    ? fs.readdirSync(projects)
    : []) {
    const filename = path.join(projects, project, "package.json");
    if (!fs.existsSync(filename))
      throw new Error(
        "An archived npm plugin project has no ownership manifest.",
      );
    const npm = JSON.parse(fs.readFileSync(filename, "utf8"));
    const dependencies = Object.keys(npm.dependencies ?? {});
    if (
      !dependencies.length ||
      dependencies.some((name) => ![...installRecords.values()].includes(name))
    ) {
      throw new Error(
        "Archived npm projects contain unrecognized plugins. Use the OpenClaw backup CLI for restoration.",
      );
    }
  }
  if (fs.existsSync(path.join(state, "npm/node_modules")))
    throw new Error(
      "Legacy shared npm plugin installs require the OpenClaw backup CLI for restoration.",
    );
  // Proven managed code can be replaced from the target registry; it must never execute from the ZIP.
  if (hasPluginIndex || registryUpdates.length) {
    const db = new DatabaseSync(databasePath, { allowExtension: false });
    try {
      db.exec("PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE");
      const version = db.prepare("PRAGMA user_version").get().user_version;
      const metadata = db
        .prepare(
          "SELECT role, schema_version FROM schema_meta WHERE meta_key='primary'",
        )
        .get();
      if (
        ![1, REVIEWED_SCHEMA].includes(version) ||
        metadata?.role !== "global" ||
        metadata.schema_version !== version ||
        db
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('config_machine_state','agent_databases')",
          )
          .get() ||
        (hasPluginIndex && version !== REVIEWED_SCHEMA)
      ) {
        throw new Error(
          "The imported plugin registry schema needs an intermediate OpenClaw migration.",
        );
      }
      if (registryUpdates.length) {
        const columns = db
          .prepare("PRAGMA table_xinfo(agent_databases)")
          .all()
          .map(({ name, type, notnull, pk, hidden }) => [
            name,
            type,
            notnull,
            pk,
            hidden,
          ]);
        const expected = [
          ["agent_id", "TEXT", 1, 1, 0],
          ["path", "TEXT", 1, 2, 0],
          ["schema_version", "INTEGER", 1, 0, 0],
          ["last_seen_at", "INTEGER", 1, 0, 0],
          ["size_bytes", "INTEGER", 0, 0, 0],
        ];
        if (JSON.stringify(columns) !== JSON.stringify(expected))
          throw new Error("Imported agent registry has an unreviewed schema.");
        for (const { name } of db
          .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
          .all()) {
          const refs = db
            .prepare(`PRAGMA foreign_key_list("${name.replaceAll('"', '""')}")`)
            .all();
          if (
            refs.some(
              (row) =>
                name === "agent_databases" || row.table === "agent_databases",
            )
          )
            throw new Error(
              "Imported agent registry has unreviewed foreign keys.",
            );
        }
        const update = db.prepare(
          "UPDATE agent_databases SET path=? WHERE agent_id=? AND path=?",
        );
        for (const record of registryUpdates)
          update.run(record.relative, record.agentId, record.original);
      }
      if (hasPluginIndex)
        db.prepare(
          "DELETE FROM config_machine_state WHERE state_key='plugins.installedIndex'",
        ).run();
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }
  fs.rmSync(extensions, { recursive: true, force: true });
  fs.rmSync(projects, { recursive: true, force: true });
  if (config.plugins?.installs) {
    delete config.plugins.installs;
    fs.writeFileSync(
      path.join(state, "openclaw.json"),
      JSON.stringify(config, null, 2),
      { mode: 0o600 },
    );
  }
  return {
    legacy,
    agentDatabaseCount,
    reanchoredAgentDatabases: registryUpdates.length,
    rebuildPlugins: [...installRecords.keys()],
  };
}

/** Clear source-device authority only in an explicitly isolated, migrated import stage. */
export function sanitizeImportedTrust(
  stagedStateDir,
  { stagingRoot, liveStateDir } = {},
) {
  if (!stagingRoot || !liveStateDir)
    throw new Error(
      "Import trust cleanup requires explicit staging and live state roots.",
    );
  const staged = canonicalPath(stagedStateDir);
  const stage = canonicalPath(stagingRoot);
  const live = canonicalPath(liveStateDir);
  if (
    !inside(stage, staged) ||
    staged === stage ||
    inside(live, staged) ||
    inside(staged, live)
  ) {
    throw new Error(
      "Import trust cleanup may only operate on isolated staged state, never live state.",
    );
  }
  assertSafeStagedTree(stage);
  const databasePath = path.join(staged, "state", "openclaw.sqlite");
  if (!fs.existsSync(databasePath))
    return { legacy: true, removedRows: 0, clearedTables: [] };
  const stat = fs.lstatSync(databasePath);
  if (!stat.isFile() || stat.nlink !== 1)
    throw new Error("Staged SQLite state must be a standalone regular file.");
  const db = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  let inTransaction = false;
  try {
    db.exec(
      "PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 1000;",
    );
    const integrity = db.prepare("PRAGMA quick_check").all();
    if (integrity.length !== 1 || integrity[0].quick_check !== "ok")
      throw new Error("Imported SQLite state failed its integrity check.");
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const clearingTables = validateSchema(db);
    let removedRows = 0;
    for (const table of clearingTables)
      removedRows += Number(db.prepare(`DELETE FROM "${table}"`).run().changes);
    for (const table of clearingTables) {
      if (db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get())
        throw new Error("Imported device trust cleanup did not complete.");
    }
    db.exec("COMMIT");
    inTransaction = false;
    // Removed keys must not survive in free database pages or an old committed WAL frame.
    db.exec("VACUUM");
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint.busy)
      throw new Error(
        "Staged SQLite state is still in use; its trust cleanup cannot be committed safely.",
      );
    return { legacy: false, removedRows, clearedTables: clearingTables };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
