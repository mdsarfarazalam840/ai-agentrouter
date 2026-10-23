import crypto from "node:crypto";

export const VALIDATION_COMMANDS = new Set(["npm test", "npm run check", "npm run check:dashboard"]);
const MAX_BUNDLE_CHARS = 250000;

function fail(code) { throw new Error(code); }

export function createValidationBundle({ targetSha, patch, snapshot } = {}) {
  if (!/^[a-f0-9]{40}$/i.test(targetSha || "") || snapshot?.baseSha !== targetSha) fail("VALIDATION_BUNDLE_SHA_MISMATCH");
  if (!patch || typeof patch !== "object" || !VALIDATION_COMMANDS.has(patch.testCommand)) fail("TEST_COMMAND_NOT_ALLOWED");
  if (!snapshot || !Array.isArray(snapshot.files) || typeof snapshot.revision !== "string") fail("VALIDATION_BUNDLE_INVALID");
  const bundle = {
    version: 1,
    targetSha,
    patch,
    snapshot: { baseSha: snapshot.baseSha, revision: snapshot.revision, files: snapshot.files },
  };
  const encoded = Buffer.from(JSON.stringify(bundle), "utf8").toString("base64url");
  if (encoded.length > MAX_BUNDLE_CHARS) fail("VALIDATION_BUNDLE_TOO_LARGE");
  return encoded;
}

export function decodeValidationBundle(encoded) {
  if (typeof encoded !== "string" || !encoded.trim() || encoded.length > MAX_BUNDLE_CHARS) fail("VALIDATION_BUNDLE_INVALID");
  let bundle;
  try { bundle = JSON.parse(Buffer.from(encoded.trim(), "base64url").toString("utf8")); }
  catch { fail("VALIDATION_BUNDLE_INVALID"); }
  if (!bundle || typeof bundle !== "object" || !bundle.patch || !bundle.snapshot || typeof bundle.targetSha !== "string") fail("VALIDATION_BUNDLE_INVALID");
  if (!/^[a-f0-9]{40}$/i.test(bundle.targetSha) || bundle.snapshot.baseSha !== bundle.targetSha) fail("VALIDATION_BUNDLE_SHA_MISMATCH");
  if (!VALIDATION_COMMANDS.has(bundle.patch.testCommand)) fail("TEST_COMMAND_NOT_ALLOWED");
  return bundle;
}

export function validationCorrelationId(patchId, patchRevision) {
  return `patch-${crypto.createHash("sha256").update(`${patchId}:${patchRevision}`).digest("hex").slice(0, 24)}`;
}
