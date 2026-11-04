import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { Vault } from './vault.js';

const root = process.env.VAULT_DIR ?? path.resolve('data');
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const vault = new Vault(root);
await vault.init();
const unlock = await vault.lock();
const client = fileURLToPath(new URL('../client', import.meta.url));
const server = createApp(vault, client).listen(port, host, () => {
  console.log(`Excalidraws: http://${host}:${port} · vault ${vault.root}`);
});
server.on('error', async (error) => {
  console.error(error);
  await unlock();
  process.exit(1);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(async () => {
      await unlock();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}
