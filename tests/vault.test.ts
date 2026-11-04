import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Vault, VaultError } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { emptyScene, type Entry } from '../shared/model.js';

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
  await assert.rejects(vault.restore(trash.id, 'Other'), /exists/);
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
  const current = await vault.read('X.excalidraw');
  const accepted = await fetch(`${url}/api/document`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: current.path,
      revision: current.revision,
      scene: { ...emptyScene(), elements: [{ id: 'saved' }] },
    }),
  });
  const acknowledgment = await accepted.json();
  assert.equal(accepted.status, 200);
  assert.deepEqual(Object.keys(acknowledgment), ['revision']);
  assert.equal(acknowledgment.revision, (await vault.read(current.path)).revision);
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

const byPath = async (vault: Vault) =>
  Object.fromEntries((await vault.list()).map((entry) => [entry.path, entry]));
const snapshotFile = async (file: string) => {
  const stat = await fs.stat(file);
  return { bytes: await fs.readFile(file, 'utf8'), modified: stat.mtimeMs };
};

test('favorites, inherited archive and custom order persist without touching scenes', async (t) => {
  const { vault, root } = await fixture(t);
  await vault.create('Projects', 'folder');
  await vault.create('Projects/Alpha.excalidraw', 'file');
  await vault.create('Projects/Beta.excalidraw', 'file');
  await vault.create('Projects/Gamma.excalidraw', 'file');
  await vault.create('Projects/Old', 'folder');
  await vault.create('Projects/Old/Legacy.excalidraw', 'file');
  const before = await snapshotFile(path.join(root, 'Projects/Alpha.excalidraw'));

  await vault.setLibrary(['Projects/Alpha.excalidraw', 'Projects'], 'favorite', true);
  await vault.setLibrary(['Projects/Old'], 'archived', true);
  await vault.setLibrary(['Projects/Old/Legacy.excalidraw'], 'archived', true);
  await vault.order('Projects', ['Projects/Gamma.excalidraw', 'Projects/Alpha.excalidraw']);

  // A restarted service reads the same metadata.
  const entries = await byPath(new Vault(root));
  assert.equal(entries['Projects/Alpha.excalidraw'].favorite, true);
  assert.equal(entries['Projects'].favorite, true);
  assert.equal(entries['Projects/Beta.excalidraw'].favorite, false);
  assert.equal(entries['Projects/Old'].archived, true);
  assert.equal(entries['Projects/Old'].archiveRoot, 'Projects/Old');
  assert.equal(
    entries['Projects/Old/Legacy.excalidraw'].archiveRoot,
    'Projects/Old/Legacy.excalidraw',
  );
  assert.equal(entries['Projects/Alpha.excalidraw'].archived, false);
  assert.equal(entries['Projects/Alpha.excalidraw'].archiveRoot, undefined);
  assert.deepEqual(
    ['Gamma', 'Alpha', 'Beta', 'Old'].map((name) => {
      const key = name === 'Old' ? 'Projects/Old' : `Projects/${name}.excalidraw`;
      return entries[key].order;
    }),
    [0, 1, 2, 3],
  );
  assert.deepEqual(await snapshotFile(path.join(root, 'Projects/Alpha.excalidraw')), before);

  // Clearing the explicit nested flag leaves the inherited archive state.
  await vault.setLibrary(['Projects/Old/Legacy.excalidraw'], 'archived', false);
  assert.equal((await byPath(vault))['Projects/Old/Legacy.excalidraw'].archiveRoot, 'Projects/Old');
  await vault.setLibrary(['Projects/Old'], 'archived', false);
  assert.equal((await byPath(vault))['Projects/Old/Legacy.excalidraw'].archived, false);
  await vault.order('Projects', []);
  assert.equal((await byPath(vault))['Projects/Alpha.excalidraw'].order, 0);
});

test('metadata operations validate paths, siblings, duplicates and self-ordering', async (t) => {
  const { vault } = await fixture(t);
  await vault.create('A', 'folder');
  await vault.create('A/B', 'folder');
  await vault.create('A/one.excalidraw', 'file');
  await vault.create('top.excalidraw', 'file');
  const invalid = (e: unknown) => e instanceof VaultError && e.status === 400;
  const missing = (e: unknown) => e instanceof VaultError && e.status === 404;
  await assert.rejects(vault.order('A', ['top.excalidraw']), invalid);
  await assert.rejects(vault.order('A', ['A/one.excalidraw', 'A/one.excalidraw']), invalid);
  await assert.rejects(vault.order('A/B', ['A']), invalid);
  await assert.rejects(vault.order('A', ['A']), invalid);
  await assert.rejects(vault.order('A', ['A/missing.excalidraw']), missing);
  await assert.rejects(vault.order('top.excalidraw', []), invalid);
  await assert.rejects(vault.order('Missing', []), missing);
  await assert.rejects(vault.order('', ['../x.excalidraw']), invalid);
  await assert.rejects(vault.setLibrary(['A', 'A'], 'favorite', true), invalid);
  await assert.rejects(vault.setLibrary([], 'favorite', true), invalid);
  await assert.rejects(vault.setLibrary(['.workspace'], 'archived', true), invalid);
  await assert.rejects(vault.setLibrary(['Nothing.excalidraw'], 'favorite', true), missing);
  await vault.setLibrary(['Nothing.excalidraw'], 'favorite', false);
  await vault.order('', ['top.excalidraw', 'A']);
  const entries = await byPath(vault);
  assert.equal(entries['top.excalidraw'].order, 0);
  assert.equal(entries['A'].order, 1);
});

test('invalid metadata is preserved for diagnosis and replaced on the next change', async (t) => {
  const { vault, root } = await fixture(t);
  await vault.create('Plan.excalidraw', 'file');
  const file = path.join(root, '.workspace/library.json');
  await fs.writeFile(file, '{"version": 1, "favorites": "broken"');
  assert.equal((await byPath(vault))['Plan.excalidraw'].favorite, false);
  await vault.setLibrary(['Plan.excalidraw'], 'favorite', true);
  const names = await fs.readdir(path.join(root, '.workspace'));
  const backup = names.find((name) => name.startsWith('library.invalid-'));
  assert.ok(backup);
  assert.equal(
    await fs.readFile(path.join(root, '.workspace', backup), 'utf8'),
    '{"version": 1, "favorites": "broken"',
  );
  assert.equal((await byPath(vault))['Plan.excalidraw'].favorite, true);
  assert.equal(
    names.some((name) => name.startsWith('.write-')),
    false,
  );
});

test('moves rewrite metadata and history follows files and folders', async (t) => {
  const { vault, root } = await fixture(t);
  await vault.create('Work', 'folder');
  await vault.create('Work/Inner', 'folder');
  await vault.create('Done', 'folder');
  let doc = (await vault.create('Work/Inner/Plan.excalidraw', 'file'))!;
  const first = doc.revision;
  doc = await vault.save(doc.path, doc.revision, { ...emptyScene(), elements: [{ id: 'a' }] });
  await vault.create('Work/Second.excalidraw', 'file');
  await vault.setLibrary(['Work/Inner/Plan.excalidraw'], 'favorite', true);
  await vault.setLibrary(['Work/Inner'], 'archived', true);
  await vault.order('Work', ['Work/Second.excalidraw', 'Work/Inner']);
  await vault.order('Work/Inner', ['Work/Inner/Plan.excalidraw']);

  // Rename keeps the position in the custom order.
  await vault.move('Work/Inner', 'Work/Nested');
  let entries = await byPath(vault);
  assert.equal(entries['Work/Nested'].order, 1);
  assert.equal(entries['Work/Nested/Plan.excalidraw'].favorite, true);
  assert.equal(entries['Work/Nested/Plan.excalidraw'].archiveRoot, 'Work/Nested');
  assert.deepEqual(
    (await vault.history('Work/Nested/Plan.excalidraw')).map((h) => h.revision),
    [first],
  );

  // Moving an ancestor folder carries the descendant history along.
  await vault.move('Work', 'Done/Work');
  entries = await byPath(vault);
  assert.equal(entries['Done/Work/Nested/Plan.excalidraw'].favorite, true);
  assert.equal(entries['Done/Work/Second.excalidraw'].order, 0);
  assert.deepEqual(
    (await vault.history('Done/Work/Nested/Plan.excalidraw')).map((h) => h.revision),
    [first],
  );
  assert.equal((await vault.history('Work/Nested/Plan.excalidraw')).length, 0);
  assert.deepEqual(await vault.historical('Done/Work/Nested/Plan.excalidraw', first), emptyScene());

  // Moving a file out of a folder removes it from the old parent's custom order.
  await vault.move('Done/Work/Second.excalidraw', 'Second.excalidraw');
  const library = JSON.parse(await fs.readFile(path.join(root, '.workspace/library.json'), 'utf8'));
  assert.deepEqual(library.order['Done/Work'], ['Done/Work/Nested']);

  // Existing history at the destination is merged, not dropped.
  const plan = await vault.read('Done/Work/Nested/Plan.excalidraw');
  const stale = path.join(
    root,
    '.workspace/history',
    createHash('sha256').update('Target.excalidraw').digest('hex'),
  );
  await fs.mkdir(stale, { recursive: true });
  await fs.writeFile(
    path.join(stale, `${'f'.repeat(64)}.excalidraw`),
    JSON.stringify(emptyScene()),
  );
  await vault.move(plan.path, 'Target.excalidraw');
  assert.deepEqual(
    (await vault.history('Target.excalidraw')).map((h) => h.revision).sort(),
    [first, 'f'.repeat(64)].sort(),
  );
});

test('trash keeps metadata and history; restore recreates parents and never overwrites', async (t) => {
  const { vault, root } = await fixture(t);
  await vault.create('Client', 'folder');
  await vault.create('Client/Sketches', 'folder');
  let doc = (await vault.create('Client/Sketches/Logo.excalidraw', 'file'))!;
  const first = doc.revision;
  doc = await vault.save(doc.path, doc.revision, { ...emptyScene(), elements: [{ id: 'x' }] });
  await vault.create('Client/Brief.excalidraw', 'file');
  await vault.create('Client/Notes.excalidraw', 'file');
  await vault.setLibrary(['Client/Sketches/Logo.excalidraw'], 'favorite', true);
  await vault.setLibrary(['Client/Sketches'], 'archived', true);
  await vault.order('Client', [
    'Client/Notes.excalidraw',
    'Client/Sketches',
    'Client/Brief.excalidraw',
  ]);

  // Undo-style restore returns the item to its original place and position.
  const sketches = await vault.trash('Client/Sketches');
  assert.equal(sketches.kind, 'folder');
  assert.equal((await vault.history('Client/Sketches/Logo.excalidraw')).length, 0);
  assert.equal((await byPath(vault))['Client/Brief.excalidraw'].order, 1);
  // A new item at the trashed path does not inherit the trashed metadata.
  await vault.create('Client/Sketches', 'folder');
  assert.equal((await byPath(vault))['Client/Sketches'].archived, false);
  await assert.rejects(vault.restore(sketches.id, 'Client/Sketches'), /exists/);
  const restored = await vault.restore(sketches.id);
  assert.equal(restored, 'Client/Sketches (restored)');
  let entries = await byPath(vault);
  assert.equal(entries['Client/Sketches (restored)/Logo.excalidraw'].favorite, true);
  assert.equal(entries['Client/Sketches (restored)'].archiveRoot, 'Client/Sketches (restored)');
  assert.equal(entries['Client/Sketches'].archived, false);
  assert.deepEqual(
    (await vault.history('Client/Sketches (restored)/Logo.excalidraw')).map((h) => h.revision),
    [first],
  );
  assert.equal((await vault.listTrash()).length, 0);

  // Same path restores at the recorded custom position.
  const notes = await vault.trash('Client/Notes.excalidraw');
  assert.equal(await vault.restore(notes.id), 'Client/Notes.excalidraw');
  assert.equal((await byPath(vault))['Client/Notes.excalidraw'].order, 0);

  // Missing parent folders are recreated; a second collision gets a numbered name.
  const logo = await vault.trash('Client/Sketches (restored)/Logo.excalidraw');
  const client = await vault.trash('Client');
  assert.equal(await vault.restore(logo.id), 'Client/Sketches (restored)/Logo.excalidraw');
  entries = await byPath(vault);
  assert.equal(entries['Client/Sketches (restored)/Logo.excalidraw'].favorite, true);
  assert.equal(entries['Client/Sketches (restored)'].archived, false);
  assert.equal(await vault.restore(client.id), 'Client (restored)');
  await vault.create('Twice.excalidraw', 'file');
  const twice = await vault.trash('Twice.excalidraw');
  await vault.create('Twice.excalidraw', 'file');
  await vault.create('Twice (restored).excalidraw', 'file');
  assert.equal(await vault.restore(twice.id), 'Twice (restored 2).excalidraw');
  assert.equal(
    (await fs.readdir(path.join(root, '.workspace/trash'))).length,
    0,
    'restored records are removed',
  );
});

test('trash records from before workspace metadata still restore', async (t) => {
  const { vault, root } = await fixture(t);
  const id = '00000000-0000-4000-8000-000000000000';
  const directory = path.join(root, '.workspace/trash', id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'meta.json'),
    JSON.stringify({
      id,
      path: 'Gone/Old.excalidraw',
      kind: 'file',
      deleted: new Date().toISOString(),
    }),
  );
  await fs.writeFile(path.join(directory, 'content'), JSON.stringify(emptyScene()));
  await fs.mkdir(path.join(root, '.workspace/trash/broken'));
  await fs.writeFile(path.join(root, '.workspace/trash/broken/content'), '');
  await fs.writeFile(path.join(root, '.workspace/trash/broken/meta.json'), 'not json');
  assert.deepEqual(
    (await vault.listTrash()).map((item) => item.id),
    [id],
  );
  assert.equal(await vault.restore(id), 'Gone/Old.excalidraw');
  assert.equal((await vault.read('Gone/Old.excalidraw')).scene.type, 'excalidraw');
});

test('HTTP metadata operations validate input and report not found', async (t) => {
  const { vault } = await fixture(t);
  const server = createApp(vault).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (endpoint: string, body: unknown) =>
    fetch(`${url}/api${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  await vault.create('A.excalidraw', 'file');
  await vault.create('B.excalidraw', 'file');
  assert.equal(
    (await post('/library', { property: 'favorite', paths: ['A.excalidraw'], value: true })).status,
    200,
  );
  assert.equal(
    (await post('/library', { property: 'pinned', paths: ['A.excalidraw'], value: true })).status,
    400,
  );
  assert.equal(
    (await post('/library', { property: 'archived', paths: ['Z.excalidraw'], value: true })).status,
    404,
  );
  assert.equal(
    (await post('/order', { folder: '', paths: ['B.excalidraw', 'A.excalidraw'] })).status,
    200,
  );
  assert.equal(
    (await post('/order', { folder: '', paths: ['B.excalidraw', 'B.excalidraw'] })).status,
    400,
  );
  const entries = (await (await fetch(`${url}/api/entries`)).json()) as Entry[];
  assert.deepEqual(
    entries.map((entry) => [entry.path, entry.favorite, entry.order]),
    [
      ['A.excalidraw', true, 1],
      ['B.excalidraw', false, 0],
    ],
  );
  const trashed = await (await post('/trash', { path: 'A.excalidraw' })).json();
  assert.equal(trashed.path, 'A.excalidraw');
  await vault.create('A.excalidraw', 'file');
  const restored = await post('/restore', { id: trashed.id });
  assert.deepEqual(await restored.json(), { path: 'A (restored).excalidraw' });
});

test('a folder move cannot make descendants or their metadata exceed the path limit', async (t) => {
  const { vault } = await fixture(t);
  const target = 'T'.repeat(180);
  await vault.create(target, 'folder');
  await vault.create('Tree', 'folder');
  let folder = 'Tree';
  for (let i = 0; i < 5; i++) {
    folder += `/${'L'.repeat(160)}`;
    await vault.create(folder, 'folder');
  }
  const original = `${folder}/Plan.excalidraw`;
  const doc = (await vault.create(original, 'file'))!;
  await vault.setLibrary([original], 'favorite', true);
  await assert.rejects(vault.move('Tree', `${target}/Tree`), /Invalid name or path/);
  assert.equal((await vault.read(original)).revision, doc.revision);
  assert.equal((await byPath(vault))[original].favorite, true);
});

test('restoring into a recreated parent clears metadata left by external deletion', async (t) => {
  const { vault, root } = await fixture(t);
  await vault.create('Old parent', 'folder');
  await vault.create('Old parent/Plan.excalidraw', 'file');
  const trashed = await vault.trash('Old parent/Plan.excalidraw');
  await vault.setLibrary(['Old parent'], 'archived', true);
  await fs.rm(path.join(root, 'Old parent'), { recursive: true });
  assert.equal(await vault.restore(trashed.id), 'Old parent/Plan.excalidraw');
  const all = await byPath(vault);
  assert.equal(all['Old parent'].archived, false);
  assert.equal(all['Old parent/Plan.excalidraw'].archived, false);
});
