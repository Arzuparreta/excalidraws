import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/prepare-service.mjs', import.meta.url));

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'excalidraws-startup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'Checkout with spaces $ and %');
  const vault = path.join(root, 'Separate vault');
  await fs.mkdir(checkout);
  await fs.mkdir(vault);
  await fs.writeFile(path.join(vault, 'Drawing.excalidraw'), 'Existing user drawing');
  await fs.mkdir(path.join(checkout, 'build-tool'));
  await fs.writeFile(
    path.join(checkout, 'build-tool/package.json'),
    JSON.stringify({ name: 'build-tool', version: '1.0.0', type: 'module', main: 'index.js' }),
  );
  await fs.writeFile(
    path.join(checkout, 'build-tool/index.js'),
    'export const compile = (source) => `<main>${source}</main>`;',
  );
  const manifest = {
    name: 'service-startup-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { build: 'node build.mjs' },
    devDependencies: { 'build-tool': 'file:./build-tool' },
  };
  await fs.writeFile(path.join(checkout, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(checkout, 'source.txt'), 'First version');
  await fs.writeFile(
    path.join(checkout, 'build.mjs'),
    `import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { compile } from 'build-tool';
const source = await readFile('source.txt', 'utf8');
if (source === 'Broken build') throw new Error('Fixture compilation failed');
await mkdir('dist/client', { recursive: true });
await writeFile('dist/client/index.html', compile(source));
`,
  );
  const environment = { ...process.env, NODE_ENV: 'production', VAULT_DIR: vault };
  const lock = () => {
    const result = spawnSync(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--include=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: checkout, env: environment, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  lock();
  const run = () =>
    spawnSync(process.execPath, [script], {
      cwd: checkout,
      env: environment,
      encoding: 'utf8',
    });
  const built = () => fs.readFile(path.join(checkout, 'dist/client/index.html'), 'utf8');
  return { checkout, vault, manifest, run, built, lock };
}

test('startup installs build tools in production, rebuilds changed sources and preserves the vault', async (t) => {
  const { checkout, vault, run, built } = await fixture(t);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Synchronizing service dependencies/);
  assert.equal(await built(), '<main>First version</main>');
  await fs.writeFile(
    path.join(checkout, 'node_modules/install-sentinel'),
    'Keep installed modules',
  );
  await fs.writeFile(path.join(checkout, 'source.txt'), 'Updated version');
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /Synchronizing service dependencies/);
  assert.equal(await built(), '<main>Updated version</main>');
  assert.equal(
    await fs.readFile(path.join(checkout, 'node_modules/install-sentinel'), 'utf8'),
    'Keep installed modules',
  );
  assert.equal(
    await fs.readFile(path.join(vault, 'Drawing.excalidraw'), 'utf8'),
    'Existing user drawing',
  );
});

test('startup synchronizes new dependencies after the package files change', async (t) => {
  const { checkout, manifest, run, lock } = await fixture(t);
  assert.equal(run().status, 0);
  await fs.writeFile(path.join(checkout, 'node_modules/install-sentinel'), 'Old dependencies');
  await fs.mkdir(path.join(checkout, 'extra-tool'));
  await fs.writeFile(
    path.join(checkout, 'extra-tool/package.json'),
    JSON.stringify({ name: 'extra-tool', version: '1.0.0' }),
  );
  await fs.writeFile(
    path.join(checkout, 'package.json'),
    JSON.stringify({
      ...manifest,
      devDependencies: { ...manifest.devDependencies, 'extra-tool': 'file:./extra-tool' },
    }),
  );
  lock();
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Synchronizing service dependencies/);
  await fs.access(path.join(checkout, 'node_modules/extra-tool'));
  await assert.rejects(fs.access(path.join(checkout, 'node_modules/install-sentinel')));
});

test('startup restores missing dependencies and detects changes to the installed dependency tree', async (t) => {
  const { checkout, run } = await fixture(t);
  assert.equal(run().status, 0);
  await fs.rm(path.join(checkout, 'node_modules'), { recursive: true });
  const missing = run();
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /Synchronizing service dependencies/);
  await fs.writeFile(path.join(checkout, 'node_modules/.package-lock.json'), '{}');
  const changed = run();
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(changed.stdout, /Synchronizing service dependencies/);
});

test('a build failure fails preparation instead of accepting an older build', async (t) => {
  const { checkout, run, built } = await fixture(t);
  assert.equal(run().status, 0);
  await fs.writeFile(path.join(checkout, 'source.txt'), 'Broken build');
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Fixture compilation failed/);
  assert.match(result.stderr, /the server will not start/);
  assert.equal(await built(), '<main>First version</main>');
});

test('a failed dependency installation does not run the build', async (t) => {
  const { checkout, manifest, run, built } = await fixture(t);
  assert.equal(run().status, 0);
  await fs.writeFile(path.join(checkout, 'source.txt'), 'Must not build');
  await fs.writeFile(
    path.join(checkout, 'package.json'),
    JSON.stringify({ ...manifest, devDependencies: { missing: 'file:./missing-package' } }),
  );
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Service preparation failed/);
  assert.doesNotMatch(result.stdout, /Building Excalidraws/);
  assert.equal(await built(), '<main>First version</main>');
});
