import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EMPTY_REVISION, Vault, VaultError } from '../server/vault.js';
import { canvasLink } from '../shared/canvas.js';
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
  await vault.create('Ideas.excalidraw');
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
  const created = (await vault.create('Ideas/🌳 Tree.excalidraw', scene))!;
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
  const doc = (await vault.create('Shared.excalidraw'))!;
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

test('nested canvases move, trash and restore with their contents and reject collisions', async (t) => {
  const { vault, root } = await fixture(t);
  await vault.create('Project.excalidraw');
  await vault.create('Other.excalidraw');
  await vault.create('Project/Plan.excalidraw');
  assert.ok((await fs.stat(path.join(root, 'Project'))).isDirectory());
  await vault.move('Project/Plan.excalidraw', 'Other/Roadmap.excalidraw');
  // The content folder exists only while its canvas contains canvases.
  await assert.rejects(fs.stat(path.join(root, 'Project')), /ENOENT/);
  await assert.rejects(
    vault.move('Other.excalidraw', 'Other/Roadmap/Inside.excalidraw'),
    /inside itself/,
  );
  const trash = await vault.trash('Other.excalidraw');
  assert.deepEqual(
    (await vault.list()).map((e) => e.path),
    ['Project.excalidraw'],
  );
  assert.deepEqual(
    (await vault.listTrash()).map(({ path, inside }) => ({ path, inside })),
    [{ path: 'Other.excalidraw', inside: 1 }],
  );
  await vault.create('Other.excalidraw');
  await assert.rejects(vault.restore(trash.id, 'Other.excalidraw'), /exists/);
  await vault.restore(trash.id, 'Recovered.excalidraw');
  assert.equal((await vault.read('Recovered/Roadmap.excalidraw')).scene.type, 'excalidraw');
  assert.equal((await byPath(vault))['Recovered.excalidraw'].children, 1);
  assert.equal((await vault.listTrash()).length, 0);
});

test('a canvas keeps the canvases inside it in a folder with the same name', async (t) => {
  const { vault, root } = await fixture(t);
  const missing = (e: unknown) => e instanceof VaultError && e.status === 404;
  await vault.create('Ideas.excalidraw');
  await assert.rejects(vault.create('Missing/Child.excalidraw'), missing);
  await vault.create('Ideas/Idea A.excalidraw');
  await vault.create('Ideas/Idea B.excalidraw');
  await vault.create('Ideas/Idea B/Detail.excalidraw');
  let entries = await byPath(vault);
  assert.deepEqual(Object.keys(entries).sort(), [
    'Ideas.excalidraw',
    'Ideas/Idea A.excalidraw',
    'Ideas/Idea B.excalidraw',
    'Ideas/Idea B/Detail.excalidraw',
  ]);
  assert.equal(entries['Ideas.excalidraw'].children, 2);
  assert.equal(entries['Ideas/Idea B.excalidraw'].children, 1);
  assert.equal(entries['Ideas/Idea A.excalidraw'].children, 0);
  // A name is taken by the canvas file and by its content folder.
  await assert.rejects(vault.create('Ideas/Idea B.excalidraw'), /exists/);
  await fs.mkdir(path.join(root, 'Loose'));
  entries = await byPath(vault);
  assert.equal(entries['Loose.excalidraw'].unsaved, true);
  assert.equal(entries['Loose.excalidraw'].children, 0);
  await assert.rejects(vault.create('Loose.excalidraw'), /exists/);

  // A canvas without a file opens empty; its first save writes the file.
  const loose = await vault.read('Loose.excalidraw');
  assert.equal(loose.revision, EMPTY_REVISION);
  assert.deepEqual(loose.scene, emptyScene());
  assert.equal(await vault.revision('Loose.excalidraw'), EMPTY_REVISION);
  await assert.rejects(vault.save('Loose.excalidraw', 'stale', emptyScene()), conflict);
  const saved = await vault.save('Loose.excalidraw', loose.revision, {
    ...emptyScene(),
    elements: [{ id: 'first' }],
  });
  assert.equal(saved.revision, await vault.revision('Loose.excalidraw'));
  assert.ok((await fs.stat(path.join(root, 'Loose.excalidraw'))).isFile());
  assert.equal((await byPath(vault))['Loose.excalidraw'].unsaved, undefined);

  // Moving the last canvas out removes the empty folder, unless it is the canvas itself.
  await vault.move('Ideas/Idea B/Detail.excalidraw', 'Loose/Detail.excalidraw');
  await assert.rejects(fs.stat(path.join(root, 'Ideas/Idea B')), /ENOENT/);
  assert.equal((await byPath(vault))['Loose.excalidraw'].children, 1);
  await fs.mkdir(path.join(root, 'Box'));
  await vault.create('Box/Only.excalidraw');
  await vault.trash('Box/Only.excalidraw');
  assert.ok((await fs.stat(path.join(root, 'Box'))).isDirectory());
  assert.equal((await byPath(vault))['Box.excalidraw'].unsaved, true);

  // Moving or trashing a canvas without a file carries its folder.
  await vault.create('Box/Inner.excalidraw');
  await vault.move('Box.excalidraw', 'Ideas/Box.excalidraw');
  entries = await byPath(vault);
  assert.equal(entries['Ideas/Box.excalidraw'].unsaved, true);
  assert.ok(entries['Ideas/Box/Inner.excalidraw']);
  const box = await vault.trash('Ideas/Box.excalidraw');
  assert.equal(box.inside, 1);
  assert.equal(await vault.restore(box.id), 'Ideas/Box.excalidraw');
  assert.ok((await byPath(vault))['Ideas/Box/Inner.excalidraw']);
});

test('moving a canvas rewrites the links that point into it', async (t) => {
  const { vault } = await fixture(t);
  const element = (id: string, link: string | null) => ({ id, type: 'text', version: 3, link });
  await vault.create('Ideas.excalidraw', {
    ...emptyScene(),
    elements: [
      element('a', canvasLink('Ideas/Idea A.excalidraw')),
      element('b', 'https://example.com/?canvas=Ideas/Idea%20A.excalidraw'),
      element('c', canvasLink('Ideas/Idea A/Deep.excalidraw')),
      element('d', canvasLink('Ideas/Idea AB.excalidraw')),
      element('e', null),
    ],
  });
  await vault.create('Ideas/Idea A.excalidraw');
  await vault.create('Ideas/Idea A/Deep.excalidraw');
  await vault.create('Index.excalidraw', {
    ...emptyScene(),
    elements: [element('x', canvasLink('Ideas/Idea A.excalidraw'))],
  });
  await vault.create('Plain.excalidraw');
  const before = await vault.read('Ideas.excalidraw');
  const plain = await vault.read('Plain.excalidraw');
  const { links } = await vault.move(
    'Ideas/Idea A.excalidraw',
    'Ideas/Renamed.excalidraw',
    'Index.excalidraw',
  );
  assert.deepEqual(await links, ['Ideas.excalidraw']);
  const elements = (await vault.read('Ideas.excalidraw')).scene.elements;
  assert.deepEqual(
    elements.map((item) => item.link),
    [
      canvasLink('Ideas/Renamed.excalidraw'),
      'https://example.com/?canvas=Ideas/Idea%20A.excalidraw',
      canvasLink('Ideas/Renamed/Deep.excalidraw'),
      canvasLink('Ideas/Idea AB.excalidraw'),
      null,
    ],
  );
  assert.deepEqual(
    elements.map((item) => item.version),
    [4, 3, 4, 3, 3],
  );
  // The previous scene is kept as a version; excluded and unrelated canvases are untouched.
  assert.equal((await vault.history('Ideas.excalidraw'))[0].revision, before.revision);
  assert.equal(
    (await vault.read('Index.excalidraw')).scene.elements[0].link,
    canvasLink('Ideas/Idea A.excalidraw'),
  );
  assert.equal((await vault.read('Plain.excalidraw')).revision, plain.revision);
  assert.equal(canvasLink('A+B & C#1/D.excalidraw'), '/?canvas=A%2BB%20%26%20C%231/D.excalidraw');
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
    await assert.rejects(vault.create(name), VaultError);
  }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, 'Link'));
  await assert.rejects(vault.create('Link/escape.excalidraw'), /Symbolic links/);
  await fs.writeFile(path.join(root, 'invalid.excalidraw'), '{}');
  await assert.rejects(vault.read('invalid.excalidraw'), /valid/);
  assert.equal(
    (await vault.list()).some((e) => e.path === 'Link.excalidraw'),
    false,
  );
});

test('retains only 20 previous revisions and locks out a second service', async (t) => {
  const { vault, root } = await fixture(t);
  const unlock = await vault.lock();
  t.after(unlock);
  await assert.rejects(new Vault(root).lock(), /already open/);
  let doc = (await vault.create('History.excalidraw'))!;
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
    (await post('/entries', { path: 'X.excalidraw' }, { Origin: 'https://evil.test' })).status,
    403,
  );
  assert.equal((await post('/entries', { path: '../X.excalidraw' })).status, 400);
  assert.equal((await post('/entries', { path: 'X.excalidraw' })).status, 201);
  assert.equal((await post('/entries', { path: 'X.excalidraw' })).status, 409);
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
  await vault.create('Projects.excalidraw');
  await vault.create('Projects/Alpha.excalidraw');
  await vault.create('Projects/Beta.excalidraw');
  await vault.create('Projects/Gamma.excalidraw');
  await vault.create('Projects/Old.excalidraw');
  await vault.create('Projects/Old/Legacy.excalidraw');
  const before = await snapshotFile(path.join(root, 'Projects/Alpha.excalidraw'));

  await vault.setLibrary(['Projects/Alpha.excalidraw', 'Projects.excalidraw'], 'favorite', true);
  await vault.setLibrary(['Projects/Old.excalidraw'], 'archived', true);
  await vault.setLibrary(['Projects/Old/Legacy.excalidraw'], 'archived', true);
  await vault.order('Projects', ['Projects/Gamma.excalidraw', 'Projects/Alpha.excalidraw']);

  // A restarted service reads the same metadata.
  const entries = await byPath(new Vault(root));
  assert.equal(entries['Projects/Alpha.excalidraw'].favorite, true);
  assert.equal(entries['Projects.excalidraw'].favorite, true);
  assert.equal(entries['Projects/Beta.excalidraw'].favorite, false);
  assert.equal(entries['Projects/Old.excalidraw'].archived, true);
  assert.equal(entries['Projects/Old.excalidraw'].archiveRoot, 'Projects/Old.excalidraw');
  assert.equal(
    entries['Projects/Old/Legacy.excalidraw'].archiveRoot,
    'Projects/Old/Legacy.excalidraw',
  );
  assert.equal(entries['Projects/Alpha.excalidraw'].archived, false);
  assert.equal(entries['Projects/Alpha.excalidraw'].archiveRoot, undefined);
  assert.deepEqual(
    ['Gamma', 'Alpha', 'Beta', 'Old'].map((name) => entries[`Projects/${name}.excalidraw`].order),
    [0, 1, 2, 3],
  );
  assert.deepEqual(await snapshotFile(path.join(root, 'Projects/Alpha.excalidraw')), before);

  // Clearing the explicit nested flag leaves the inherited archive state.
  await vault.setLibrary(['Projects/Old/Legacy.excalidraw'], 'archived', false);
  assert.equal(
    (await byPath(vault))['Projects/Old/Legacy.excalidraw'].archiveRoot,
    'Projects/Old.excalidraw',
  );
  await vault.setLibrary(['Projects/Old.excalidraw'], 'archived', false);
  assert.equal((await byPath(vault))['Projects/Old/Legacy.excalidraw'].archived, false);
  await vault.order('Projects', []);
  assert.equal((await byPath(vault))['Projects/Alpha.excalidraw'].order, 0);
});

test('metadata recorded for folders by earlier versions applies to their canvases', async (t) => {
  const { vault, root } = await fixture(t);
  await vault.create('Ideas.excalidraw');
  await vault.create('Ideas/Old.excalidraw');
  await vault.create('Top.excalidraw');
  await fs.writeFile(
    path.join(root, '.workspace/library.json'),
    JSON.stringify({
      version: 1,
      favorites: ['Ideas'],
      archived: ['Ideas/Old'],
      order: { '': ['Top.excalidraw', 'Ideas'] },
    }),
  );
  const entries = await byPath(vault);
  assert.equal(entries['Ideas.excalidraw'].favorite, true);
  assert.equal(entries['Ideas/Old.excalidraw'].archiveRoot, 'Ideas/Old.excalidraw');
  assert.equal(entries['Top.excalidraw'].order, 0);
  assert.equal(entries['Ideas.excalidraw'].order, 1);
});

test('metadata operations validate paths, siblings and duplicates', async (t) => {
  const { vault } = await fixture(t);
  await vault.create('A.excalidraw');
  await vault.create('A/B.excalidraw');
  await vault.create('A/one.excalidraw');
  await vault.create('top.excalidraw');
  const invalid = (e: unknown) => e instanceof VaultError && e.status === 400;
  const missing = (e: unknown) => e instanceof VaultError && e.status === 404;
  await assert.rejects(vault.order('A', ['top.excalidraw']), invalid);
  await assert.rejects(vault.order('A', ['A/one.excalidraw', 'A/one.excalidraw']), invalid);
  await assert.rejects(vault.order('A/B', ['A.excalidraw']), invalid);
  await assert.rejects(vault.order('A', ['A.excalidraw']), invalid);
  await assert.rejects(vault.order('A', ['A/B']), invalid);
  await assert.rejects(vault.order('A', ['A/missing.excalidraw']), missing);
  await assert.rejects(vault.order('Missing', ['Missing/x.excalidraw']), missing);
  await assert.rejects(vault.order('', ['../x.excalidraw']), invalid);
  await assert.rejects(
    vault.setLibrary(['A.excalidraw', 'A.excalidraw'], 'favorite', true),
    invalid,
  );
  await assert.rejects(vault.setLibrary([], 'favorite', true), invalid);
  await assert.rejects(vault.setLibrary(['.workspace'], 'archived', true), invalid);
  await assert.rejects(vault.setLibrary(['A'], 'archived', true), invalid);
  await assert.rejects(vault.setLibrary(['Nothing.excalidraw'], 'favorite', true), missing);
  await vault.setLibrary(['Nothing.excalidraw'], 'favorite', false);
  // Clearing the order of a canvas that no longer contains canvases is not an error.
  await vault.order('Missing', []);
  await vault.order('', ['top.excalidraw', 'A.excalidraw']);
  const entries = await byPath(vault);
  assert.equal(entries['top.excalidraw'].order, 0);
  assert.equal(entries['A.excalidraw'].order, 1);
});

test('invalid metadata is preserved for diagnosis and replaced on the next change', async (t) => {
  const { vault, root } = await fixture(t);
  await vault.create('Plan.excalidraw');
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

test('moves rewrite metadata and history follows canvases and their contents', async (t) => {
  const { vault, root } = await fixture(t);
  await vault.create('Work.excalidraw');
  let inner = await vault.create('Work/Inner.excalidraw');
  inner = await vault.save(inner.path, inner.revision, {
    ...emptyScene(),
    elements: [{ id: 'inner' }],
  });
  await vault.create('Done.excalidraw');
  let doc = await vault.create('Work/Inner/Plan.excalidraw');
  const first = doc.revision;
  doc = await vault.save(doc.path, doc.revision, { ...emptyScene(), elements: [{ id: 'a' }] });
  await vault.create('Work/Second.excalidraw');
  await vault.setLibrary(['Work/Inner/Plan.excalidraw'], 'favorite', true);
  await vault.setLibrary(['Work/Inner.excalidraw'], 'archived', true);
  await vault.order('Work', ['Work/Second.excalidraw', 'Work/Inner.excalidraw']);
  await vault.order('Work/Inner', ['Work/Inner/Plan.excalidraw']);

  // Rename keeps the position in the custom order.
  await vault.move('Work/Inner.excalidraw', 'Work/Nested.excalidraw');
  let entries = await byPath(vault);
  assert.equal(entries['Work/Nested.excalidraw'].order, 1);
  assert.equal(entries['Work/Nested.excalidraw'].children, 1);
  assert.equal(entries['Work/Nested/Plan.excalidraw'].favorite, true);
  assert.equal(entries['Work/Nested/Plan.excalidraw'].archiveRoot, 'Work/Nested.excalidraw');
  assert.deepEqual(
    (await vault.history('Work/Nested/Plan.excalidraw')).map((h) => h.revision),
    [first],
  );
  assert.equal((await vault.history('Work/Nested.excalidraw')).length, 1);
  const library = () =>
    fs.readFile(path.join(root, '.workspace/library.json'), 'utf8').then(JSON.parse);
  assert.deepEqual((await library()).order['Work/Nested'], ['Work/Nested/Plan.excalidraw']);

  // Moving an ancestor carries the history of the canvases inside it along.
  await vault.move('Work.excalidraw', 'Done/Work.excalidraw');
  entries = await byPath(vault);
  assert.equal(entries['Done/Work/Nested/Plan.excalidraw'].favorite, true);
  assert.equal(entries['Done/Work/Second.excalidraw'].order, 0);
  assert.deepEqual(
    (await vault.history('Done/Work/Nested/Plan.excalidraw')).map((h) => h.revision),
    [first],
  );
  assert.equal((await vault.history('Work/Nested/Plan.excalidraw')).length, 0);
  assert.deepEqual(await vault.historical('Done/Work/Nested/Plan.excalidraw', first), emptyScene());

  // Moving a canvas out removes it from the old parent's custom order.
  await vault.move('Done/Work/Second.excalidraw', 'Second.excalidraw');
  assert.deepEqual((await library()).order['Done/Work'], ['Done/Work/Nested.excalidraw']);

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
  await vault.create('Client.excalidraw');
  await vault.create('Client/Sketches.excalidraw');
  let doc = await vault.create('Client/Sketches/Logo.excalidraw');
  const first = doc.revision;
  doc = await vault.save(doc.path, doc.revision, { ...emptyScene(), elements: [{ id: 'x' }] });
  await vault.create('Client/Brief.excalidraw');
  await vault.create('Client/Notes.excalidraw');
  await vault.setLibrary(['Client/Sketches/Logo.excalidraw'], 'favorite', true);
  await vault.setLibrary(['Client/Sketches.excalidraw'], 'archived', true);
  await vault.order('Client', [
    'Client/Notes.excalidraw',
    'Client/Sketches.excalidraw',
    'Client/Brief.excalidraw',
  ]);

  // Undo-style restore returns the canvas to its original place and position.
  const sketches = await vault.trash('Client/Sketches.excalidraw');
  assert.equal(sketches.inside, 1);
  assert.equal((await vault.history('Client/Sketches/Logo.excalidraw')).length, 0);
  assert.equal((await byPath(vault))['Client/Brief.excalidraw'].order, 1);
  // A new canvas at the trashed path does not inherit the trashed metadata.
  await vault.create('Client/Sketches.excalidraw');
  assert.equal((await byPath(vault))['Client/Sketches.excalidraw'].archived, false);
  await assert.rejects(vault.restore(sketches.id, 'Client/Sketches.excalidraw'), /exists/);
  const restored = await vault.restore(sketches.id);
  assert.equal(restored, 'Client/Sketches (restored).excalidraw');
  let entries = await byPath(vault);
  assert.equal(entries['Client/Sketches (restored)/Logo.excalidraw'].favorite, true);
  assert.equal(
    entries['Client/Sketches (restored).excalidraw'].archiveRoot,
    'Client/Sketches (restored).excalidraw',
  );
  assert.equal(entries['Client/Sketches.excalidraw'].archived, false);
  assert.deepEqual(
    (await vault.history('Client/Sketches (restored)/Logo.excalidraw')).map((h) => h.revision),
    [first],
  );
  assert.equal((await vault.listTrash()).length, 0);

  // Same path restores at the recorded custom position.
  const notes = await vault.trash('Client/Notes.excalidraw');
  assert.equal(await vault.restore(notes.id), 'Client/Notes.excalidraw');
  assert.equal((await byPath(vault))['Client/Notes.excalidraw'].order, 0);

  // Missing containing canvases come back without files; a second collision is numbered.
  const logo = await vault.trash('Client/Sketches (restored)/Logo.excalidraw');
  const client = await vault.trash('Client.excalidraw');
  assert.equal(client.inside, 4);
  assert.equal(await vault.restore(logo.id), 'Client/Sketches (restored)/Logo.excalidraw');
  entries = await byPath(vault);
  assert.equal(entries['Client/Sketches (restored)/Logo.excalidraw'].favorite, true);
  assert.equal(entries['Client/Sketches (restored).excalidraw'].archived, false);
  assert.equal(entries['Client/Sketches (restored).excalidraw'].unsaved, true);
  assert.equal(entries['Client.excalidraw'].unsaved, true);
  assert.equal(await vault.restore(client.id), 'Client (restored).excalidraw');
  assert.equal((await byPath(vault))['Client (restored).excalidraw'].children, 4);
  await vault.create('Twice.excalidraw');
  const twice = await vault.trash('Twice.excalidraw');
  await vault.create('Twice.excalidraw');
  await vault.create('Twice (restored).excalidraw');
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
  assert.equal((await byPath(vault))['Gone.excalidraw'].unsaved, true);
});

test('a folder trashed by an earlier version comes back as a canvas', async (t) => {
  const { vault, root } = await fixture(t);
  const id = '00000000-0000-4000-8000-000000000001';
  const directory = path.join(root, '.workspace/trash', id);
  await fs.mkdir(path.join(directory, 'content/Sub'), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'meta.json'),
    JSON.stringify({ id, path: 'Box', kind: 'folder', deleted: new Date().toISOString() }),
  );
  await fs.writeFile(
    path.join(directory, 'content/Inside.excalidraw'),
    JSON.stringify(emptyScene()),
  );
  await fs.writeFile(
    path.join(directory, 'content/Sub/Deep.excalidraw'),
    JSON.stringify(emptyScene()),
  );
  const history = path.join(
    directory,
    'history',
    createHash('sha256').update('Inside.excalidraw').digest('hex'),
  );
  await fs.mkdir(history, { recursive: true });
  await fs.writeFile(
    path.join(history, `${'a'.repeat(64)}.excalidraw`),
    JSON.stringify(emptyScene()),
  );
  await fs.writeFile(
    path.join(directory, 'library.json'),
    JSON.stringify({ version: 1, favorites: ['', 'Sub'], archived: [], order: {} }),
  );
  assert.deepEqual(
    (await vault.listTrash()).map(({ path, inside }) => ({ path, inside })),
    [{ path: 'Box.excalidraw', inside: 3 }],
  );
  assert.equal(await vault.restore(id), 'Box.excalidraw');
  const entries = await byPath(vault);
  assert.equal(entries['Box.excalidraw'].unsaved, true);
  assert.equal(entries['Box.excalidraw'].favorite, true);
  assert.equal(entries['Box/Sub.excalidraw'].favorite, true);
  assert.equal(entries['Box/Sub.excalidraw'].children, 1);
  assert.deepEqual(
    (await vault.history('Box/Inside.excalidraw')).map((h) => h.revision),
    ['a'.repeat(64)],
  );
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
  await vault.create('A.excalidraw');
  await vault.create('B.excalidraw');
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
  await vault.create('A.excalidraw');
  const restored = await post('/restore', { id: trashed.id });
  assert.deepEqual(await restored.json(), { path: 'A (restored).excalidraw' });
});

test('a move cannot make contained canvases or their metadata exceed the path limit', async (t) => {
  const { vault } = await fixture(t);
  const target = `${'T'.repeat(169)}.excalidraw`;
  await vault.create(target);
  await vault.create('Tree.excalidraw');
  let folder = 'Tree';
  for (let i = 0; i < 6; i++) {
    await vault.create(`${folder}/${'L'.repeat(160)}.excalidraw`);
    folder += `/${'L'.repeat(160)}`;
  }
  const original = `${folder}/Plan.excalidraw`;
  const doc = await vault.create(original);
  await vault.setLibrary([original], 'favorite', true);
  await assert.rejects(
    vault.move('Tree.excalidraw', `${'T'.repeat(169)}/Tree.excalidraw`),
    /Invalid name or path/,
  );
  assert.equal((await vault.read(original)).revision, doc.revision);
  assert.equal((await byPath(vault))[original].favorite, true);
  assert.equal((await byPath(vault))[target].children, 0);
});

test('restoring into a recreated parent clears metadata left by external deletion', async (t) => {
  const { vault, root } = await fixture(t);
  await vault.create('Old parent.excalidraw');
  await vault.create('Old parent/Plan.excalidraw');
  await vault.create('Kept.excalidraw');
  await vault.create('Kept/Note.excalidraw');
  const trashed = await vault.trash('Old parent/Plan.excalidraw');
  const note = await vault.trash('Kept/Note.excalidraw');
  await vault.setLibrary(['Old parent.excalidraw', 'Kept.excalidraw'], 'archived', true);
  await fs.rm(path.join(root, 'Old parent.excalidraw'));
  assert.equal(await vault.restore(trashed.id), 'Old parent/Plan.excalidraw');
  // A containing canvas that still exists keeps its metadata.
  assert.equal(await vault.restore(note.id), 'Kept/Note.excalidraw');
  const all = await byPath(vault);
  assert.equal(all['Old parent.excalidraw'].archived, false);
  assert.equal(all['Old parent.excalidraw'].unsaved, true);
  assert.equal(all['Old parent/Plan.excalidraw'].archived, false);
  assert.equal(all['Kept.excalidraw'].archived, true);
});
