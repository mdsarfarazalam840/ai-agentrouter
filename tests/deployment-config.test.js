import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { missingRequiredVariables, parseEnvText, loadEnvFile, resolveAppwriteContexts, validateFunctionProjectLimits } from "../scripts/deployment-config.js";

test("parses KEY=value lines and quoted values", () => {
  assert.deepEqual(parseEnvText('# comment\nA=one\nB="two words"\n'), { A: "one", B: "two words" });
});

test("reports required secrets, IDs, and connection settings by name only", () => {
  const missing = missingRequiredVariables({ APPWRITE_ENDPOINT: "https://example.test/v1" });
  assert.ok(missing.includes("APPWRITE_BACKEND_A_API_KEY"));
  assert.ok(missing.includes("APPWRITE_BACKEND_B_API_KEY"));
  assert.ok(missing.includes("WEBHOOK_DATABASE_ID"));
  assert.ok(missing.includes("APPWRITE_FUNCTION_GITHUB_PROFILE_INSIGHTS_ID"));
  assert.equal(missing.some((name) => name === "super-secret-value"), false);
});

test("explicit process environment values override the env file", () => {
  assert.deepEqual(loadEnvFile(new URL("../.env.example", import.meta.url), { APP_ID: "process-value" }).APP_ID, "process-value");
});

test("blank process values are absent and do not erase env-file values", () => {
  assert.equal(loadEnvFile(new URL("../.env.example", import.meta.url), {
    APPWRITE_ENDPOINT: "",
  }).APPWRITE_ENDPOINT, "https://cloud.appwrite.io/v1");
  assert.equal(loadEnvFile(new URL("../.env.example", import.meta.url), {
    APPWRITE_ENDPOINT: "https://process.example/v1",
  }).APPWRITE_ENDPOINT, "https://process.example/v1");
});

test("complete deployment configuration includes both Option A resource IDs", () => {
  const values = Object.fromEntries([
    "APPWRITE_SITE_ENDPOINT", "APPWRITE_SITE_PROJECT_ID", "APPWRITE_SITE_API_KEY",
    "APPWRITE_BACKEND_A_ENDPOINT", "APPWRITE_BACKEND_A_PROJECT_ID", "APPWRITE_BACKEND_A_API_KEY",
    "APPWRITE_BACKEND_B_ENDPOINT", "APPWRITE_BACKEND_B_PROJECT_ID", "APPWRITE_BACKEND_B_API_KEY",
    "WEBHOOK_DATABASE_ID", "WEBHOOK_DELIVERY_COLLECTION_ID",
    "APPWRITE_FUNCTION_HEALTH_CHECK_ID", "APPWRITE_FUNCTION_GITHUB_PR_REVIEWER_ID",
    "APPWRITE_FUNCTION_GITHUB_PROFILE_INSIGHTS_ID", "APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID", "APP_ID", "PRIVATE_KEY",
    "WEBHOOK_SECRET", "NVIDIA_API_KEY",
  ].map((name) => [name, `${name}-value`]));
  assert.deepEqual(missingRequiredVariables(values), []);
  assert.equal(values.WEBHOOK_DATABASE_ID, "WEBHOOK_DATABASE_ID-value");
  assert.equal(values.WEBHOOK_DELIVERY_COLLECTION_ID, "WEBHOOK_DELIVERY_COLLECTION_ID-value");
});

test("resolves Website, Backend A, and Backend B client contexts", () => {
  const contexts = resolveAppwriteContexts({
    APPWRITE_SITE_ENDPOINT: "https://site.example/v1",
    APPWRITE_SITE_PROJECT_ID: "site-project",
    APPWRITE_SITE_API_KEY: "site-key",
    APPWRITE_BACKEND_A_ENDPOINT: "https://backend-a.example/v1",
    APPWRITE_BACKEND_A_PROJECT_ID: "backend-a-project",
    APPWRITE_BACKEND_A_API_KEY: "backend-a-key",
    APPWRITE_BACKEND_B_ENDPOINT: "https://backend-b.example/v1",
    APPWRITE_BACKEND_B_PROJECT_ID: "backend-b-project",
    APPWRITE_BACKEND_B_API_KEY: "backend-b-key",
  });
  assert.deepEqual(contexts.site, { endpoint: "https://site.example/v1", projectId: "site-project", apiKey: "site-key" });
  assert.deepEqual(contexts.backendA, { endpoint: "https://backend-a.example/v1", projectId: "backend-a-project", apiKey: "backend-a-key" });
  assert.deepEqual(contexts.backendB, { endpoint: "https://backend-b.example/v1", projectId: "backend-b-project", apiKey: "backend-b-key" });
});

test("free-tier Function limit is enforced per project", () => {
  assert.deepEqual(validateFunctionProjectLimits({ a: "backendA", b: "backendA", c: "backendB", d: "backendB" }), []);
  assert.match(validateFunctionProjectLimits({ a: "backendA", b: "backendA", c: "backendA" })[0], /at most 2/);
});

test("deployment scripts retain read-only Option A preflight checks", () => {
  const setup = fs.readFileSync(new URL("../scripts/setup-appwrite.ps1", import.meta.url), "utf8");
  const deploy = fs.readFileSync(new URL("../scripts/deploy-functions.ps1", import.meta.url), "utf8");
  for (const script of [setup, deploy]) {
    assert.match(script, /databases list/);
    assert.match(script, /list-collections/);
    assert.match(script, /WEBHOOK_DATABASE_ID/);
    assert.match(script, /WEBHOOK_DELIVERY_COLLECTION_ID/);
    assert.match(script, /appwrite-cli@6\.1\.0/);
  }
  assert.match(deploy, /functions list-variables --function-id/);
  assert.match(deploy, /functions create-variable --function-id/);
  assert.match(deploy, /functions update-variable --function-id/);
  assert.match(setup, /APPWRITE_BACKEND_A_PROJECT_ID/);
  assert.match(setup, /Backend A Appwrite project/);
  assert.match(setup, /Backend B/);
  assert.match(deploy, /contexts\[\$definition\.Project\]/);
  assert.match(deploy, /health-check.*Project = "backendB"/s);
  assert.doesNotMatch(deploy, /APPWRITE_FUNCTION_HEALTH_CHECK_ID.*backendA/);
});

test("dashboard setup creates or verifies only the dashboard Function", () => {
  const setup = fs.readFileSync(new URL("../scripts/setup-dashboard-project.ps1", import.meta.url), "utf8");
  assert.match(setup, /functions create/);
  assert.match(setup, /github-dashboard/);
  assert.doesNotMatch(setup, /projects create|projects delete|functions delete/);
});
