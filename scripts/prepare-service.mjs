#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repo = process.cwd();
const marker = path.join(repo, 'node_modules/.excalidraws-service-dependencies');
const environment = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
};

const optionalRead = async (file) =>
  readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });

async function fingerprint() {
  const files = await Promise.all([
    readFile(path.join(repo, 'package.json'), 'utf8'),
    readFile(path.join(repo, 'package-lock.json'), 'utf8'),
    optionalRead(path.join(repo, 'node_modules/.package-lock.json')),
  ]);
  return createHash('sha256')
    .update(JSON.stringify([process.version, process.platform, process.arch, ...files]))
    .digest('hex');
}

function npm(args) {
  const result = spawnSync('npm', args, { cwd: repo, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.status})`);
}

try {
  if ((await optionalRead(marker)) !== (await fingerprint())) {
    console.log('Synchronizing service dependencies, including the build tools…');
    npm(['ci', '--include=dev', '--no-audit', '--no-fund']);
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, await fingerprint());
  }
  console.log(`Building Excalidraws from ${repo}…`);
  npm(['run', 'build']);
} catch (error) {
  console.error('Service preparation failed; the server will not start.', error);
  process.exitCode = 1;
}
