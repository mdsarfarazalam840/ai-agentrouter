import crypto from "node:crypto";
import { callLLM } from "./llm.js";
import { buildIssuePatchPrompt } from "./prompts.js";
import { assertPatchEnvelopeSize } from "./dashboard-store.js";

const MAX_DIFF = 12000;
const MAX_FILES = 30;
const MAX_LIST = 12;
const MAX_TEXT = 12000;
const MAX_FIELD = 2000;
const OPERATIONS = new Set(["modify", "add", "delete"]);
const SAFE_COMMANDS = new Set(["npm test", "npm run check", "npm run check:dashboard"]);

const text = (value, maximum = MAX_TEXT, fallback = "") => typeof value === "string" ? value.slice(0, maximum) : fallback;
const list = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.slice(0, MAX_FIELD)).slice(0, MAX_LIST) : [];

function parseValue(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value.replace(/^```json\s*|```$/g, "").trim()); } catch { throw new Error("INVALID_PATCH_JSON"); }
}

function patchObject(value) {
  const item = parseValue(value);
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("INVALID_PATCH_JSON");
  return item;
}

function operation(value) {
  const normalized = String(value || "").toLowerCase();
  return ({ update: "modify", edit: "modify", create: "add", remove: "delete" })[normalized] || normalized;
}

function canonicalPatch(patch) {
  return {
    summary: patch.summary,
    issueRevision: patch.issueRevision,
    planRevision: patch.planRevision,
    snapshotRevision: patch.snapshotRevision,
    files: patch.files,
    diff: patch.diff,
    implementationNotes: patch.implementationNotes,
    risks: patch.risks,
    testCommand: patch.testCommand,
    provider: patch.provider,
    model: patch.model,
  };
}

export function patchRevision(patch = {}) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalPatch(patch))).digest("hex").slice(0, 24);
}

export function normalizePatch(value, metadata = {}) {
  const item = patchObject(value);
  if (typeof item.diff === "string" && item.diff.length > MAX_DIFF) throw new Error("DIFF_TOO_LARGE");
  const files = Array.isArray(item.files) ? item.files.slice(0, MAX_FILES).map((file) => ({
    path: text(file?.path, MAX_FIELD),
    operation: operation(file?.operation),
    reason: text(file?.reason, MAX_FIELD),
    additions: Number.isInteger(file?.additions) && file.additions >= 0 ? file.additions : 0,
    deletions: Number.isInteger(file?.deletions) && file.deletions >= 0 ? file.deletions : 0,
  })) : [];
  const patch = {
    summary: text(item.summary, MAX_TEXT, "No summary was generated."),
    issueRevision: text(metadata.issueRevision, MAX_FIELD, ""),
    planRevision: text(metadata.planRevision, MAX_FIELD, ""),
    snapshotRevision: text(metadata.snapshotRevision, MAX_FIELD, ""),
    patchRevision: "",
    files,
    diff: text(item.diff, MAX_DIFF),
    implementationNotes: list(item.implementationNotes),
    risks: list(item.risks),
    testCommand: text(item.testCommand, MAX_FIELD, "npm test"),
    provider: metadata.provider == null ? null : text(metadata.provider, MAX_FIELD),
    model: metadata.model == null ? null : text(metadata.model, MAX_FIELD),
    status: "proposed",
    createdAt: text(metadata.createdAt, MAX_FIELD, new Date().toISOString()),
  };
  patch.patchRevision = patchRevision(patch);
  assertPatchEnvelopeSize(patch, { status: "validation_unavailable", testsRun: false, error: "TRUSTED_RUNNER_UNAVAILABLE" });
  return patch;
}

export function isSafePatchPath(filePath) {
  if (typeof filePath !== "string" || !filePath || filePath.includes("\0")) return false;
  if (filePath.startsWith("/") || filePath.startsWith("\\") || /^[A-Za-z]:/.test(filePath)) return false;
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) return false;
  const basename = normalized.split("/").pop().toLowerCase();
  if (basename === ".env" || basename.startsWith(".env.") || /^(credentials|secrets?|.*\.pem|.*\.key)(\.|$)/i.test(basename)) return false;
  return normalized.split("/").every((part) => part && part !== ".");
}

function likelyBinary(value) {
  return typeof value !== "string" || value.includes("\0") || [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 9 || (code > 13 && code < 32);
  });
}

function snapshotPaths(snapshot = {}) {
  const files = snapshot.files ?? snapshot.paths ?? snapshot;
  if (Array.isArray(files)) return new Set(files.map((file) => typeof file === "string" ? file : file?.path));
  if (files && typeof files === "object") return new Set(Object.keys(files));
  return new Set();
}

function diffTargets(diff) {
  if (!diff) return [];
  const lines = diff.replace(/\n$/, "").split("\n");
  const targets = [];
  let index = 0;
  while (index < lines.length) {
    let gitPaths = null;
    if (lines[index].startsWith("diff --git ")) {
      const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[index++]);
      if (!match) return null;
      gitPaths = [match[1], match[2]];
      if (lines[index] && /^index [a-fA-F0-9]+\.\.[a-fA-F0-9]+(?: [0-7]{6})?$/.test(lines[index])) index++;
      if (lines[index] && /^(?:new file mode|deleted file mode) [0-7]{6}$/.test(lines[index])) index++;
    }
    const oldMatch = /^--- (a\/(.+)|\/dev\/null)$/.exec(lines[index++] || "");
    const newMatch = /^\+\+\+ (b\/(.+)|\/dev\/null)$/.exec(lines[index++] || "");
    if (!oldMatch || !newMatch || (oldMatch[2] && newMatch[2] && oldMatch[2] !== newMatch[2])) return null;
    const path = oldMatch[2] || newMatch[2];
    if (!path || !isSafePatchPath(path) || (gitPaths && (gitPaths[0] !== path || gitPaths[1] !== path))) return null;
    const operation = !oldMatch[2] ? "add" : !newMatch[2] ? "delete" : "modify";
    let hunks = 0;
    while (index < lines.length && lines[index].startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[index++]);
      if (!match) return null;
      let oldRemaining = match[2] == null ? 1 : Number(match[2]);
      let newRemaining = match[4] == null ? 1 : Number(match[4]);
      if (!Number.isSafeInteger(oldRemaining) || !Number.isSafeInteger(newRemaining)) return null;
      hunks++;
      while (oldRemaining || newRemaining) {
        const line = lines[index++];
        if (line == null) return null;
        if (line.startsWith(" ")) { oldRemaining--; newRemaining--; }
        else if (line.startsWith("-")) oldRemaining--;
        else if (line.startsWith("+")) newRemaining--;
        else return null;
        if (oldRemaining < 0 || newRemaining < 0) return null;
        if (lines[index] === "\\ No newline at end of file") index++;
      }
      if (lines[index] === "\\ No newline at end of file") return null;
    }
    if (!hunks) return null;
    targets.push({ path, operation });
    if (index < lines.length && !lines[index].startsWith("--- ") && !lines[index].startsWith("diff --git ")) return null;
  }
  return targets;
}

export function isAllowedTestCommand(command, packageJson = {}) {
  if (typeof command !== "string" || !/^[a-z0-9:._-]+(?:\s+[a-z0-9:._-]+)*$/i.test(command)) return false;
  if (SAFE_COMMANDS.has(command)) return true;
  const scripts = packageJson && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const match = command.match(/^npm run ([a-z0-9:._-]+)$/i);
  return Boolean(match && Object.prototype.hasOwnProperty.call(scripts, match[1]));
}

export function validatePatch(patch, snapshot = {}) {
  if (!patch || typeof patch !== "object") return { ok: false, error: "INVALID_PATCH" };
  const boundedString = (value, maximum) => typeof value === "string" && value.length <= maximum;
  if (!boundedString(patch.summary, MAX_TEXT)) return { ok: false, error: "INVALID_SUMMARY" };
  for (const field of ["issueRevision", "planRevision", "snapshotRevision", "testCommand", "createdAt"]) {
    if (!boundedString(patch[field], MAX_FIELD)) return { ok: false, error: "INVALID_METADATA" };
  }
  for (const field of ["provider", "model"]) {
    if (patch[field] !== null && !boundedString(patch[field], MAX_FIELD)) return { ok: false, error: "INVALID_METADATA" };
  }
  for (const field of ["implementationNotes", "risks"]) {
    if (!Array.isArray(patch[field]) || patch[field].length > MAX_LIST || patch[field].some((item) => !boundedString(item, MAX_FIELD))) {
      return { ok: false, error: "INVALID_LIST" };
    }
  }
  if (patch.status !== "proposed") return { ok: false, error: "INVALID_STATUS" };
  if (typeof patch.patchRevision !== "string" || patch.patchRevision !== patchRevision(patch)) return { ok: false, error: "PATCH_REVISION_MISMATCH" };
  if (typeof patch.diff !== "string" || patch.diff.length > MAX_DIFF || likelyBinary(patch.diff)) return { ok: false, error: "INVALID_DIFF" };
  try { assertPatchEnvelopeSize(patch, { status: "validation_unavailable", testsRun: false, error: "TRUSTED_RUNNER_UNAVAILABLE" }); } catch { return { ok: false, error: "PATCH_PAYLOAD_TOO_LARGE" }; }
  if (!Array.isArray(patch.files) || patch.files.length > MAX_FILES) return { ok: false, error: "INVALID_FILES" };
  const paths = snapshotPaths(snapshot);
  for (const file of patch.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) return { ok: false, error: "INVALID_FILES" };
    if (!boundedString(file.path, MAX_FIELD) || !boundedString(file.reason, MAX_FIELD) ||
      !Number.isInteger(file.additions) || file.additions < 0 || !Number.isInteger(file.deletions) || file.deletions < 0) {
      return { ok: false, error: "INVALID_FILES" };
    }
    if (!isSafePatchPath(file?.path)) return { ok: false, error: "UNSAFE_PATCH_PATH" };
    if (!OPERATIONS.has(file.operation)) return { ok: false, error: "UNSUPPORTED_OPERATION" };
    if (!paths.has(file.path)) return { ok: false, error: "FILE_NOT_IN_SNAPSHOT" };
  }
  const targets = diffTargets(patch.diff);
  if (!targets) return { ok: false, error: "INVALID_DIFF" };
  if (targets.length !== patch.files.length || new Set(targets.map(({ path }) => path)).size !== targets.length ||
    targets.some(({ path, operation }) => !paths.has(path) || !patch.files.some((file) => file.path === path && file.operation === operation)) ||
    new Set(patch.files.map((file) => file.path)).size !== patch.files.length) {
    return { ok: false, error: "DIFF_TARGET_MISMATCH" };
  }
  if (!isAllowedTestCommand(patch.testCommand, snapshot.packageJson || snapshot.package || {})) return { ok: false, error: "TEST_COMMAND_NOT_ALLOWED" };
  const snapshotRevision = snapshot.revision ?? snapshot.snapshotRevision;
  if (snapshotRevision != null && patch.snapshotRevision !== snapshotRevision) return { ok: false, error: "SNAPSHOT_REVISION_MISMATCH" };
  return { ok: true, patch };
}

function planRevision(plan) {
  if (typeof plan.planRevision === "string" && plan.planRevision) return plan.planRevision;
  return crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 24);
}

function snapshotForValidation(context, packageJson) {
  return { ...context, packageJson: packageJson || context?.packageJson || context?.package || {} };
}

export async function createPatch({ plan, context = {}, packageJson = {}, logger = () => {} } = {}) {
  if (!plan || typeof plan !== "object") throw new Error("MISSING_ISSUE_PLAN");
  let invocationMetadata = null;
  const content = await callLLM([{ role: "user", content: buildIssuePatchPrompt(plan, context) }], {
    temperature: 0.1,
    top_p: 0.8,
    max_tokens: 2400,
    enableThinking: false,
    providerTimeoutMs: 45000,
    responseFormat: { type: "json_object" },
    errorLogger: logger,
    task: "issue_patch",
    onInvocation: (metadata) => { invocationMetadata = metadata; },
  });
  const item = patchObject(content);
  if (Array.isArray(item.files)) {
    item.diff = typeof item.diff === "string" ? item.diff : item.files.map((file) => file?.diff || "").filter(Boolean).join("\n");
  }
  const patch = normalizePatch(item, {
    issueRevision: plan.issueRevision || "",
    planRevision: planRevision(plan),
    snapshotRevision: context.revision ?? context.snapshotRevision ?? "",
    provider: invocationMetadata?.provider || null,
    model: invocationMetadata?.model || null,
  });
  const result = validatePatch(patch, snapshotForValidation(context, packageJson));
  if (!result.ok) throw new Error(result.error);
  return result.patch;
}
