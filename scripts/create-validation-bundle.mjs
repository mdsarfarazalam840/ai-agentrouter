import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { normalizePatch, validatePatch } from "../shared/lib/patcher.js";

const exec = promisify(execFile);

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function sha256(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24); }

const targetSha = arg("--target-sha");
const filePath = arg("--path", `runner-fixtures/validation-${Date.now()}.txt`);
const content = arg("--content", "GitHub-hosted runner validation\n");
const testCommand = arg("--test-command", "npm run check");
if (!/^[a-f0-9]{40}$/i.test(targetSha)) throw new Error("--target-sha must be a 40-character commit SHA");
if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(filePath) || filePath.startsWith(".github/") || filePath.includes("..")) throw new Error("unsafe validation path");
if (!["npm test", "npm run check", "npm run check:dashboard"].includes(testCommand)) throw new Error("unsupported test command");

const packageJson = JSON.parse((await exec("git", ["show", `${targetSha}:package.json`])).stdout);
const files = [{ path: filePath, content: null }];
const snapshot = { baseSha: targetSha, files, packageJson };
snapshot.revision = sha256({ baseSha: targetSha, files });
const diffLines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
const diff = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${diffLines.length} @@\n${diffLines.map((line) => `+${line}`).join("\n")}\n`;
const patch = normalizePatch({ summary: "Dynamic GitHub-hosted runner smoke validation", files: [{ path: filePath, operation: "add", reason: "runner smoke fixture", additions: diffLines.length, deletions: 0 }], diff, implementationNotes: ["Generated only for the disposable runner smoke test"], risks: [], testCommand }, { issueRevision: "runner-smoke", planRevision: "runner-smoke", snapshotRevision: snapshot.revision, provider: null, model: null, createdAt: new Date().toISOString() });
const validation = validatePatch(patch, snapshot);
if (!validation.ok) throw new Error(validation.error);
const bundle = { version: 1, targetSha, patch, snapshot };
process.stdout.write(Buffer.from(JSON.stringify(bundle), "utf8").toString("base64url"));
