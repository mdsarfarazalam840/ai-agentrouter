import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSafePatchPath, validatePatch } from "./patcher.js";

const MAX_FILE_BYTES = 12000;
const MAX_TOTAL_BYTES = 60000;
const MAX_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 16384;
const deniedParts = new Set([".git", ".svn", ".hg", ".opencode", "node_modules", ".env", "secrets", "credentials", ".npmrc", ".yarnrc", ".gitmodules", ".pnp.cjs"]);
const deniedNames = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa(?:\.pub)?|.*\.(?:pem|key|p12|pfx|secret))$/i;

function allowedPath(name) {
  if (!isSafePatchPath(name) || name.includes("\\") || name.includes(":")) return false;
  const parts = name.split("/");
  if (parts.some((part) => deniedParts.has(part.toLowerCase()) || deniedNames.test(part))) return false;
  if (parts[0].toLowerCase() === ".github" && parts[1]?.toLowerCase() === "workflows") return false;
  return true;
}

function safeText(value) {
  return typeof value === "string" && !/[\u0000-\u0008\u000e-\u001f\u007f]/u.test(value) && !value.includes("\ufffd");
}

function snapshotFiles(snapshot) {
  const source = snapshot?.files ?? snapshot?.paths;
  const entries = Array.isArray(source) ? source : source && typeof source === "object" ? Object.entries(source).map(([name, value]) =>
    typeof value === "string" ? { path: name, content: value } : { ...value, path: name }) : null;
  if (!entries || entries.length > 30) throw Error("INVALID_SNAPSHOT");
  const files = Object.create(null);
  let total = 0;
  for (const entry of entries) {
    const name = entry?.path;
    if (!allowedPath(name) || Object.hasOwn(files, name) || entry.truncated || entry.binary || entry.symlink || entry.isSymlink ||
      entry.type === "symlink" || entry.mode === "120000" || entry.mode === 0o120000) throw Error("INVALID_SNAPSHOT");
    // An explicit null content represents an absent file reserved for an add operation.
    if (entry.content !== null && !safeText(entry.content)) throw Error("INVALID_SNAPSHOT");
    const size = Buffer.byteLength(entry.content ?? "", "utf8");
    total += size;
    if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw Error("INVALID_SNAPSHOT");
    files[name] = entry.content;
  }
  return files;
}

function linesOf(content) {
  if (!content) return [];
  const rows = content.split("\n");
  const trailing = content.endsWith("\n");
  if (trailing) rows.pop();
  return rows.map((text, index) => ({ text, newline: index < rows.length - 1 || trailing }));
}

function applyUnifiedDiff(diff, source, declarations) {
  const rows = diff.replace(/\n$/, "").split("\n");
  const changed = Object.create(null);
  let index = 0;
  while (index < rows.length) {
    let gitPath;
    if (rows[index].startsWith("diff --git ")) {
      const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(rows[index++]);
      if (!match || match[1] !== match[2]) throw Error("INVALID_HUNK");
      gitPath = match[1];
      if (/^index [a-fA-F0-9]+\.\.[a-fA-F0-9]+(?: [0-7]{6})?$/.test(rows[index] || "")) index++;
      if (/^(?:new file mode|deleted file mode) [0-7]{6}$/.test(rows[index] || "")) index++;
    }
    const old = /^--- (?:a\/(.+)|\/dev\/null)$/.exec(rows[index++] || "");
    const next = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(rows[index++] || "");
    const name = old?.[1] || next?.[1];
    const operation = !old?.[1] ? "add" : !next?.[1] ? "delete" : "modify";
    if (!old || !next || !name || (old[1] && next[1] && old[1] !== next[1]) || gitPath && gitPath !== name ||
      !allowedPath(name) || !Object.hasOwn(source, name) || !declarations.some((file) => file.path === name && file.operation === operation) || Object.hasOwn(changed, name)) throw Error("INVALID_HUNK");
    const original = source[name];
    if (operation === "add" ? original !== null : typeof original !== "string") throw Error("INVALID_HUNK");
    const input = linesOf(original ?? "");
    const output = [];
    let cursor = 0;
    let count = 0;
    while (rows[index]?.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(rows[index++]);
      if (!match) throw Error("INVALID_HUNK");
      const [oldStart, oldCount, newStart, newCount] = [Number(match[1]), match[2] == null ? 1 : Number(match[2]), Number(match[3]), match[4] == null ? 1 : Number(match[4])];
      if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger) || oldStart < (oldCount ? 1 : 0) || newStart < (newCount ? 1 : 0)) throw Error("INVALID_HUNK");
      const offset = oldCount ? oldStart - 1 : oldStart;
      if (offset < cursor || offset > input.length) throw Error("INVALID_HUNK");
      output.push(...input.slice(cursor, offset));
      cursor = offset;
      if (output.length !== (newCount ? newStart - 1 : newStart)) throw Error("INVALID_HUNK");
      let consumed = 0, produced = 0;
      while (consumed < oldCount || produced < newCount) {
        const row = rows[index++];
        if (!row || !/^[ +\-]/.test(row)) throw Error("INVALID_HUNK");
        const kind = row[0];
        const noNewline = rows[index] === "\\ No newline at end of file";
        if (noNewline) index++;
        const line = { text: row.slice(1), newline: !noNewline };
        if (kind !== "+") {
          if (consumed++ >= oldCount || input[cursor]?.text !== line.text || input[cursor]?.newline !== line.newline) throw Error("INVALID_HUNK");
          cursor++;
        }
        if (kind !== "-") {
          if (produced++ >= newCount) throw Error("INVALID_HUNK");
          output.push(line);
        }
      }
      count++;
    }
    if (!count || rows[index] === "\\ No newline at end of file") throw Error("INVALID_HUNK");
    output.push(...input.slice(cursor));
    if (output.some((line, i) => !line.newline && i !== output.length - 1)) throw Error("INVALID_HUNK");
    const content = output.map(({ text, newline }) => text + (newline ? "\n" : "")).join("");
    if (operation === "delete" && content !== "" || operation === "add" && content === "" || operation === "modify" && content === original || !safeText(content) || Buffer.byteLength(content) > MAX_FILE_BYTES) throw Error("INVALID_HUNK");
    changed[name] = operation === "delete" ? null : content;
    if (index < rows.length && !rows[index].startsWith("--- ") && !rows[index].startsWith("diff --git ")) throw Error("INVALID_HUNK");
  }
  if (Object.keys(changed).length !== declarations.length) throw Error("INVALID_HUNK");
  return changed;
}

const bounded = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;

function boundedOutput(value, maximum) {
  if (typeof value !== "string") return "";
  let bytes = 0;
  let output = "";
  for (const character of value) {
    bytes += Buffer.byteLength(character);
    if (bytes > maximum) break;
    output += character;
  }
  return output;
}

/**
 * Validate in memory, then hand a sanitized file map to a SERVER-OWNED isolated
 * runner. The temporary directory is staging only, never an execution sandbox.
 * The runner must independently enforce command, resource, isolation and timeout
 * limits; never pass a runner from an HTTP request, model output, or browser.
 */
export async function applyPatchInWorkspace({ patch, snapshot, approved, runner, timeoutMs, outputBytes } = {}) {
  const validation = validatePatch(patch, snapshot ?? {});
  if (!validation.ok) return { status: "validation_failed", error: validation.error, testsRun: false };
  if (!patch.files.length || !patch.diff.trim()) return { status: "validation_failed", error: "EMPTY_PATCH", testsRun: false };
  if (approved !== true) return { status: "not_run", error: "APPROVAL_REQUIRED", testsRun: false };
  let files;
  let changed;
  try {
    files = snapshotFiles(snapshot);
    changed = applyUnifiedDiff(patch.diff, files, patch.files);
  } catch {
    return { status: "validation_failed", error: "INVALID_WORKSPACE_PATCH", testsRun: false };
  }
  if (!runner || typeof runner.run !== "function") return { status: "validation_unavailable", error: "TRUSTED_RUNNER_UNAVAILABLE", testsRun: false };
  const limits = { timeoutMs: bounded(timeoutMs, MAX_TIMEOUT_MS, MAX_TIMEOUT_MS), outputBytes: bounded(outputBytes, MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES) };
  const materialized = Object.assign(Object.create(null), files, changed);
  for (const [name, content] of Object.entries(materialized)) if (content === null) delete materialized[name];
  let directory;
  let runnerStarted = false;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "patch-workspace-"));
    for (const [name, content] of Object.entries(materialized)) {
      const destination = path.join(directory, ...name.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: "wx", mode: 0o600 });
    }
    // Deliberately no spawn, shell, inherited environment, or local execution.
    const run = Promise.resolve().then(() => {
      runnerStarted = true;
      return runner.run({ files: { ...materialized }, command: patch.testCommand, ...limits });
    });
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Error("TEST_TIMEOUT")), limits.timeoutMs); });
    try {
      const result = await Promise.race([run, deadline]);
      if (!result || !Number.isInteger(result.exitCode)) return { status: "test_failed", error: "INVALID_RUNNER_RESULT", testsRun: true };
      const output = boundedOutput(result.output, limits.outputBytes);
      return { status: result.exitCode === 0 ? "validated" : "test_failed", exitCode: result.exitCode, output, testsRun: true };
    } finally { clearTimeout(timer); }
  } catch (error) {
    return { status: runnerStarted ? "test_failed" : "validation_failed", error: error?.message === "TEST_TIMEOUT" ? "TEST_TIMEOUT" : "VALIDATION_FAILED", testsRun: runnerStarted };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
