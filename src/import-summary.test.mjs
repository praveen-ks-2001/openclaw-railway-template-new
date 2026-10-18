import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { summarizeStagedImport } from "./import-summary.js";
test("import preview counts SQLite sessions and legacy JSONL histories without exposing credentials", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-summary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "openclaw.json"),
    "{meta:{lastTouchedVersion:'2026.10.4'},auth:{token:'private'}}",
  );
  const modern = path.join(root, "agents", "main", "agent");
  fs.mkdirSync(modern, { recursive: true });
  const db = new DatabaseSync(path.join(modern, "openclaw-agent.sqlite"));
  db.exec(
    "CREATE TABLE session_nodes(session_key TEXT); INSERT INTO session_nodes VALUES('a'),('b')",
  );
  db.close();
  const legacy = path.join(root, "agents", "other", "sessions");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "conversation.jsonl"), "history");
  const summary = summarizeStagedImport(root, path.join(root, "workspace"));
  assert.equal(summary.sessionCount, 3);
  assert.equal(summary.sourceVersion, "2026.10.4");
  assert.ok(summary.importedSize > 0);
  assert.doesNotMatch(JSON.stringify(summary), /private|history/);
});
