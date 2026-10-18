import fs from "node:fs";
import path from "node:path";
import {
  assertSafeStagedTree,
  readOfficialBackupLayout,
} from "./state-transfer.js";

function within(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function checkedCli(runCli, args, operation) {
  const result = await runCli(args);
  if (!result || result.code !== 0) {
    // CLI output may contain configuration or credential details; do not echo it to the browser.
    throw new Error(
      `OpenClaw ${operation} failed. Check the server logs before retrying.`,
    );
  }
}

function normalizeRestoredBackup(restoreDir, normalizedRoot) {
  const restored = readOfficialBackupLayout(restoreDir);
  const { manifest, sourceStateDir, sourceWorkspaceDirs } = restored;
  const canonicalState = restored.canonicalSourcePath(sourceStateDir);
  const withinState = (value) =>
    within(canonicalState, restored.canonicalSourcePath(value));
  if (sourceWorkspaceDirs.length > 1) {
    throw new Error(
      "This installation has multiple workspaces. Use the OpenClaw backup CLI to preserve and restore all configured roots.",
    );
  }
  const configSource =
    manifest.paths?.configPath ?? path.join(sourceStateDir, "openclaw.json");
  if (
    path.resolve(restored.canonicalSourcePath(configSource)) !==
    path.resolve(canonicalState, "openclaw.json")
  ) {
    throw new Error(
      "The active configuration is outside the default state/openclaw.json path. Use the OpenClaw backup CLI for this layout.",
    );
  }
  if (manifest.paths?.oauthDir && !withinState(manifest.paths.oauthDir)) {
    throw new Error(
      "Credentials are stored outside the state directory. Use the OpenClaw backup CLI to preserve this layout.",
    );
  }
  for (const agent of manifest.paths?.agentRoots ?? []) {
    if (
      typeof agent.sourcePath !== "string" ||
      !withinState(agent.sourcePath)
    ) {
      throw new Error(
        "An agent database is stored outside the state directory. Use the OpenClaw backup CLI to preserve this layout.",
      );
    }
  }
  // A normalized ZIP represents exactly two owned roots. Never silently omit another asset.
  for (const asset of manifest.assets) {
    if (
      typeof asset.sourcePath !== "string" ||
      ![
        canonicalState,
        ...sourceWorkspaceDirs.map(restored.canonicalSourcePath),
      ].some((root) => within(root, asset.sourcePath))
    ) {
      throw new Error(
        "The backup contains additional external resources. Use the OpenClaw backup CLI to preserve and restore all configured roots.",
      );
    }
  }
  const configPath = restored.resolveSource(configSource);
  const authoredConfig = fs.readFileSync(configPath, "utf8");
  if (/(?:["']\$include["']|\$include)\s*:/.test(authoredConfig)) {
    throw new Error(
      "The active configuration uses $include files. Use the OpenClaw backup CLI to preserve this configuration graph.",
    );
  }
  // Refuse links rather than accidentally dereferencing external workspace data into the export.
  assertSafeStagedTree(restored.stateDir);
  for (const workspace of restored.workspaceDirs)
    assertSafeStagedTree(workspace);
  const dataRoot = path.join(normalizedRoot, "data");
  const stateDir = path.join(dataRoot, ".openclaw");
  const workspaceDir = path.join(dataRoot, "workspace");
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  fs.cpSync(restored.stateDir, stateDir, {
    recursive: true,
    dereference: false,
  });
  const sourceWorkspace =
    restored.workspaceDir ?? path.join(restored.stateDir, "workspace");
  if (fs.existsSync(sourceWorkspace)) {
    fs.cpSync(sourceWorkspace, workspaceDir, {
      recursive: true,
      dereference: false,
    });
  } else {
    fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  }
  assertSafeStagedTree(dataRoot);
  return {
    stateDir,
    workspaceDir,
    dataRoot,
    sourceStateDir,
    sourceWorkspaceDirs,
    manifest,
  };
}

/** Official restore verifies the archive and SQLite snapshots before extracting to fresh staging. */
export async function restoreOfficialArchive(archive, { runCli, scratchDir }) {
  if (typeof runCli !== "function")
    throw new Error("A backup CLI runner is required.");
  fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const operationDir = fs.mkdtempSync(path.join(scratchDir, "restore-"));
  const restoreDir = path.join(operationDir, "verified");
  try {
    await checkedCli(
      runCli,
      [
        "backup",
        "restore",
        path.resolve(archive),
        "--target",
        restoreDir,
        "--json",
      ],
      "backup restore/verification",
    );
    const layout = normalizeRestoredBackup(
      restoreDir,
      path.join(operationDir, "normalized"),
    );
    return { ...layout, operationDir };
  } catch (error) {
    fs.rmSync(operationDir, { recursive: true, force: true });
    throw error;
  }
}

/** Capture committed SQLite state with OpenClaw's own backup owner, never raw live database copies. */
export async function createNormalizedSnapshot({ runCli, scratchDir }) {
  if (typeof runCli !== "function")
    throw new Error("A backup CLI runner is required.");
  fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const operationDir = fs.mkdtempSync(path.join(scratchDir, "snapshot-"));
  const archive = path.join(operationDir, "snapshot.tar.gz");
  try {
    await checkedCli(
      runCli,
      ["backup", "create", "--output", archive, "--verify", "--json"],
      "backup creation/verification",
    );
    if (!fs.existsSync(archive))
      throw new Error("OpenClaw backup did not produce its requested archive.");
    const restored = await restoreOfficialArchive(archive, {
      runCli,
      scratchDir: operationDir,
    });
    return { ...restored, operationDir };
  } catch (error) {
    fs.rmSync(operationDir, { recursive: true, force: true });
    throw error;
  }
}
