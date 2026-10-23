import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDashboardHandler } from '../functions/github-dashboard/src/main.js';
import { createDashboardStore, assertPatchEnvelopeSize } from '../shared/lib/dashboard-store.js';
import { normalizePatch } from '../shared/lib/patcher.js';
import { patchIssueRevision, createPatchService } from '../shared/lib/patch-service.js';

const headers = { 'x-appwrite-user-id': 'operator', 'x-appwrite-user-jwt': 'session' };
async function withEnvironment(values, callback) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) value === null ? delete process.env[key] : process.env[key] = value;
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}
function request(handler, body) {
  let answer;
  return handler({ req: { headers, bodyJson: body }, res: { json(value, status = 200) { answer = { value, status }; return answer; } }, log() {} }).then(() => answer);
}

test('real stored plan envelope appears with its stable ID in issues and overview; malformed/cross-repository plan is not exposed', async () => withEnvironment({ DASHBOARD_ALLOWED_USER_IDS: 'operator', GITHUB_PATCH_ALLOWED_REPOSITORIES: 'owner/repo' }, async () => {
  const good = { $id: 'plan-id', command: 'plan', repository: 'owner/repo', fullName: 'owner/repo', issueNumber: 9, response: JSON.stringify({ kind: 'plan', plan: { repository: 'owner/repo', issueNumber: 9, issueRevision: 'abc', summary: 'Implement fix' } }) };
  const store = { listIssues: async () => [good, { ...good, $id: 'wrong', response: JSON.stringify({ kind: 'plan', plan: { repository: 'other/repo', issueNumber: 9, summary: 'secret' } }) }], listReviews: async () => [], listFindings: async () => [], listDeliveries: async () => [] };
  const handler = createDashboardHandler({ makeStore: () => store });
  for (const action of ['issues', 'overview']) {
    const result = await request(handler, { action });
    assert.equal(result.status, 200);
    assert.equal(result.value.issues[0].plan.summary, 'Implement fix');
    assert.equal(result.value.issues[0].planId, 'plan-id');
    assert.equal(result.value.issues[0].response, undefined);
    assert.equal(result.value.issues[1].plan, undefined);
  }
  const ui = await readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  assert.match(ui, /View stored plan/);
  assert.match(ui, /renderPlan\(\{ \.\.\.plan, repository: issue\.fullName/);
  assert.match(ui, /callDashboard\('patch-history'/);
  assert.match(ui, /button\.addEventListener\('click', \(\) => plan \? renderPlan/);
}));

test('direct plan cache checks canonical comment-aware revision and rejects stale plans', async () => withEnvironment({ DASHBOARD_ALLOWED_USER_IDS: 'operator', GITHUB_PATCH_ALLOWED_REPOSITORIES: 'owner/repo', GITHUB_APP_INSTALLATION_ID: '1' }, async () => {
  const issue = { id: 3, number: 9, title: 'Fix', body: 'original' };
  const octokit = { issues: { get: async () => ({ data: issue }), listComments: async () => ({ data: [{ id: 7, body: 'substantive', updated_at: 'today', user: { type: 'User' } }] }) } };
  const revision = await patchIssueRevision({ octokit, owner: 'owner', repo: 'repo', issueNumber: 9, issue });
  let reads = 0;
  const store = { listPlans: async () => { reads++; return [{ $id: 'plan-record', fullName: 'owner/repo', issueNumber: 9, plan: { repository: 'owner/repo', issueNumber: 9, issueRevision: revision, summary: 'cached' } }]; } };
  const handler = createDashboardHandler({ makeStore: () => store, makeClient: () => octokit });
  const first = await request(handler, { action: 'plan', repository: 'owner/repo', issueNumber: 9 });
  assert.equal(first.value.planId, 'plan-record');
  assert.equal(first.value.cached, true);
  issue.body = 'changed';
  const stale = await request(handler, { action: 'plan', repository: 'owner/repo', issueNumber: 9 });
  assert.notEqual(stale.value.cached, true);
  assert.equal(reads, 2);
}));

test('generated dashboard plans return the persisted deterministic plan ID', async () => withEnvironment({ DASHBOARD_ALLOWED_USER_IDS: 'operator', GITHUB_PATCH_ALLOWED_REPOSITORIES: 'owner/repo', GITHUB_APP_INSTALLATION_ID: '1' }, async () => {
  const issue = { id: 3, number: 9, title: 'Fix', body: 'original' };
  const octokit = { issues: { get: async () => ({ data: issue }), listComments: async () => ({ data: [] }) } };
  const store = { listPlans: async () => [], persistPlan: async () => ({ $id: 'plan-deterministic' }) };
  const handler = createDashboardHandler({ makeStore: () => store, makeClient: () => octokit, makePlan: async () => ({ summary: 'generated', implementationSteps: ['change it'], testPlan: ['test it'] }) });
  const result = await request(handler, { action: 'plan', repository: 'owner/repo', issueNumber: 9 });
  assert.equal(result.status, 200);
  assert.equal(result.value.planId, 'plan-deterministic');
  assert.equal(result.value.cached, false);
}));

test('patch routes fail closed on missing or mismatched server-side repository allowlist before GitHub or store reads', async () => {
  let calls = 0;
  const handler = createDashboardHandler({ makeStore: () => ({ listPatches: async () => { calls++; return []; } }), makeClient: () => { calls++; return {}; } });
  await withEnvironment({ DASHBOARD_ALLOWED_USER_IDS: 'operator', GITHUB_PATCH_ALLOWED_REPOSITORIES: null, GITHUB_APP_INSTALLATION_ID: '1' }, async () => {
    for (const action of ['patch', 'patch-history', 'patch-validate', 'patch-reject']) assert.equal((await request(handler, { action, repository: 'owner/repo', issueNumber: 9 })).status, 403);
  });
  await withEnvironment({ DASHBOARD_ALLOWED_USER_IDS: 'operator', GITHUB_PATCH_ALLOWED_REPOSITORIES: 'other/repo', GITHUB_APP_INSTALLATION_ID: '1' }, async () => {
    for (const action of ['patch', 'patch-history', 'patch-validate', 'patch-reject']) assert.equal((await request(handler, { action, repository: 'owner/repo', issueNumber: 9 })).status, 403);
  });
  assert.equal(calls, 0);
});

test('wildcard repository allowlist permits any canonical repository while invalid wildcard combinations fail closed', async () => {
  const calls = [];
  const makeService = () => ({ propose: async (args) => { calls.push(args); return { patch: { status: 'proposed' }, patchId: 'patch-1', cached: false }; } });
  const handler = createDashboardHandler({ makeStore: () => ({ listPatches: async () => [], listPlans: async () => [] }), makeClient: () => ({ issues: { get: async () => ({ data: {} }) } }), makeService });
  await withEnvironment({ DASHBOARD_ALLOWED_USER_IDS: 'operator', GITHUB_PATCH_ALLOWED_REPOSITORIES: '*', GITHUB_APP_INSTALLATION_ID: '1' }, async () => {
    const result = await request(handler, { action: 'patch', repository: 'another-owner/another-repo', issueNumber: 4 });
    assert.equal(result.status, 200);
  });
  await withEnvironment({ DASHBOARD_ALLOWED_USER_IDS: 'operator', GITHUB_PATCH_ALLOWED_REPOSITORIES: '*,owner/repo', GITHUB_APP_INSTALLATION_ID: '1' }, async () => {
    const result = await request(handler, { action: 'patch', repository: 'another-owner/another-repo', issueNumber: 4 });
    assert.equal(result.status, 403);
  });
  assert.equal(calls.length, 1);
});

test('authenticated patch history and exact lookup retain persisted validation state with safe error enum', async () => withEnvironment({ DASHBOARD_ALLOWED_USER_IDS: 'operator', GITHUB_PATCH_ALLOWED_REPOSITORIES: 'owner/repo' }, async () => {
  const documents = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') { const { documentId, data } = JSON.parse(options.body); const doc = { $id: documentId, ...data }; documents.unshift(doc); return new Response(JSON.stringify(doc), { status: 201 }); }
    if (String(url).includes('/documents/')) return new Response(JSON.stringify(documents.find((doc) => String(url).endsWith('/' + doc.$id))));
    return new Response(JSON.stringify({ documents }));
  };
  try {
    const store = createDashboardStore({ APPWRITE_ENDPOINT: 'https://appwrite.test/v1', APPWRITE_PROJECT_ID: 'a', APPWRITE_API_KEY: 'private', WEBHOOK_DATABASE_ID: 'db', DASHBOARD_ISSUE_COLLECTION_ID: 'issues' });
    const saved = await store.persistPatch({ repository: 'owner/repo', issueNumber: 9, patch: { summary: 'fix', status: 'validation_unavailable', patchRevision: 'a'.repeat(24) }, validation: { status: 'validation_unavailable', testsRun: false, error: 'TRUSTED_RUNNER_UNAVAILABLE', output: 'API_KEY=secret' } });
    const handler = createDashboardHandler({ makeStore: () => store });
    const list = await request(handler, { action: 'patch-history', repository: 'owner/repo', issueNumber: 9 });
    assert.equal(list.status, 200);
    assert.equal(list.value.patches[0].patchId, saved.$id);
    assert.deepEqual(list.value.patches[0].validation, { status: 'validation_unavailable', testsRun: false, error: 'TRUSTED_RUNNER_UNAVAILABLE' });
    assert.doesNotMatch(JSON.stringify(list.value), /secret|private/);
    const exact = await request(handler, { action: 'patch-history', repository: 'owner/repo', issueNumber: 9, patchId: saved.$id, patchRevision: 'a'.repeat(24) });
    assert.equal(exact.value.patchId, saved.$id);
    const mismatch = await request(handler, { action: 'patch-history', repository: 'owner/repo', issueNumber: 10, patchId: saved.$id });
    assert.equal(mismatch.status, 503);
  } finally { globalThis.fetch = previous; }
}));

test('patch envelope preflight counts UTF-8 and JSON escaping without truncation', () => {
  const patch = normalizePatch({ diff: 'x'.repeat(11900), summary: 'é', files: [] }, { issueRevision: 'a', planRevision: 'b', snapshotRevision: 'c' });
  assert.equal(patch.diff.length, 11900);
  assert.doesNotThrow(() => assertPatchEnvelopeSize(patch));
  assert.throws(() => assertPatchEnvelopeSize({ ...patch, summary: '"\\'.repeat(5000) }), /PATCH_PAYLOAD_TOO_LARGE/);
  assert.throws(() => normalizePatch({ diff: 'x'.repeat(12001) }), /DIFF_TOO_LARGE/);
});

test('plan persistence rejects a partial summary-only output before creating an envelope', async () => withEnvironment({
  APPWRITE_ENDPOINT: 'https://appwrite.test/v1', APPWRITE_PROJECT_ID: 'a', APPWRITE_API_KEY: 'private', WEBHOOK_DATABASE_ID: 'db', DASHBOARD_ISSUE_COLLECTION_ID: 'issues',
}, async () => {
  let writes = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { writes += 1; return new Response('{}', { status: 201 }); };
  try {
    await assert.rejects(
      createDashboardStore(process.env).persistPlan({ repository: 'owner/repo', issueNumber: 9, plan: { summary: 'x' } }),
      /INVALID_PLAN_OUTPUT/,
    );
    assert.equal(writes, 0);
  } finally { globalThis.fetch = previous; }
}));

test('plan persistence retains actual provider and model metadata in the stored envelope', async () => withEnvironment({
  APPWRITE_ENDPOINT: 'https://appwrite.test/v1', APPWRITE_PROJECT_ID: 'a', APPWRITE_API_KEY: 'private', WEBHOOK_DATABASE_ID: 'db', DASHBOARD_ISSUE_COLLECTION_ID: 'issues',
}, async () => {
  let saved;
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    const { documentId, data } = JSON.parse(options.body);
    saved = { $id: documentId, ...data };
    return new Response(JSON.stringify(saved), { status: 201 });
  };
  try {
    const result = await createDashboardStore(process.env).persistPlan({ repository: 'owner/repo', issueNumber: 9, plan: {
      summary: 'x', implementationSteps: ['y'], testPlan: ['z'], provider: 'openrouter', model: 'minimax/minimax-m3.1-flash:free',
    } });
    assert.equal(result.plan.provider, 'openrouter');
    assert.equal(result.plan.model, 'minimax/minimax-m3.1-flash:free');
    assert.equal(JSON.parse(saved.response).plan.provider, 'openrouter');
    assert.equal(JSON.parse(saved.response).plan.model, 'minimax/minimax-m3.1-flash:free');
  } finally { globalThis.fetch = previous; }
}));

test('oversized generated proposal is surfaced as safe PATCH_PAYLOAD_TOO_LARGE before persistence', async () => {
  const issue = { id: 3, number: 9, title: 'Fix', body: 'body' };
  const octokit = { issues: { get: async () => ({ data: issue }), listComments: async () => ({ data: [] }) } };
  const revision = await patchIssueRevision({ octokit, owner: 'owner', repo: 'repo', issueNumber: 9, issue });
  let writes = 0;
  const store = { listPlans: async () => [{ fullName: 'owner/repo', issueNumber: 9, plan: { repository: 'owner/repo', issueNumber: 9, issueRevision: revision, affectedFiles: [] } }], listPatches: async () => [], persistPatch: async () => { writes++; } };
  const service = createPatchService({ octokit, store, capture: async () => ({ revision: 'snap', baseSha: 'a'.repeat(40), files: [] }), generate: async () => { throw new Error('PATCH_PAYLOAD_TOO_LARGE'); } });
  await assert.rejects(service.propose({ owner: 'owner', repo: 'repo', issueNumber: 9 }), (error) => error.code === 'PATCH_PAYLOAD_TOO_LARGE' && error.status === 400);
  assert.equal(writes, 0);
});

test('deployment declares required variable sync, collection verification and viable dashboard deadline', async () => {
  const script = await readFile(new URL('../scripts/deploy-functions.ps1', import.meta.url), 'utf8');
  const webhook = script.match(/"github-pr-reviewer"\s*=\s*@\{[^\r\n]+/)?.[0];
  const dashboard = script.match(/"github-dashboard"\s*=\s*@\{[^\r\n]+/)?.[0];
  for (const key of ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'APP_ID', 'PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_PATCH_ALLOWED_REPOSITORIES']) assert.ok(dashboard.includes(`"${key}"`), key);
  assert.ok(webhook.includes('"WEBHOOK_DELIVERY_COLLECTION_ID"'));
  assert.match(script, /Require-Values[^\r\n]*"GITHUB_PATCH_ALLOWED_REPOSITORIES"/);
  assert.match(script, /WEBHOOK_DATABASE_ID was not found[\s\S]*DASHBOARD_ISSUE_COLLECTION_ID was not found/);
  assert.match(dashboard, /Timeout = 300/);
});
