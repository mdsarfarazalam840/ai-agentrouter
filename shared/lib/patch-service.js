import crypto from "node:crypto";
import { TextDecoder } from "node:util";
import { createPatch, isSafePatchPath, validatePatch } from "./patcher.js";
import { applyPatchInWorkspace } from "./patch-workspace.js";
import { assertPatchEnvelopeSize } from "./dashboard-store.js";
import { listIssueComments } from "./github.js";

const TTL_MS = 60 * 60 * 1000;
const MAX_FILE_BYTES = 12000;
const MAX_TOTAL_BYTES = 60000;
const sha256 = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const failure = (code, status = 409) => Object.assign(new Error(code), { code, status });
const record = (item) => item?.data || item;

// Ignore command/acknowledgement chatter; retain substantive human discussion.
export async function patchIssueRevision({ octokit, owner, repo, issueNumber, issue }) {
  let comments;
  try { comments = await listIssueComments({ octokit, owner, repo, issueNumber }); }
  catch { throw failure("ISSUE_CONTEXT_INCOMPLETE", 503); }
  return sha256({ id: issue.id || issue.number, title: issue.title, body: issue.body,
    comments: comments.filter((item) => item.user?.type !== "Bot" && !/^\s*\/(?:plan|patch)(?:\s|$)/i.test(item.body || "") && !/<!-- ai-agentrouter:(?:issue-plan|issue-patch):/.test(item.body || ""))
      .map((item) => ({ id: item.id, body: item.body, updatedAt: item.updated_at })) });
}

// The plan's paths are candidates, never a license to read arbitrary paths from a request.
export async function capturePatchSnapshot({ octokit, owner, repo, plan }) {
  const paths = [...new Set((plan.affectedFiles || []).map((file) => file.path))];
  if (!paths.length || paths.length > 30 || paths.some((path) => !isSafePatchPath(path) || path.includes("\\") || path.includes(":") || /(^|\/)(?:\.git|\.github\/workflows|\.opencode|node_modules|\.npmrc|\.gitmodules|secrets?|credentials)(\/|$)/i.test(path))) throw failure("INVALID_PLAN_FILES");
  const repository = (await octokit.repos.get({ owner, repo })).data;
  const branch = repository?.default_branch;
  if (!branch) throw failure("SNAPSHOT_UNAVAILABLE", 503);
  const commit = (await octokit.repos.getCommit({ owner, repo, ref: branch })).data;
  const baseSha = commit?.sha;
  if (!/^[a-f0-9]{40}$/i.test(baseSha || "")) throw failure("SNAPSHOT_UNAVAILABLE", 503);
  const files = [];
  let total = 0;
  for (const path of paths) {
    let data;
    try { data = (await octokit.repos.getContent({ owner, repo, path, ref: baseSha })).data; }
    catch (error) { if (error.status !== 404) throw failure("SNAPSHOT_UNAVAILABLE", 503); data = null; }
    if (data === null) { files.push({ path, content: null }); continue; }
    if (!data || Array.isArray(data) || data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string" || data.truncated || data.size > MAX_FILE_BYTES || data.mode === "120000") throw failure("INVALID_SNAPSHOT");
    const encoded = data.content.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw failure("INVALID_SNAPSHOT");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== data.size || bytes.length > MAX_FILE_BYTES) throw failure("INVALID_SNAPSHOT");
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw failure("INVALID_SNAPSHOT");
    let content;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw failure("INVALID_SNAPSHOT"); }
    if (/[\u0000-\u0008\u000e-\u001f\u007f\ufffd]/u.test(content)) throw failure("INVALID_SNAPSHOT");
    files.push({ path, content });
  }
  let packageJson = {};
  const packageFile = files.find((file) => file.path === "package.json" && file.content);
  if (packageFile) { try { packageJson = JSON.parse(packageFile.content); } catch { throw failure("INVALID_SNAPSHOT"); } }
  const revision = sha256({ baseSha, files });
  return { baseSha, revision, files, packageJson };
}

function ensureIdentity({ owner, repo, issueNumber }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner || "") || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repo || "") || !Number.isSafeInteger(Number(issueNumber)) || Number(issueNumber) < 1) throw failure("INVALID_PATCH_REQUEST", 400);
  return { owner, repo, issueNumber: Number(issueNumber), fullName: `${owner}/${repo}` };
}

export function createPatchService({ octokit, store, generate = createPatch, capture = capturePatchSnapshot, apply = applyPatchInWorkspace, clock = () => Date.now(), logger = () => {} }) {
  async function current(input) {
    const identity = ensureIdentity(input);
    const { owner, repo, issueNumber, fullName } = identity;
    const issue = (await octokit.issues.get({ owner, repo, issue_number: issueNumber })).data;
    if (!issue || issue.pull_request) throw failure("ISSUE_UNAVAILABLE", 404);
    const revision = await patchIssueRevision({ octokit, owner, repo, issueNumber, issue });
    const plans = await store.listPlans({ fullName, issueNumber });
    const latest = record(plans[0]);
    const plan = latest?.plan;
    if (!plan || latest.fullName !== fullName || Number(latest.issueNumber) !== issueNumber || plan.issueRevision !== revision || plan.repository !== fullName || Number(plan.issueNumber) !== issueNumber) throw failure("CURRENT_PLAN_REQUIRED");
    const snapshot = await capture({ octokit, owner, repo, plan });
    const planRevision = plan.planRevision || sha256(plan);
    return { ...identity, issue, revision, plan, planRevision, snapshot };
  }

  const matching = (patch, state) => patch.issueRevision === state.revision && patch.planRevision === state.planRevision && patch.snapshotRevision === state.snapshot.revision;
  const recent = (patch) => Number.isFinite(Date.parse(patch.createdAt)) && clock() - Date.parse(patch.createdAt) >= 0 && clock() - Date.parse(patch.createdAt) <= TTL_MS;
  async function records(state) { return (await store.listPatches({ fullName: state.fullName, issueNumber: state.issueNumber })).map(record); }
  async function proposal(input = {}) {
    const state = await current(input);
    const existing = await records(state);
    if (!input.refresh) {
      const latest = existing[0];
      if (latest?.patch?.status === "proposed" && matching(latest.patch, state) && recent(latest.patch) && validatePatch(latest.patch, state.snapshot).ok) return { patch: latest.patch, patchId: latest.$id, cached: true };
    }
    let patch;
    try { patch = await generate({ plan: state.plan, context: state.snapshot, packageJson: state.snapshot.packageJson, logger }); }
    catch (error) { if (error?.message === "PATCH_PAYLOAD_TOO_LARGE" || error?.message === "DIFF_TOO_LARGE") throw failure("PATCH_PAYLOAD_TOO_LARGE", 400); throw error; }
    if (!matching(patch, state) || !validatePatch(patch, state.snapshot).ok) throw failure("INVALID_PATCH_PROPOSAL");
    try { assertPatchEnvelopeSize(patch, { status: "validation_unavailable", testsRun: false, error: "TRUSTED_RUNNER_UNAVAILABLE" }); } catch { throw failure("PATCH_PAYLOAD_TOO_LARGE", 400); }
    // The provider call is long-lived: re-fetch all revision inputs before writing.
    const fresh = await current(input);
    if (fresh.revision !== state.revision || fresh.planRevision !== state.planRevision || fresh.snapshot.revision !== state.snapshot.revision || fresh.snapshot.baseSha !== state.snapshot.baseSha) throw failure("PATCH_STALE");
    let saved;
    try { saved = record(await store.persistPatch({ fullName: state.fullName, issueNumber: state.issueNumber, issueTitle: state.issue.title, patch })); }
    catch (error) { if (error?.message === "PATCH_PAYLOAD_TOO_LARGE") throw failure("PATCH_PAYLOAD_TOO_LARGE", 400); throw error; }
    if (!saved?.$id || saved.patch?.patchRevision !== patch.patchRevision) throw failure("PATCH_PERSISTENCE_UNAVAILABLE", 503);
    return { patch, patchId: saved.$id, cached: false };
  }

  async function transition(input, action) {
    if (typeof input.patchId !== "string" || !/^[A-Za-z0-9._-]{1,36}$/.test(input.patchId) || typeof input.patchRevision !== "string" || !/^[a-f0-9]{24}$/.test(input.patchRevision)) throw failure("INVALID_PATCH_REQUEST", 400);
    if (action === "validate" && input.approved !== true) throw failure("APPROVAL_REQUIRED", 400);
    const state = await current(input);
    const stored = record(await store.getPatch({ fullName: state.fullName, issueNumber: state.issueNumber, id: input.patchId, patchRevision: input.patchRevision }));
    const patch = stored?.patch;
    if (!patch || patch.status !== "proposed" || !matching(patch, state) || !recent(patch) || !validatePatch(patch, state.snapshot).ok) throw failure("PATCH_STALE");
    const all = await records(state);
    if (all[0]?.$id !== input.patchId || all[0]?.patch?.patchRevision !== input.patchRevision || all[0]?.patch?.status !== "proposed") throw failure("PATCH_STALE");
    const validation = action === "validate" ? await apply({ patch, snapshot: state.snapshot, approved: true }) : undefined;
    const status = action === "reject" ? "rejected" : ["validated", "validation_unavailable", "test_failed", "validation_failed"].includes(validation?.status) ? validation.status : "validation_failed";
    const updated = { ...patch, status };
    try { assertPatchEnvelopeSize(updated, validation); } catch { throw failure("PATCH_PAYLOAD_TOO_LARGE", 400); }
    let saved;
    try { saved = record(await store.persistPatch({ fullName: state.fullName, issueNumber: state.issueNumber, issueTitle: state.issue.title, patch: updated, validation })); }
    catch (error) { if (error?.message === "PATCH_PAYLOAD_TOO_LARGE") throw failure("PATCH_PAYLOAD_TOO_LARGE", 400); throw error; }
    if (!saved?.$id || saved.patch?.status !== status) throw failure("PATCH_PERSISTENCE_UNAVAILABLE", 503);
    return { patch: updated, patchId: saved.$id, ...(validation ? { validation } : {}) };
  }
  return { propose: proposal, validate: (input) => transition(input, "validate"), reject: (input) => transition(input, "reject") };
}
