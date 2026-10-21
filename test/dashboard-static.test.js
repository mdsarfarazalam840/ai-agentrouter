import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const files = await Promise.all([
  readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../dashboard/patch-ui.js', import.meta.url), 'utf8'),
]);
const bundle = files.join('\n');

test('dashboard bundle exposes live provider and empty plan labels', () => {
  for (const label of ['NVIDIA NIM', 'OpenRouter fallback', 'free-only', 'No issue plans loaded']) {
    assert.match(bundle, new RegExp(label));
  }
});

test('flow strip does not claim OpenRouter was used without live execution data', () => {
  assert.doesNotMatch(files[0], /NVIDIA[\s\S]{0,160}OpenRouter[\s\S]{0,80}used/i);
});
