import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import { Vault } from '../server/vault';
import { emptyScene } from '../shared/model';

test('the shared event stream reports external edits, ignores private metadata and closes on shutdown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'excalidraws-events-'));
  const vault = new Vault(root);
  await vault.init();
  const app = createApp(vault);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const controller = new AbortController();
  const response = await fetch(`${url}/api/events`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  let notify!: () => void;
  const changed = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const reading = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      received += decoder.decode(value);
      if (received.includes('event: change')) notify();
    }
  })();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream\b/);
    await fs.writeFile(path.join(root, '.workspace', 'private.json'), '{}');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.doesNotMatch(received, /event: change/);
    await fs.writeFile(path.join(root, 'External.excalidraw'), JSON.stringify(emptyScene()));
    await Promise.race([
      changed,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('No external-change notification')), 3000);
      }),
    ]);
    assert.match(received, /event: change/);
    app.closeStreams();
    await reading;
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await reading.catch(() => {});
    app.closeStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
