import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => readFile(path.join(root, name), 'utf8');

test('both dashboard deployment bundles include every local JavaScript import', async () => {
  const entry = await source('dashboard/app.js');
  const imports = [...entry.matchAll(/\bfrom\s+['"]\.\/([^'"/]+\.js)['"]/g)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ['appwrite.js', 'patch-ui.js', 'render-state.js']);
  for (const script of ['scripts/deploy-dashboard-site.ps1', 'scripts/deploy-vercel-dashboard.ps1']) {
    const deployment = await source(script);
    const assets = deployment.match(/foreach\s*\(\$asset\s+in\s+@\(([^)]*)\)\)/)?.[1];
    assert.ok(assets, `${script} must declare the staged asset list`);
    const staged = [...assets.matchAll(/"([^"\r\n]+)"/g)].map((match) => match[1]);
    for (const asset of ['index.html', 'app.js', 'appwrite.js', 'patch-ui.js', 'styles.css', ...imports]) {
      assert.ok(staged.includes(asset), `${script} omits ${asset}`);
      await access(path.join(root, 'dashboard', asset));
    }
    assert.match(deployment, /Set-Content\s+-LiteralPath\s+\(Join-Path\s+\$staging\s+"config\.js"\)/, `${script} must stage generated runtime config`);
  }
});

test('function deployment stages runtime files with shared patch modules syntax checked', async () => {
  const deployment = await source('scripts/deploy-functions.ps1');
  assert.match(deployment, /create-deployment[^\r\n]*--code \$stagingRoot/, 'function archive must use the bounded runtime staging directory');
  assert.match(deployment, /Copy-Item[^\r\n]+shared\/lib\/\*/, 'function archive must include shared/lib');
  const dashboard = deployment.match(/"github-dashboard"\s*=\s*@\{[^\r\n]+/)?.[0];
  assert.ok(dashboard, 'dashboard function deployment definition missing');
  for (const variable of ['GITHUB_APP_INSTALLATION_ID']) {
    assert.ok(dashboard.includes(`"${variable}"`), `dashboard must sync server-only ${variable}`);
    assert.match(deployment, new RegExp(`Require-Values[^\\r\\n]*"${variable}"`), `dashboard must require ${variable}`);
  }
  assert.ok(dashboard.includes('"DASHBOARD_USER_REPOSITORIES"'), 'dashboard must sync optional per-user repository policy');
  for (const variable of ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'APP_ID', 'PRIVATE_KEY']) assert.ok(dashboard.includes(`"${variable}"`), `dashboard must sync server-only ${variable}`);
  assert.match(deployment, /Require-OneOf @\("GITHUB_APP_ID", "APP_ID"\)/);
  assert.match(deployment, /Require-OneOf @\("GITHUB_PRIVATE_KEY", "PRIVATE_KEY"\)/);
  const scripts = (JSON.parse(await source('package.json'))).scripts;
  for (const file of ['shared/lib/patcher.js', 'shared/lib/patch-service.js', 'shared/lib/patch-workspace.js', 'dashboard/app.js', 'dashboard/appwrite.js', 'dashboard/patch-ui.js', 'dashboard/render-state.js', 'dashboard/config.js']) {
    assert.ok(scripts.check.includes(`node --check ${file}`), `syntax check omits ${file}`);
    await access(path.join(root, file));
  }
});

test('Backend A setup provisions and waits for the plan and patch query indexes', async () => {
  const setup = await source('scripts/setup-dashboard-project.ps1');
  assert.match(setup, /"databases", "create-index"/);
  assert.match(setup, /databases list-indexes/);
  assert.match(setup, /fullName.*issueNumber.*command/);
  assert.match(setup, /repository.*issueNumber.*command/);
  assert.match(setup, /command.*\$createdAt/);
  assert.match(setup, /status\s+-eq\s+"available"/);
  assert.match(setup, /Start-Sleep/);
});

test('history selection is disabled and ignored while patch actions are pending', async () => {
  const app = await source('dashboard/app.js');
  assert.match(app, /item\.disabled = busy/);
  assert.match(app, /if \(!current\(\) \|\| busy\) return; proposal = entry\.patch/);
  assert.match(app, /selectLatest && patches\.length && !proposal && !busy/);
  assert.match(app, /await loadHistory\(\)/);
});
