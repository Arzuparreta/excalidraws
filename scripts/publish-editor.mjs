import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const repository = process.env.GITHUB_REPOSITORY;
const commit = process.env.GITHUB_SHA;
if (!repository || !commit || process.env.GITHUB_REF !== 'refs/heads/main')
  throw new Error('Publish editor artifacts only from merged main in GitHub Actions.');
const manifest = JSON.parse(await readFile('dist/editor-artifact/editor-manifest.json', 'utf8'));
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(manifest.id)) throw new Error('Invalid artifact ID.');
const tag = `editor-v1-${manifest.id}`;
const channel = 'editor-channel-v1';
const gh = (...args) =>
  execFileSync('gh', [...args, '--repo', repository], { stdio: 'pipe', encoding: 'utf8' });
const exists = (tag) => {
  try {
    gh('release', 'view', tag);
    return true;
  } catch {
    return false;
  }
};
manifest.archive.url = `https://github.com/${repository}/releases/download/${tag}/editor.json.gz`;
await writeFile(
  'dist/editor-artifact/editor-manifest.json',
  JSON.stringify(manifest, null, 2) + '\n',
);
if (!exists(tag)) {
  gh(
    'release',
    'create',
    tag,
    '--target',
    commit,
    '--title',
    `Excalidraw editor ${manifest.packageVersion} (${manifest.id})`,
    '--notes',
    `Official Excalidraw ${manifest.packageVersion}, adapter contract 1. Validated from ${commit}.`,
    '--latest=false',
    '--draft',
  );
}
const release = JSON.parse(gh('release', 'view', tag, '--json', 'isDraft'));
if (release.isDraft) {
  gh(
    'release',
    'upload',
    tag,
    'dist/editor-artifact/editor-manifest.json',
    'dist/editor-artifact/editor.json.gz',
    '--clobber',
  );
  gh('release', 'edit', tag, '--draft=false');
}
// Verify publication (including a resumed run) before promoting the channel.
const downloaded = await mkdtemp(path.join(os.tmpdir(), 'excalidraws-publish-'));
try {
  gh('release', 'download', tag, '--dir', downloaded, '--pattern', 'editor*');
  const remote = JSON.parse(await readFile(path.join(downloaded, 'editor-manifest.json'), 'utf8'));
  const archive = await readFile(path.join(downloaded, 'editor.json.gz'));
  if (
    JSON.stringify(remote) !== JSON.stringify(manifest) ||
    archive.length !== manifest.archive.size ||
    createHash('sha256').update(archive).digest('hex') !== manifest.archive.sha256
  )
    throw new Error('Published editor failed verification; channel was not changed.');
} finally {
  await rm(downloaded, { recursive: true, force: true });
}
// The channel is only a pointer. Its archive always comes from the immutable release.
if (!exists(channel)) {
  gh(
    'release',
    'create',
    channel,
    'dist/editor-artifact/editor-manifest.json',
    '--target',
    commit,
    '--title',
    'Stable editor channel (contract 1)',
    '--notes',
    'Automatically downloaded by compatible Excalidraws shells. Artifacts are validated before promotion.',
    '--latest=false',
  );
} else {
  gh('release', 'upload', channel, 'dist/editor-artifact/editor-manifest.json', '--clobber');
}
console.log(`Published ${tag} and promoted ${channel}`);
