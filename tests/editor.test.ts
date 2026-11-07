import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { EditorManager } from '../server/editor.js';
import { editorManifestSchema } from '../shared/editor.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function artifact(id = 'first') {
  const contents = [
    { path: 'editor.js', data: Buffer.from(`export const contract = 1; // ${id}`) },
    { path: 'editor.css', data: Buffer.from(`/* ${id} */`) },
    { path: 'fonts/font.woff2', data: Buffer.from('font fixture') },
  ];
  const records = contents.map(({ path, data }) => ({ path, data: data.toString('base64') }));
  const archive = gzipSync(JSON.stringify(records));
  const manifest = {
    format: 1,
    contract: 1,
    id,
    packageVersion: '0.18.1',
    entry: 'editor.js',
    css: ['editor.css'],
    archive: { sha256: hash(archive), size: archive.length },
    files: contents.map(({ path, data }) => ({ path, size: data.length, sha256: hash(data) })),
  };
  return { manifest, archive, records };
}
async function fixture(t: { after(fn: () => unknown): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'excalidraws-editor-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let candidate = artifact();
  let offline = false;
  let now = 0;
  let downloads = 0;
  let requests = 0;
  const request: typeof fetch = async (url) => {
    requests++;
    if (offline) throw new Error('Offline fixture');
    if (String(url).endsWith('editor-manifest.json')) return Response.json(candidate.manifest);
    downloads++;
    return new Response(new Uint8Array(candidate.archive));
  };
  const create = () =>
    new EditorManager({
      directory,
      manifestUrl: 'https://publisher.test/editor-manifest.json',
      fetch: request,
      now: () => now,
    });
  return {
    directory,
    create,
    manager: create(),
    candidate: (value: ReturnType<typeof artifact>) => {
      candidate = value;
    },
    offline: () => {
      offline = true;
    },
    advance: () => {
      now += 7 * 60 * 60 * 1000;
    },
    downloads: () => downloads,
    requests: () => requests,
  };
}
async function settled(manager: EditorManager) {
  // Yield event-loop turns until a deliberately started in-process update settles.
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (['ready', 'error'].includes(manager.getStatus().state)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Editor operation did not settle.');
}

test('concurrent cold requests install once, serve only inventory files, and survive offline restart', async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.manager.location(), f.manager.location()]);
  assert.deepEqual(a, b);
  assert.equal(f.downloads(), 1);
  assert.equal(a.entry, '/editor/first/editor.js');
  const filename = await f.manager.asset('first', 'fonts/font.woff2');
  assert.equal(await fs.readFile(filename!, 'utf8'), 'font fixture');
  assert.equal(await f.manager.asset('first', '../current.json'), undefined);
  assert.equal(await f.manager.asset('first', 'manifest.json'), undefined);
  assert.equal(await f.manager.asset('../escape', 'editor.js'), undefined);
  f.offline();
  const restarted = f.create();
  assert.equal((await restarted.location()).id, 'first');
  await settled(restarted);
  assert.equal(restarted.getStatus().state, 'error');
  assert.equal((await restarted.location()).id, 'first');
});

test('successful background update retains old assets and exposes previous editor for module fallback', async (t) => {
  const f = await fixture(t);
  await f.manager.location();
  f.candidate(artifact('second'));
  f.advance();
  assert.equal((await f.manager.location()).id, 'first');
  await settled(f.manager);
  assert.equal((await f.manager.location()).id, 'second');
  assert.equal((await f.manager.location('second')).id, 'first');
  assert.ok(await f.manager.asset('first', 'editor.js'));
  const pointer = JSON.parse(await fs.readFile(path.join(f.directory, 'current.json'), 'utf8'));
  assert.deepEqual(pointer, { current: 'second', previous: 'first' });
  assert.equal(f.downloads(), 2);
});

test('failed background update keeps current pointer and retries only after the check interval', async (t) => {
  const f = await fixture(t);
  await f.manager.location();
  const candidate = artifact('broken');
  candidate.archive[0] ^= 1;
  f.candidate(candidate);
  f.advance();
  assert.equal((await f.manager.location()).id, 'first');
  await settled(f.manager);
  assert.equal(f.manager.getStatus().state, 'error');
  const requests = f.requests();
  assert.equal((await f.manager.location()).id, 'first');
  assert.equal(f.requests(), requests);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.directory, 'current.json'), 'utf8')).current,
    'first',
  );
  assert.equal(
    (await fs.readdir(f.directory)).some((file) => file.startsWith('.staging-')),
    false,
  );
  f.candidate(artifact('fixed'));
  f.advance();
  await f.manager.location();
  await settled(f.manager);
  assert.equal((await f.manager.location()).id, 'fixed');
});

test('cold failure is retryable and partial staging is removed after restart', async (t) => {
  const f = await fixture(t);
  const candidate = artifact();
  candidate.archive[0] ^= 1;
  f.candidate(candidate);
  await assert.rejects(f.manager.location());
  assert.equal(f.manager.getStatus().state, 'error');
  await assert.rejects(fs.access(path.join(f.directory, 'current.json')));
  f.candidate(artifact());
  assert.equal((await f.manager.location()).id, 'first');
  await fs.mkdir(path.join(f.directory, '.staging-interrupted'));
  const restarted = f.create();
  assert.equal((await restarted.location()).id, 'first');
  await settled(restarted);
  await assert.rejects(fs.access(path.join(f.directory, '.staging-interrupted')));
});

test('corrupt current cache falls back to the verified previous version after restart', async (t) => {
  const f = await fixture(t);
  await f.manager.location();
  f.candidate(artifact('second'));
  f.advance();
  await f.manager.location();
  await settled(f.manager);
  await fs.writeFile(path.join(f.directory, 'second/editor.js'), 'corrupt');
  f.offline();
  const restarted = f.create();
  assert.equal((await restarted.location()).id, 'first');
  assert.equal(await restarted.asset('second', 'editor.js'), undefined);
  await settled(restarted);
});

test('a cold cache containing symlinks is not served', async (t) => {
  const f = await fixture(t);
  await f.manager.location();
  await fs.rename(path.join(f.directory, 'first/fonts'), path.join(f.directory, 'font-target'));
  await fs.symlink('../font-target', path.join(f.directory, 'first/fonts'));
  f.offline();
  const restarted = f.create();
  await assert.rejects(restarted.location());
  assert.equal(await restarted.asset('first', 'fonts/font.woff2'), undefined);
});

test('manifest rejects unsafe, duplicate, oversized and incompatible inventories', () => {
  const original = artifact().manifest;
  for (const path of ['../escape', '/absolute', 'a/../b', 'a\\b', 'a//b', '.']) {
    assert.equal(
      editorManifestSchema.safeParse({
        ...original,
        files: [...original.files, { path, size: 1, sha256: 'a'.repeat(64) }],
      }).success,
      false,
    );
  }
  assert.equal(editorManifestSchema.safeParse({ ...original, contract: 2 }).success, false);
  assert.equal(
    editorManifestSchema.safeParse({ ...original, files: [...original.files, original.files[0]] })
      .success,
    false,
  );
  assert.equal(editorManifestSchema.safeParse({ ...original, entry: 'missing.js' }).success, false);
  assert.equal(
    editorManifestSchema.safeParse({
      ...original,
      archive: { ...original.archive, size: 41 * 1024 * 1024 },
    }).success,
    false,
  );
  assert.throws(
    () => new EditorManager({ manifestUrl: 'http://publisher.test/editor-manifest.json' }),
  );
});

for (const corruption of [
  'missing',
  'duplicate',
  'extra',
  'contents',
  'traversal',
  'decompression',
] as const) {
  test(`rejects ${corruption} archive without activating a partial editor`, async (t) => {
    const f = await fixture(t);
    const candidate = artifact();
    if (corruption === 'missing') candidate.records.pop();
    if (corruption === 'duplicate') candidate.records[1] = candidate.records[0];
    if (corruption === 'extra') candidate.records.push({ path: 'extra.js', data: 'ZmlsZQ==' });
    if (corruption === 'contents')
      candidate.records[0].data = Buffer.from('wrong contents').toString('base64');
    if (corruption === 'traversal') candidate.records[0].path = '../escape';
    candidate.archive =
      corruption === 'decompression'
        ? Buffer.from('invalid gzip')
        : gzipSync(JSON.stringify(candidate.records));
    candidate.manifest.archive = {
      size: candidate.archive.length,
      sha256: hash(candidate.archive),
    };
    f.candidate(candidate);
    await assert.rejects(f.manager.location());
    assert.equal(await f.manager.asset('first', 'editor.js'), undefined);
    await assert.rejects(fs.access(path.join(f.directory, 'current.json')));
    assert.equal(
      (await fs.readdir(f.directory)).some((file) => file.startsWith('.staging-')),
      false,
    );
  });
}
