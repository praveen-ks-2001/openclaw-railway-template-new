import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
const pinned = manifest.openclawVersion;

// Execute the real entrypoint. Only package installation and privileged data
// commands are replaced; the branch manifest is read by the actual Node binary.
function boot(t, { override, installed, npmExit = 0, installedAfter, pin = pinned } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-version-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "app"), bin = path.join(root, "bin");
  fs.mkdirSync(app); fs.mkdirSync(bin);
  fs.copyFileSync(path.join(repository, "entrypoint.sh"), path.join(app, "entrypoint.sh"));
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ openclawVersion: pin }));
  if (installed !== undefined) fs.writeFileSync(path.join(root, "installed"), installed);
  const helper = path.join(bin, "helper.cjs");
  fs.writeFileSync(helper, "#!" + process.execPath + "\n" + String.raw`
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const root = process.env.VERSION_POLICY_FIXTURE, name = path.basename(process.argv[1]), args = process.argv.slice(2);
if (name === "node") {
  if (args[0] === "-e" && args[1].includes("/usr/local/lib/node_modules/openclaw/package.json")) {
    const file = path.join(root, "installed");
    if (fs.existsSync(file)) console.log(fs.readFileSync(file, "utf8"));
    else if (!args[1].includes("try{")) process.exitCode = 1;
  } else {
    const result = cp.spawnSync(process.env.VERSION_POLICY_REAL_NODE, args, { stdio: "inherit", env: process.env });
    process.exitCode = result.status ?? 1;
  }
} else {
  fs.appendFileSync(path.join(root, "commands.ndjson"), JSON.stringify({ name, args,
    version: process.env.OPENCLAW_VERSION, effective: process.env.OPENCLAW_EFFECTIVE_VERSION,
    requested: process.env.OPENCLAW_REQUESTED_VERSION, minimum: process.env.OPENCLAW_MINIMUM_VERSION,
    bumped: process.env.OPENCLAW_VERSION_BUMPED, noAutoUpdate: process.env.OPENCLAW_NO_AUTO_UPDATE }) + "\n");
  if (name === "npm") {
    if (Number(process.env.VERSION_POLICY_NPM_EXIT)) process.exitCode = Number(process.env.VERSION_POLICY_NPM_EXIT);
    else fs.writeFileSync(path.join(root, "installed"), process.env.VERSION_POLICY_INSTALLED_AFTER || args.at(-1).slice("openclaw@".length));
  }
}
`);
  fs.chmodSync(helper, 0o755);
  for (const command of ["node", "npm", "chown", "chmod", "cp", "rm", "ln", "gosu"])
    fs.symlinkSync(helper, path.join(bin, command));
  const env = {
    PATH: bin + path.delimiter + process.env.PATH,
    HOME: root, TMPDIR: root,
    VERSION_POLICY_FIXTURE: root, VERSION_POLICY_REAL_NODE: process.execPath,
    VERSION_POLICY_NPM_EXIT: String(npmExit),
    OPENCLAW_REQUESTED_VERSION: "untrusted-request", OPENCLAW_MINIMUM_VERSION: "untrusted-minimum",
    OPENCLAW_EFFECTIVE_VERSION: "untrusted-effective", OPENCLAW_VERSION_BUMPED: "true",
    OPENCLAW_NO_AUTO_UPDATE: "0",
    ...(override === undefined ? {} : { OPENCLAW_VERSION: override }),
    ...(installedAfter === undefined ? {} : { VERSION_POLICY_INSTALLED_AFTER: installedAfter }),
  };
  const result = spawnSync("/bin/bash", [path.join(app, "entrypoint.sh")], {
    cwd: root, env, encoding: "utf8", timeout: 15_000,
  });
  const log = path.join(root, "commands.ndjson");
  const commands = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { ...result, commands };
}

test("the real entrypoint ignores unset, old, newer, floating and invalid environment versions", (t) => {
  for (const override of [undefined, "", "2026.6.6", "2099.1.1", "latest", "file:/tmp/untrusted-package", "$(invalid-command)"]) {
    const result = boot(t, { override });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(result.commands.find((c) => c.name === "npm").args.at(-1), "openclaw@" + pinned);
    const launch = result.commands.find((c) => c.name === "gosu");
    assert.equal(launch.version, pinned);
    assert.equal(launch.effective, pinned);
    assert.equal(launch.noAutoUpdate, "1");
    for (const key of ["requested", "minimum", "bumped"]) assert.equal(launch[key], undefined);
  }
});

test("an already matching installation is reused despite a conflicting environment version", (t) => {
  const result = boot(t, { override: "2099.1.1", installed: pinned });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.commands.some((c) => c.name === "npm"), false);
  assert.equal(result.commands.find((c) => c.name === "gosu").effective, pinned);
});

test("a failed pinned install stops before persistent-data commands and wrapper startup", (t) => {
  const result = boot(t, { override: "latest", npmExit: 17 });
  assert.equal(result.status, 17);
  assert.deepEqual(result.commands.map((c) => c.name), ["npm"]);
});

test("a successful npm exit with the wrong installed release still refuses data access", (t) => {
  const result = boot(t, { installedAfter: "1900.1.1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /does not match/);
  assert.deepEqual(result.commands.map((c) => c.name), ["npm"]);
});

test("a missing or non-exact source pin fails before installation or persistent-data commands", (t) => {
  for (const pin of [null, "latest", "2026.10.4 || invalid-command"]) {
    const result = boot(t, { pin });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /must pin an exact/);
    assert.deepEqual(result.commands, []);
  }
});
