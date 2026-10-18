import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extractor = fileURLToPath(new URL("./extract-zip.py", import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zip-regression-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("password-protected ZIP extraction accepts correct password and rejects wrong password", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "data.txt"), "private state");
  execFileSync(
    "zip",
    ["-P", "archive-test-password", path.join(root, "archive.zip"), "data.txt"],
    { cwd: root },
  );
  const run = (password, dir) =>
    spawnSync(
      "python3",
      [extractor, path.join(root, "archive.zip"), path.join(root, dir)],
      {
        env: { ...process.env, WRAPPER_ARCHIVE_PASSWORD: password },
        encoding: "utf8",
      },
    );
  assert.equal(run("wrong", "bad").status, 82);
  assert.equal(run("archive-test-password", "good").status, 0);
  assert.equal(
    fs.readFileSync(path.join(root, "good", "data.txt"), "utf8"),
    "private state",
  );
});
test("actual extraction limits bound writes and traversal never escapes stage", (t) => {
  const root = fixture(t);
  const archive = path.join(root, "archive.zip");
  execFileSync("python3", [
    "-c",
    "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.writestr('data.txt','x'*100000); z.close()",
    archive,
  ]);
  const result = spawnSync(
    "python3",
    [extractor, archive, path.join(root, "bounded")],
    {
      env: { ...process.env, IMPORT_EXPANDED_MAX_BYTES: "100" },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.ok(fs.statSync(path.join(root, "bounded", "data.txt")).size <= 100);
  execFileSync("python3", [
    "-c",
    "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../escaped','bad'); z.close()",
    archive,
  ]);
  assert.notEqual(
    spawnSync("python3", [extractor, archive, path.join(root, "traversal")])
      .status,
    0,
  );
  assert.equal(fs.existsSync(path.join(root, "escaped")), false);
});
test("Info-ZIP Unicode names and executable workspace scripts survive extraction", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "café.md"), "memory");
  fs.writeFileSync(
    path.join(root, "script.sh"),
    "#!/bin/sh\nprintf executable",
    { mode: 0o755 },
  );
  execFileSync(
    "zip",
    [path.join(root, "archive.zip"), "café.md", "script.sh"],
    { cwd: root },
  );
  const result = spawnSync(
    "python3",
    [extractor, path.join(root, "archive.zip"), path.join(root, "restored")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(root, "restored", "café.md"), "utf8"),
    "memory",
  );
  const mode = fs.statSync(path.join(root, "restored", "script.sh")).mode;
  assert.ok(mode & 0o100);
  assert.equal(mode & 0o077, 0);
});
