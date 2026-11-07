import { artifactServer } from './artifact-server.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const directory = await mkdtemp(path.join(os.tmpdir(), 'excalidraws-e2e-'));
const publisher = await artifactServer();
const child = spawn(process.execPath, ['dist/server/main.js'], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '4317',
    VAULT_DIR: path.join(directory, 'vault'),
    EDITOR_CACHE_DIR: path.join(directory, 'editors'),
    EDITOR_MANIFEST_URL: publisher.url,
  },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill('SIGTERM'));
child.on('exit', async (code) => {
  publisher.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(code ?? 0);
});
