import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function setupApp() {
  let factory;
  const context = vm.createContext({
    document: { addEventListener: (_event, callback) => callback() },
    Alpine: {
      data: (_name, value) => {
        factory = value;
      },
    },
  });
  const html = fs.readFileSync(
    new URL("./public/setup.html", import.meta.url),
    "utf8",
  );
  for (const [, script] of html.matchAll(
    /<script\b[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    if (script.trim()) new vm.Script(script).runInContext(context);
  }
  return factory();
}
test("wizard accepts actual angle-wrapped device URLs across stream chunk boundaries", () => {
  const app = setupApp();
  for (const chunk of [
    "Sign in\nUR",
    "L: <https://auth.openai.com/",
    "codex/device>\nCo",
    "de: ABCD-EFGH\n",
  ])
    app.processSetupChunk(chunk);
  assert.equal(app.loginUrl, "https://auth.openai.com/codex/device");
  assert.equal(app.loginCode, "ABCD-EFGH");
  app.processSetupChunk("\n[setup] Failed. Review the output above.\n");
  assert.match(app.setupError, /failed/i);
});
test("wizard fallback URL parser excludes markup and does not mistake prose for a code", () => {
  const app = setupApp();
  app.processSetupChunk(
    "Open <https://accounts.x.ai/device>. Enter the code below. Code expires in 10 minutes.",
  );
  assert.equal(app.loginUrl, "https://accounts.x.ai/device");
  assert.equal(app.loginCode, "");
});
