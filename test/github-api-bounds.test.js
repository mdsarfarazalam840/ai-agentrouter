import assert from "node:assert/strict";
import test from "node:test";
import { fetchPrDiff, fetchWeeklyRepoActivity, formatPlanningContext, listIssueComments } from "../shared/lib/github.js";

test("diff responses are capped before they can grow unbounded", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("0123456789", { status: 200 }));
  const diff = await fetchPrDiff({ diff_url: "https://example.test/diff" }, { maxBytes: 5, timeoutMs: 100 });
  assert.match(diff, /truncated/i);
});

test("weekly activity respects repository and page bounds", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (input) => { urls.push(String(input)); return new Response(JSON.stringify(String(input).includes("/users/") ? [{ name: "one" }] : [])); });
  await fetchWeeklyRepoActivity("octocat", { maxRepos: 1, perPage: 1, maxConcurrency: 1 });
  assert.ok(urls.filter((url) => url.includes("/repos/")).length <= 3);
  assert.ok(urls.every((url) => !url.includes("per_page=10")));
});

test("weekly activity bounds actual concurrent requests and ignores excess rows and repos", async (t) => {
  let active = 0; let peak = 0; let requests = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    requests++;
    if (String(input).includes("/users/")) return new Response(JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ name: `repo${i}` }))));
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    assert.equal(new URL(input).searchParams.get("per_page"), "2");
    return new Response(JSON.stringify([{}, {}, {}, {}]));
  });
  const result = await fetchWeeklyRepoActivity("octocat", { maxRepos: 2, perPage: 2, maxConcurrency: 2 });
  assert.equal(requests, 7);
  assert.equal(peak, 2);
  assert.equal(result.length, 2);
  assert.ok(result.every((repo) => repo.commits === 2 && repo.issues === 2 && repo.prs === 2));
});

test("explicit repository path uses its owner and skips listing user repositories", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (input) => { urls.push(String(input)); return new Response("[]"); });
  await fetchWeeklyRepoActivity("octocat", { repository: "other-owner/repo.name" });
  assert.equal(urls.length, 3);
  assert.ok(urls.every((url) => url.startsWith("https://api.github.com/repos/other-owner/repo.name/")));
});

test("planning context can be bounded to a fast model budget", () => {
  const context = { issue: { title: "Fix", body: "x".repeat(1000) }, files: [{ path: "src/a.js", content: "x".repeat(50000) }] };
  const output = formatPlanningContext(context, 24000);
  assert.ok(output.length <= 24000 + 32);
  assert.match(output, /planning context truncated/i);
});

test("issue comment pagination reaches markers beyond the first page", async () => {
  const calls = [];
  const octokit = { issues: { listComments: async (params) => {
    calls.push(params.page);
    if (params.page === 1) return { data: Array.from({ length: 100 }, (_, index) => ({ id: index })) };
    return { data: [{ id: 101, body: "target" }] };
  } } };
  const comments = await listIssueComments({ octokit, owner: "owner", repo: "repo", issueNumber: 1 });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(comments.at(-1).body, "target");
});

test("issue comment pagination fails closed at the bounded page limit", async () => {
  const octokit = { issues: { listComments: async () => ({ data: Array.from({ length: 100 }, () => ({})) }) } };
  await assert.rejects(() => listIssueComments({ octokit, owner: "owner", repo: "repo", issueNumber: 1, maxPages: 2 }), /ISSUE_COMMENTS_TOO_LARGE/);
});
