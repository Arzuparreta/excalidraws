import { build } from 'vite';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

await build({ configFile: 'vite.editor.config.ts' });
const directory = 'dist/editor';
await cp('node_modules/@excalidraw/excalidraw/dist/prod/fonts', `${directory}/fonts`, {
  recursive: true,
});
await mkdir(`${directory}/licenses`, { recursive: true });
for (const [name, source] of Object.entries({
  react: 'react/LICENSE',
  'react-dom': 'react-dom/LICENSE',
}))
  await cp(`node_modules/${source}`, `${directory}/licenses/${name}.txt`);
await cp('docs/licenses/excalidraw.txt', `${directory}/licenses/excalidraw.txt`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function collect(folder, prefix = '') {
  const files = [];
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      files.push(...(await collect(path.join(folder, entry.name), `${relative}/`)));
    else files.push({ path: relative, bytes: await readFile(path.join(folder, entry.name)) });
  }
  return files;
}
const files = await collect(directory);
const inventory = files.map(({ path, bytes }) => ({
  path,
  size: bytes.length,
  sha256: sha256(bytes),
}));
const packageVersion = JSON.parse(
  await readFile('node_modules/@excalidraw/excalidraw/package.json', 'utf8'),
).version;
// A bounded JSON archive avoids executable installers, symlinks and tar extraction semantics.
const archive = gzipSync(
  JSON.stringify(files.map(({ path, bytes }) => ({ path, data: bytes.toString('base64') }))),
);
// Compression output can change between Node/zlib releases; immutable IDs cover the payload too.
const id = `${packageVersion}-${sha256(JSON.stringify([inventory, sha256(archive)])).slice(0, 20)}`;
const manifest = {
  format: 1,
  contract: 1,
  id,
  packageVersion,
  entry: 'editor.js',
  css: inventory.filter((file) => file.path.endsWith('.css')).map((file) => file.path),
  archive: { sha256: sha256(archive), size: archive.length },
  files: inventory,
};
await mkdir('dist/editor-artifact', { recursive: true });
await writeFile('dist/editor-artifact/editor.json.gz', archive);
await writeFile(
  'dist/editor-artifact/editor-manifest.json',
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(`Editor artifact: ${id} (${archive.length} bytes compressed)`);
