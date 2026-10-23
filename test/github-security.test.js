import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { verifyWebhookSignature } from "../shared/lib/github.js";

test("signature verification uses exact raw bytes", () => {
  const body = Buffer.from('{"action":"opened"}\n');
  const signature = `sha256=${crypto.createHmac("sha256", "secret").update(body).digest("hex")}`;
  assert.equal(verifyWebhookSignature({ headers: { "x-hub-signature-256": signature }, bodyRaw: body, secret: "secret" }), true);
  assert.equal(verifyWebhookSignature({ headers: { "x-hub-signature-256": signature }, bodyRaw: Buffer.from(body.toString().trim()), secret: "secret" }), false);
});

test("missing or invalid signatures fail closed", () => {
  assert.equal(verifyWebhookSignature({ headers: {}, bodyRaw: "{}", secret: "secret" }), false);
  assert.equal(verifyWebhookSignature({ headers: { "x-hub-signature-256": "sha256=bad" }, bodyRaw: "{}", secret: "secret" }), false);
});
