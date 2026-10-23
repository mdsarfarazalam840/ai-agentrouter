import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeBundle } from "../scripts/run-github-patch-validation.mjs";

test("GitHub validation workflow is read-only, dynamic, and does not expose secrets", async () => {
  const workflow = await readFile(new URL("../.github/workflows/approved-patch-validation.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /repository_dispatch:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /NVIDIA_API_KEY|OPENROUTER_API_KEY|APPWRITE_API_KEY|PRIVATE_KEY|WEBHOOK_SECRET/);
  for (const command of ["npm test", "npm run check", "npm run check:dashboard"]) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("validation bundle decoding rejects malformed and mismatched payloads", () => {
  assert.throws(() => decodeBundle("not-base64"), /VALIDATION_BUNDLE_INVALID/);
  const encoded = Buffer.from(JSON.stringify({ targetSha: "a".repeat(40), patch: {}, snapshot: { baseSha: "b".repeat(40) } })).toString("base64url");
  assert.throws(() => decodeBundle(encoded), /VALIDATION_BUNDLE_SHA_MISMATCH/);
});
