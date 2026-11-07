import { spawn } from 'node:child_process';
import path from 'node:path';
import { artifactServer } from './artifact-server.mjs';

const publisher = await artifactServer();
const child = spawn('npx', ['tsx', 'watch', 'server/main.ts'], {
  env: {
    ...process.env,
    EDITOR_MANIFEST_URL: publisher.url,
    EDITOR_CACHE_DIR: path.resolve('node_modules/.cache/excalidraws-editors'),
  },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill('SIGTERM'));
child.on('exit', (code) => {
  publisher.close();
  process.exit(code ?? 0);
});
