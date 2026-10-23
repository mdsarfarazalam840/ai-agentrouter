import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { applyPatchInWorkspace } from "../shared/lib/patch-workspace.js";
import { decodeValidationBundle } from "../shared/lib/validation-bundle.js";

const MAX_OUTPUT_BYTES = 16384;
const MAX_TIMEOUT_MS = 30000;
const SAFE_COMMANDS = new Map([
  ["npm test", ["test"]],
  ["npm run check", ["run", "check"]],
  ["npm run check:dashboard", ["run", "check:dashboard"]],
]);

function boundedOutput(value, maximum = MAX_OUTPUT_BYTES) {
  const text = typeof value === "string" ? value : "";
  let bytes = 0;
  let output = "";
  for (const character of text) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > maximum) break;
    output += character;
  }
  return output;
}

function sanitizeOutput(value) {
  return boundedOutput(String(value || "")
    .replace(/(NVIDIA_API_KEY|OPENROUTER_API_KEY|APPWRITE_API_KEY|PRIVATE_KEY|WEBHOOK_SECRET|GITHUB_TOKEN)\s*[:=]\s*[^\s\r\n]+/gi, "$1=[REDACTED]"));
}

export function decodeBundle(encoded) {
  if (typeof encoded !== "string" || !encoded.trim()) throw new Error("VALIDATION_BUNDLE_MISSING");
  return decodeValidationBundle(encoded);
}

function commandArgs(command) {
  if (!SAFE_COMMANDS.has(command)) throw new Error("TEST_COMMAND_NOT_ALLOWED");
  return SAFE_COMMANDS.get(command);
}

function runProcess(command, args, cwd, timeoutMs = MAX_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, env: { ...process.env, CI: "true" } });
    let output = "";
    const append = (chunk) => { output = sanitizeOutput(output + chunk.toString("utf8")); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : Number.isInteger(code) ? code : 1, output, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: sanitizeOutput(`${output}\n${error.message}`), timedOut: false });
    });
  });
}

async function materialize(workspace, snapshot, files) {
  for (const entry of snapshot.files || []) {
    if (entry.content === null) await rm(path.join(workspace, ...entry.path.split("/")), { force: true });
  }
  for (const [name, content] of Object.entries(files || {})) {
    const destination = path.join(workspace, ...name.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { encoding: "utf8" });
  }
}

export async function runValidationBundle({ bundle, workspace = process.cwd(), installDependencies = false }) {
  const command = bundle.patch.testCommand;
  const args = commandArgs(command);
  const result = await applyPatchInWorkspace({
    patch: bundle.patch,
    snapshot: bundle.snapshot,
    approved: true,
    timeoutMs: MAX_TIMEOUT_MS,
    outputBytes: MAX_OUTPUT_BYTES,
    runner: {
      run: async ({ files }) => {
        await materialize(workspace, bundle.snapshot, files);
        if (installDependencies) {
          const install = await runProcess("npm", ["ci", "--ignore-scripts"], workspace);
          if (install.exitCode !== 0) return install;
        }
        return runProcess("npm", args, workspace);
      },
    },
  });
  return { ...result, targetSha: bundle.targetSha, patchRevision: bundle.patch.patchRevision, command };
}

async function main() {
  const bundle = decodeBundle(process.env.PATCH_BUNDLE_B64);
  const expectedSha = String(process.env.EXPECTED_SHA || "");
  if (expectedSha && expectedSha !== bundle.targetSha) throw new Error("VALIDATION_BUNDLE_SHA_MISMATCH");
  const result = await runValidationBundle({ bundle, workspace: process.env.GITHUB_WORKSPACE || process.cwd(), installDependencies: process.env.RUNNER_INSTALL_DEPENDENCIES === "true" });
  const outputPath = process.env.VALIDATION_RESULT_PATH || "validation-result.json";
  await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify({ status: result.status, testsRun: result.testsRun, exitCode: result.exitCode ?? null, patchRevision: result.patchRevision })}\n`);
  if (result.status !== "validated") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) {
    const result = { status: "validation_failed", testsRun: false, error: error.message === "TEST_COMMAND_NOT_ALLOWED" ? error.message : "VALIDATION_BUNDLE_INVALID" };
    await writeFile(process.env.VALIDATION_RESULT_PATH || "validation-result.json", JSON.stringify(result, null, 2), "utf8");
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  }
}
