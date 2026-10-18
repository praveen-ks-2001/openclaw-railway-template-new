import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSON5 from "json5";
import { assertSafeStagedTree } from "./state-transfer.js";

function scalarFromTable(filename, table, query) {
  if (!fs.existsSync(filename)) return undefined;
  const db = new DatabaseSync(filename, {
    readOnly: true,
    allowExtension: false,
  });
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_schema WHERE name=? AND type='table'")
        .get(table)
    )
      return undefined;
    return db.prepare(query).get();
  } finally {
    db.close();
  }
}

export function summarizeStagedImport(stateDir, workspaceDir) {
  const configPath = path.join(stateDir, "openclaw.json");
  const summary = {
    hasOpenclawJson: fs.existsSync(configPath),
    hasWorkspace: Boolean(workspaceDir && fs.existsSync(workspaceDir)),
    sessionCount: 0,
    sourceVersion: null,
    importedSize: assertSafeStagedTree(stateDir).bytes,
  };
  if (
    summary.hasWorkspace &&
    !path
      .resolve(workspaceDir)
      .startsWith(`${path.resolve(stateDir)}${path.sep}`)
  )
    summary.importedSize += assertSafeStagedTree(workspaceDir).bytes;
  if (summary.hasOpenclawJson) {
    const cfg = JSON5.parse(fs.readFileSync(configPath, "utf8"));
    summary.sourceVersion =
      cfg.meta?.lastTouchedVersion ?? cfg.meta?.version ?? cfg.version ?? null;
  }
  const agents = path.join(stateDir, "agents");
  if (fs.existsSync(agents))
    for (const agent of fs.readdirSync(agents, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      const root = path.join(agents, agent.name);
      const modern = scalarFromTable(
        path.join(root, "agent", "openclaw-agent.sqlite"),
        "session_nodes",
        "SELECT COUNT(*) AS count FROM session_nodes",
      );
      if (modern) summary.sessionCount += Number(modern.count);
      else if (fs.existsSync(path.join(root, "sessions")))
        summary.sessionCount += fs
          .readdirSync(path.join(root, "sessions"))
          .filter((n) => n.endsWith(".jsonl") && !n.includes(".bak.")).length;
    }
  const metadata = scalarFromTable(
    path.join(stateDir, "state", "openclaw.sqlite"),
    "schema_meta",
    "SELECT app_version FROM schema_meta WHERE meta_key='primary'",
  );
  summary.sourceVersion = metadata?.app_version ?? summary.sourceVersion;
  return summary;
}
