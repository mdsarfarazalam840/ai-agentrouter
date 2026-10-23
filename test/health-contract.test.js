import assert from "node:assert/strict";
import test from "node:test";
import healthHandler from "../functions/health-check/src/main.js";

test("health response exposes the stable contract and an ISO timestamp", async () => {
  let response;
  const result = await healthHandler({
    req: { path: "/health" },
    log() {},
    res: { json(body, status = 200) { response = { body, status }; return response; } },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ["message", "ok", "path", "provider", "service", "timestamp"]);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.path, "/health");
  assert.match(result.body.timestamp, /^\d{4}-\d\d-\d\dT/);
});
