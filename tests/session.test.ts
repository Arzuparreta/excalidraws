import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentSession } from '../src/workspace/session';
import { ApiError } from '../src/workspace/api';
import type { Draft, DraftStore } from '../src/workspace/drafts';
import { emptyScene, type Document, type Scene } from '../shared/model';

const scene = (id: string): Scene => ({ ...emptyScene(), elements: [{ id }] });
const doc = (): Document => ({ path: 'test.excalidraw', revision: 'base', scene: emptyScene() });
const store = () => {
  const values = new Map<string, Draft>();
  return {
    values,
    read: async (p: string) => values.get(p),
    write: async (p: string, d: Draft) => {
      values.set(p, d);
    },
    remove: async (p: string) => {
      values.delete(p);
    },
  } satisfies DraftStore & { values: Map<string, Draft> };
};

test('flush waits for edits made during an in-flight save and carries forward the new revision', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const storage = store();
  const session = new DocumentSession(
    doc(),
    {
      save: async (path, revision, value) => {
        calls.push(revision);
        if (calls.length === 1) await gate;
        return { path, revision: `rev${calls.length}`, scene: value };
      },
      revision: async () => ({ revision: 'base' }),
      read: async () => doc(),
    },
    storage,
  );
  session.change(scene('first'));
  const flushing = session.flush();
  session.change(scene('second'));
  release();
  assert.equal(await flushing, true);
  assert.deepEqual(calls, ['base', 'rev1']);
  assert.equal(session.snapshot().dirty, false);
  assert.equal(storage.values.size, 0);
  session.dispose();
});

test('conflict retains local draft and blocks future saves and document switches', async () => {
  const storage = store();
  let saves = 0;
  const session = new DocumentSession(
    doc(),
    {
      save: async () => {
        saves++;
        throw new ApiError('changed', 'conflict', 409);
      },
      revision: async () => ({ revision: 'remote' }),
      read: async () => doc(),
    },
    storage,
  );
  session.change(scene('mine'));
  assert.equal(await session.flush(), false);
  assert.equal(session.snapshot().status, 'conflict');
  assert.equal(storage.values.get('test.excalidraw')?.scene.elements[0].id, 'mine');
  session.change(scene('more'));
  assert.equal(await session.flush(), false);
  assert.equal(saves, 1);
  session.dispose();
});

test('recovered draft uses its original revision to detect conflicts before any write', async () => {
  let writes = 0;
  const session = new DocumentSession(
    { ...doc(), revision: 'new-server' },
    {
      save: async () => {
        writes++;
        return doc();
      },
      revision: async () => ({ revision: 'new-server' }),
      read: async () => doc(),
    },
    store(),
    { revision: 'old-server', scene: scene('recovered'), updated: 0 },
  );
  assert.equal(session.initialScene.elements[0].id, 'recovered');
  assert.equal(await session.flush(), false);
  assert.equal(writes, 0);
  session.dispose();
});

test('external clean update reloads, dirty update conflicts, offline failures can retry', async () => {
  let offline = true;
  const transport = {
    save: async (path: string, revision: string, value: Scene) => {
      if (offline) throw new Error('offline');
      return { path, revision: 'saved', scene: value };
    },
    revision: async () => ({ revision: 'external' }),
    read: async () => ({ ...doc(), revision: 'external' }),
  };
  const clean = new DocumentSession(doc(), transport, store());
  assert.equal((await clean.checkExternal())?.revision, 'external');
  clean.dispose();
  const dirty = new DocumentSession(doc(), transport, store());
  dirty.change(scene('local'));
  await dirty.checkExternal();
  assert.equal(dirty.snapshot().status, 'conflict');
  dirty.dispose();
  const retry = new DocumentSession(doc(), transport, store());
  retry.change(scene('local'));
  assert.equal(await retry.flush(), false);
  assert.equal(retry.snapshot().status, 'offline');
  offline = false;
  assert.equal(await retry.flush(), true);
  assert.equal(retry.snapshot().status, 'saved');
  retry.dispose();
});

test('a clean file removed externally becomes a recoverable draft', async () => {
  const storage = store();
  const session = new DocumentSession(
    { ...doc(), scene: scene('preserve-me') },
    {
      save: async () => doc(),
      revision: async () => {
        throw new ApiError('missing', 'not_found', 404);
      },
      read: async () => doc(),
    },
    storage,
  );
  await session.checkExternal();
  assert.equal(session.snapshot().status, 'conflict');
  assert.equal(session.snapshot().dirty, true);
  assert.equal(storage.values.get('test.excalidraw')?.scene.elements[0].id, 'preserve-me');
  session.dispose();
});
