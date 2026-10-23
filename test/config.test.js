import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateConfig } from "../scripts/validate-config.js";

test("deployment configuration validates all declared and workflow entrypoints", () => {
  const result = validateConfig();
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});

test("configuration validation reports a usable inventory", () => {
  const result = validateConfig();
  assert.ok(result.functions >= 2);
  assert.ok(result.workflowEntrypoints >= 3);
});

test("dashboard setup creates or verifies only the dashboard Function", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/setup-dashboard-project.ps1"), "utf8");
  assert.match(script, /functions create/);
  assert.match(script, /github-dashboard/);
  assert.match(script, /functions\/github-dashboard\/src\/main\.js/);
  assert.doesNotMatch(script, /projects create|projects delete|functions delete/);
});
