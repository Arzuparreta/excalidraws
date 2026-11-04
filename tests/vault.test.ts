import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault, VaultError } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { emptyScene } from '../shared/model.js';

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'excalidraws-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = new Vault(root);
  await vault.init();
  return { root, vault };
}
const conflict = (e: unknown) => e instanceof VaultError && e.code === 'conflict';

test('round trip preserves images, viewport and unknown scene fields as real JSON', async (t) => {
  const { vault, root } = await fixture(t);
  await vault.create('Ideas', 'folder');
  const scene = {
    ...emptyScene(),
    appState: { scrollX: 52, scrollY: -70, zoom: { value: 1.5 } },
    files: {
      image: {
        id: 'image',
        dataURL: 'data:image/png;base64,aGVsbG8=',
        mimeType: 'image/png',
        created: 1,
      },
    },
    futureField: { preserve: true },
  };
  const created = (await vault.create('Ideas/🌳 Tree.excalidraw', 'file', scene))!;
  assert.deepEqual((await vault.read(created.path)).scene, scene);
  const saved = await vault.save(created.path, created.revision, {
    ...scene,
    elements: [{ id: 'one', type: 'rectangle' }],
  });
  assert.notEqual(saved.revision, created.revision);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, created.path), 'utf8')),
    saved.scene,
  );
  const history = await vault.history(created.path);
  assert.equal(history[0].revision, created.revision);
  assert.deepEqual(await vault.historical(created.path, created.revision), scene);
  assert.equal(
    (await fs.readdir(path.join(root, 'Ideas'))).some((n) => n.startsWith('.save-')),
    false,
  );
});

test('concurrent writers cannot overwrite the winner; external edits and deletion conflict', async (t) => {
  const { vault, root } = await fixture(t);
  const doc = (await vault.create('Shared.excalidraw', 'file'))!;
  const results = await Promise.allSettled([
    vault.save(doc.path, doc.revision, { ...emptyScene(), elements: [{ id: 'one' }] }),
    vault.save(doc.path, doc.revision, { ...emptyScene(), elements: [{ id: 'two' }] }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(conflict(rejected.reason));
  const current = await vault.read(doc.path);
  const external = { ...emptyScene(), elements: [{ id: 'external' }] };
  await fs.writeFile(path.join(root, doc.path), JSON.stringify(external));
  await assert.rejects(vault.save(doc.path, current.revision, emptyScene()), conflict);
  assert.deepEqual((await vault.read(doc.path)).scene, external);
  await fs.unlink(path.join(root, doc.path));
  await assert.rejects(vault.save(doc.path, current.revision, emptyScene()), conflict);
});

test('folders, rename, move, trash and restoration preserve content and reject collisions', async (t) => {
  const { vault } = await fixture(t);
  await vault.create('Project', 'folder');
  await vault.create('Other', 'folder');
  await vault.create('Project/Plan.excalidraw', 'file');
  await vault.move('Project/Plan.excalidraw', 'Other/Roadmap.excalidraw');
  await assert.rejects(vault.move('Other', 'Other/inside'), /inside/);
  const trash = await vault.trash('Other');
  assert.equal(
    (await vault.list()).some((e) => e.path.startsWith('Other')),
    false,
  );
  assert.equal((await vault.listTrash()).length, 1);
  await vault.create('Other', 'folder');
  await assert.rejects(vault.restore(trash.id), /exists/);
  await vault.restore(trash.id, 'Recovered');
  assert.equal((await vault.read('Recovered/Roadmap.excalidraw')).scene.type, 'excalidraw');
  assert.equal((await vault.listTrash()).length, 0);
});

test('traversal, absolute/hidden paths, symlinks and non-scenes are refused', async (t) => {
  const { vault, root } = await fixture(t);
  for (const name of [
    '../escape.excalidraw',
    '/tmp/escape.excalidraw',
    'a/../b.excalidraw',
    '.workspace/x.excalidraw',
    'a\\b.excalidraw',
    'a//b.excalidraw',
    ' .excalidraw',
  ]) {
    await assert.rejects(vault.create(name, 'file'), VaultError);
  }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, 'Link'));
  await assert.rejects(vault.create('Link/escape.excalidraw', 'file'), /Symbolic links/);
  await fs.writeFile(path.join(root, 'invalid.excalidraw'), '{}');
  await assert.rejects(vault.read('invalid.excalidraw'), /valid/);
  assert.equal(
    (await vault.list()).some((e) => e.path === 'Link'),
    false,
  );
});

test('retains only 20 previous revisions and locks out a second service', async (t) => {
  const { vault, root } = await fixture(t);
  const unlock = await vault.lock();
  t.after(unlock);
  await assert.rejects(new Vault(root).lock(), /already open/);
  let doc = (await vault.create('History.excalidraw', 'file'))!;
  for (let n = 0; n < 23; n++)
    doc = await vault.save(doc.path, doc.revision, {
      ...emptyScene(),
      elements: [{ id: String(n) }],
    });
  assert.equal((await vault.history(doc.path)).length, 20);
});

test('HTTP contract rejects cross-origin writes, malformed JSON, traversal and stale revision', async (t) => {
  const { vault } = await fixture(t);
  const server = createApp(vault).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const post = (endpoint: string, body: unknown, headers = {}) =>
    fetch(`${url}/api${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await post(
        '/entries',
        { path: 'X.excalidraw', kind: 'file' },
        { Origin: 'https://evil.test' },
      )
    ).status,
    403,
  );
  assert.equal((await post('/entries', { path: '../X.excalidraw', kind: 'file' })).status, 400);
  assert.equal((await post('/entries', { path: 'X.excalidraw', kind: 'file' })).status, 201);
  assert.equal((await post('/entries', { path: 'X.excalidraw', kind: 'file' })).status, 409);
  const response = await fetch(`${url}/api/document`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'X.excalidraw', revision: 'old', scene: emptyScene() }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'conflict');
  assert.equal((await fetch(`${url}/api/document?path=no.excalidraw`)).status, 404);
});

test('production HTML and assets load from a hidden XDG release directory', async (t) => {
  const { vault, root } = await fixture(t);
  const client = path.join(root, '.local/share/excalidraws/release/client');
  await fs.mkdir(client, { recursive: true });
  await fs.writeFile(path.join(client, 'index.html'), '<!doctype html><title>Excalidraws</title>');
  await fs.writeFile(path.join(client, 'asset.js'), 'console.log("workspace");');
  const server = createApp(vault, client).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const html = await fetch(`${url}/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Excalidraws/);
  assert.equal((await fetch(`${url}/asset.js`)).status, 200);
  assert.equal((await fetch(`${url}/.secret`)).status, 404);
});
