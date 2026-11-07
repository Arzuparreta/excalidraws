import { cp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const destination = 'dist/shell';
await rm(destination, { recursive: true, force: true });
await mkdir(`${destination}/dist`, { recursive: true });
for (const directory of ['client', 'server', 'shared'])
  await cp(`dist/${directory}`, `${destination}/dist/${directory}`, { recursive: true });
for (const file of [
  'package.json',
  'package-lock.json',
  'README.md',
  'docs/editor-updates.md',
  'scripts/install-service.mjs',
  'scripts/prepare-service.mjs',
]) {
  await mkdir(`${destination}/${file.slice(0, Math.max(0, file.lastIndexOf('/')))}`, {
    recursive: true,
  });
  await cp(file, `${destination}/${file}`);
}
await writeFile(`${destination}/shell-release.json`, JSON.stringify({ format: 1 }) + '\n');
async function check(folder) {
  for (const file of await readdir(folder, { withFileTypes: true })) {
    if (file.isDirectory()) await check(`${folder}/${file.name}`);
    else if (
      /\.(?:woff2?|ttf|otf)$/.test(file.name) ||
      (folder.startsWith(`${destination}/dist/client`) && file.name === 'editor.js')
    )
      throw new Error('Editor assets must not ship with the shell.');
  }
}
await check(destination);
execFileSync('tar', ['-czf', 'dist/excalidraws-shell.tar.gz', '-C', destination, '.']);
console.log('Shell-only distribution: dist/excalidraws-shell.tar.gz');
