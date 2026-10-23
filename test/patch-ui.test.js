import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { issueLink, patchIdentity, canApprovePatch, validationMessage, renderPatch } from '../dashboard/patch-ui.js';

test('only canonical GitHub issue URLs are offered', () => {
  assert.equal(issueLink('owner/repo', 42), 'https://github.com/owner/repo/issues/42');
  for (const repository of ['other.example/owner/repo', 'owner/../repo', 'owner/repo?x=1', 'owner/repo#fragment', 'owner/repo/issues/1']) assert.equal(issueLink(repository, 42), '');
  assert.equal(issueLink('owner/repo', '2/evil'), '');
});

test('only persisted proposed revision can be approved', () => {
  const patch = { status: 'proposed', patchRevision: 'rev1' };
  assert.deepEqual(patchIdentity(patch, 'id1'), { patchId: 'id1', patchRevision: 'rev1' });
  assert.equal(canApprovePatch(patch, 'id1'), true);
  assert.equal(canApprovePatch(patch, ''), false);
  for (const status of ['validated', 'failed', 'expired', 'rejected', 'test_failed']) assert.equal(canApprovePatch({ ...patch, status }, 'id1'), false);
});

test('unavailable validation never claims tests passed', () => {
  assert.match(validationMessage({ status: 'validation_unavailable', testsRun: false }), /tests not run/i);
  assert.match(validationMessage({ status: 'validated', testsRun: false }), /tests not run/i);
  assert.match(validationMessage({ status: 'validated', testsRun: true }), /tests passed/i);
});

test('diff and validation output are inserted as text, with approval disabled without stored identity', () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.disabled = false; }
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    addEventListener() {}
  }
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const root = new Element('root');
    const markup = '<img src=x onerror=alert(1)>';
    renderPatch(root, { status: 'proposed', patchRevision: 'r', diff: markup, files: [{ path: markup, additions: 1, deletions: 2 }] }, { validation: { status: 'test_failed', testsRun: true, output: markup } });
    const all = (element) => [element, ...element.children.flatMap(all)];
    assert.equal(all(root).filter((item) => item.tag === 'img').length, 0);
    assert.equal(all(root).filter((item) => item.tag === 'code').length, 2);
    assert.equal(all(root).filter((item) => item.textContent === markup).length, 2);
    assert.equal(all(root).find((item) => item.textContent === 'Approve and apply in isolated workspace').disabled, true);
  } finally { globalThis.document = previous; }
});
