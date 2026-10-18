import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createNormalizedSnapshot,
  restoreOfficialArchive,
} from "./state-backup.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-state-backup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, name, contents = name) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

function restoredTree(target, mutate = () => {}) {
  const archiveRoot = "synthetic-openclaw-backup";
  const stateArchive = `${archiveRoot}/payload/posix/data/.openclaw`;
  const workspaceArchive = `${archiveRoot}/payload/posix/data/workspace`;
  const manifest = {
    schemaVersion: 1,
    archiveRoot,
    paths: {
      stateDir: "/data/.openclaw",
      configPath: "/data/.openclaw/openclaw.json",
      oauthDir: "/data/.openclaw/credentials",
      workspaceDirs: ["/data/workspace"],
      agentRoots: [
        { agentId: "main", sourcePath: "/data/.openclaw/agents/main/agent" },
      ],
    },
    assets: [
      {
        kind: "state",
        sourcePath: "/data/.openclaw",
        archivePath: stateArchive,
      },
      {
        kind: "workspace",
        sourcePath: "/data/workspace",
        archivePath: workspaceArchive,
      },
    ],
    sqliteSnapshots: [
      { role: "global", sourcePath: "/data/.openclaw/openclaw.sqlite" },
    ],
  };
  write(
    target,
    `${stateArchive}/openclaw.json`,
    '{"agents":{"defaults":{"workspace":"/data/workspace"}}}',
  );
  write(
    target,
    `${stateArchive}/openclaw.sqlite`,
    "official-verified-snapshot",
  );
  write(
    target,
    `${stateArchive}/credentials/provider.json`,
    "synthetic-credential",
  );
  write(target, `${workspaceArchive}/SOUL.md`, "workspace");
  mutate(
    manifest,
    path.join(target, stateArchive),
    path.join(target, workspaceArchive),
  );
  write(target, `${archiveRoot}/manifest.json`, JSON.stringify(manifest));
}

function fakeCli(calls, mutate) {
  return async (args) => {
    calls.push(args);
    if (args[1] === "create")
      fs.writeFileSync(args[args.indexOf("--output") + 1], "verified-archive");
    else if (args[1] === "restore")
      restoredTree(args[args.indexOf("--target") + 1], mutate);
    else assert.fail(`Unexpected CLI operation: ${args[1]}`);
    return { code: 0, output: "not parsed: warnings can precede JSON" };
  };
}

test("export captures with official backup owner and normalizes verified snapshots for legacy ZIP", async (t) => {
  const root = fixture(t);
  const calls = [];
  const layout = await createNormalizedSnapshot({
    runCli: fakeCli(calls),
    scratchDir: root,
  });
  assert.deepEqual(
    calls.map((call) => call.slice(0, 2)),
    [
      ["backup", "create"],
      ["backup", "restore"],
    ],
  );
  assert.ok(calls[0].includes("--verify"));
  assert.ok(calls.every((call) => call.includes("--json")));
  assert.equal(
    fs.readFileSync(path.join(layout.stateDir, "openclaw.sqlite"), "utf8"),
    "official-verified-snapshot",
  );
  assert.equal(
    fs.readFileSync(path.join(layout.workspaceDir, "SOUL.md"), "utf8"),
    "workspace",
  );
  assert.equal(
    fs.readFileSync(
      path.join(layout.stateDir, "credentials/provider.json"),
      "utf8",
    ),
    "synthetic-credential",
  );
  assert.equal(path.basename(layout.dataRoot), "data");
  assert.ok(layout.stateDir.startsWith(layout.operationDir));
});

test("backup failures clean temporary state and do not reflect subprocess secret output", async (t) => {
  const root = fixture(t);
  await assert.rejects(
    createNormalizedSnapshot({
      runCli: async () => ({ code: 1, output: "secret-token-do-not-return" }),
      scratchDir: root,
    }),
    (error) => {
      assert.match(error.message, /backup creation/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(root), []);
});

test("normalization resolves authored paths against canonical backup assets", async (t) => {
  const root = fixture(t);
  const runCli = fakeCli([], (manifest) => {
    manifest.paths.stateDir = "/alias/data/.openclaw";
    manifest.paths.configPath = "/alias/data/.openclaw/openclaw.json";
    manifest.paths.oauthDir = "/alias/data/.openclaw/credentials";
    manifest.paths.workspaceDirs = ["/alias/data/workspace"];
    // The durable agent owner is canonical while manifest.paths retains authored aliases.
    manifest.paths.agentRoots = [
      { agentId: "main", sourcePath: "/data/.openclaw/agents/main/agent" },
    ];
  });
  const result = await restoreOfficialArchive("synthetic.tar.gz", {
    runCli,
    scratchDir: root,
  });
  assert.equal(
    fs.readFileSync(path.join(result.workspaceDir, "SOUL.md"), "utf8"),
    "workspace",
  );
  assert.equal(
    fs.readFileSync(path.join(result.stateDir, "openclaw.sqlite"), "utf8"),
    "official-verified-snapshot",
  );
});

test("local capture resolves ancestor aliases for existing config and missing credentials", async (t) => {
  const root = fixture(t);
  const original = path.join(fs.realpathSync(root), "original");
  write(
    original,
    ".openclaw/openclaw.json",
    '{"original":"never read for payload"}',
  );
  fs.mkdirSync(path.join(original, "workspace"));
  const alias = path.join(root, "authored-alias");
  fs.symlinkSync(original, alias);
  const runCli = fakeCli([], (manifest) => {
    manifest.paths.stateDir = path.join(original, ".openclaw");
    manifest.paths.configPath = path.join(alias, ".openclaw/openclaw.json");
    manifest.paths.oauthDir = path.join(alias, ".openclaw/credentials");
    manifest.paths.workspaceDirs = [path.join(alias, "workspace")];
    manifest.paths.agentRoots = [
      {
        agentId: "main",
        sourcePath: path.join(original, ".openclaw/agents/main/agent"),
      },
    ];
    manifest.assets[0].sourcePath = path.join(original, ".openclaw");
    manifest.assets[1].sourcePath = path.join(original, "workspace");
  });
  const result = await restoreOfficialArchive("synthetic.tar.gz", {
    runCli,
    scratchDir: root,
  });
  assert.equal(
    fs.readFileSync(path.join(result.workspaceDir, "SOUL.md"), "utf8"),
    "workspace",
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(result.stateDir, "openclaw.json"), "utf8"),
    /never read/,
  );
});

for (const [description, mutate, expected] of [
  [
    "multiple workspaces",
    (m) => {
      m.paths.workspaceDirs.push("/another/workspace");
    },
    /multiple workspaces|required configured source/,
  ],
  [
    "external agent databases",
    (m) => {
      m.paths.agentRoots[0].sourcePath = "/elsewhere/agent";
    },
    /agent database/,
  ],
  [
    "external credential directories",
    (m) => {
      m.paths.oauthDir = "/elsewhere/credentials";
    },
    /Credentials/,
  ],
  [
    "external active config",
    (m) => {
      m.paths.configPath = "/elsewhere/config.json";
    },
    /active configuration/,
  ],
  [
    "external managed resources",
    (m) => {
      m.assets.push({
        kind: "managed skill",
        sourcePath: "/elsewhere/skill",
        archivePath: `${m.archiveRoot}/payload/posix/elsewhere/skill`,
      });
    },
    /additional external/,
  ],
  [
    "configuration includes",
    (_m, state) => {
      fs.writeFileSync(
        path.join(state, "openclaw.json"),
        '{"$include":"local.json"}',
      );
    },
    /\$include/,
  ],
  [
    "workspace symlinks",
    (_m, _state, workspace) => {
      fs.symlinkSync("SOUL.md", path.join(workspace, "link"));
    },
    /link/,
  ],
]) {
  test(`normalization refuses ${description} instead of silently discarding data`, async (t) => {
    const root = fixture(t);
    await assert.rejects(
      restoreOfficialArchive("synthetic.tar.gz", {
        runCli: fakeCli([], mutate),
        scratchDir: root,
      }),
      expected,
    );
    assert.deepEqual(fs.readdirSync(root), []);
  });
}
