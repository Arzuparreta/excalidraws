import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  editorManifestSchema,
  editorPath,
  MAX_EDITOR_BYTES,
  type EditorLocation,
  type EditorManifest,
  type EditorStatus,
} from '../shared/editor.js';

const CHANNEL =
  'https://github.com/Arzuparreta/excalidraws/releases/download/editor-channel-v1/editor-manifest.json';
const INTERVAL = 6 * 60 * 60 * 1000;
const MAX_ARCHIVE = 40 * 1024 * 1024;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const pointerSchema = z.object({ current: z.string(), previous: z.string().optional() });
const archiveSchema = z.array(z.object({ path: editorPath, data: z.string() })).max(1000);

export interface EditorManagerOptions {
  directory?: string;
  manifestUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Owns trusted editor artifacts, never document data or npm installation. */
export class EditorManager {
  readonly directory: string;
  private readonly manifestUrl: URL;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private initialized?: Promise<void>;
  private pending?: Promise<EditorManifest>;
  private versions = new Map<string, EditorManifest>();
  private current?: string;
  private previous?: string;
  private checked = -Infinity;
  private status: EditorStatus = { state: 'idle', received: 0, total: 0 };

  constructor(options: EditorManagerOptions = {}) {
    this.directory = path.resolve(
      options.directory ??
        process.env.EDITOR_CACHE_DIR ??
        path.join(
          process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
          'excalidraws/editors',
        ),
    );
    this.manifestUrl = new URL(options.manifestUrl ?? process.env.EDITOR_MANIFEST_URL ?? CHANNEL);
    if (
      this.manifestUrl.protocol !== 'https:' &&
      !(
        this.manifestUrl.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(this.manifestUrl.hostname)
      )
    )
      throw new Error('Editor publisher must use HTTPS (or loopback HTTP).');
    if (
      this.manifestUrl.username ||
      this.manifestUrl.password ||
      this.manifestUrl.search ||
      this.manifestUrl.hash
    )
      throw new Error(
        'Editor manifest URL cannot contain credentials, query parameters or a fragment.',
      );
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  getStatus(): EditorStatus {
    return { ...this.status };
  }

  private init() {
    return (this.initialized ??= (async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (const name of await fs.readdir(this.directory))
        if (name.startsWith('.staging-'))
          await fs.rm(path.join(this.directory, name), { recursive: true, force: true });
      try {
        const pointer = pointerSchema.parse(
          JSON.parse(await fs.readFile(path.join(this.directory, 'current.json'), 'utf8')),
        );
        for (const id of [pointer.current, pointer.previous]) {
          if (!id) continue;
          try {
            await this.cached(id);
          } catch {
            /* An incomplete or corrupt cache is never served. */
          }
        }
        this.current = this.versions.has(pointer.current)
          ? pointer.current
          : pointer.previous && this.versions.has(pointer.previous)
            ? pointer.previous
            : undefined;
        this.previous =
          pointer.previous !== this.current &&
          pointer.previous &&
          this.versions.has(pointer.previous)
            ? pointer.previous
            : undefined;
      } catch {
        /* Cold cache or interrupted pointer write: download a complete artifact. */
      }
      if (this.current) this.status = { state: 'ready', received: 0, total: 0 };
    })());
  }

  private async cached(id: string): Promise<EditorManifest> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id)) throw new Error('Invalid editor ID.');
    const known = this.versions.get(id);
    if (known) return known;
    const folder = path.join(this.directory, id);
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid editor directory.');
    const metadata = path.join(folder, 'manifest.json');
    if ((await fs.lstat(metadata)).isSymbolicLink() || (await fs.stat(metadata)).size > 256 * 1024)
      throw new Error('Invalid cached editor manifest.');
    const manifest = editorManifestSchema.parse(JSON.parse(await fs.readFile(metadata, 'utf8')));
    if (manifest.id !== id) throw new Error('Editor ID mismatch.');
    for (const file of manifest.files) {
      const filename = path.join(folder, file.path);
      // Reject symlinks at every level, including font/chunk directories.
      let segment = folder;
      for (const part of file.path.split('/')) {
        segment = path.join(segment, part);
        if ((await fs.lstat(segment)).isSymbolicLink())
          throw new Error('Invalid cached editor path.');
      }
      const stat = await fs.stat(filename);
      if (
        !stat.isFile() ||
        stat.size !== file.size ||
        sha256(await fs.readFile(filename)) !== file.sha256
      )
        throw new Error('Cached editor integrity check failed.');
    }
    this.versions.set(id, manifest);
    return manifest;
  }

  private async download(url: URL, limit: number, progress = false) {
    const response = await this.request(url, {
      signal: AbortSignal.timeout(120_000),
      headers: { 'User-Agent': 'Excalidraws-Editor-Updater' },
    });
    if (!response.ok || !response.body)
      throw new Error(`Editor download failed (HTTP ${response.status}).`);
    // A configured HTTPS publisher may redirect to its artifact CDN, but never plain HTTP.
    if (url.protocol === 'https:' && response.url && new URL(response.url).protocol !== 'https:')
      throw new Error('Insecure editor download redirect.');
    const declared = Number(response.headers.get('content-length'));
    if (declared > limit) {
      await response.body.cancel();
      throw new Error('Editor download exceeds its size limit.');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw new Error('Editor download exceeds its size limit.');
        chunks.push(Buffer.from(value));
        if (progress) this.status.received = size;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks);
  }

  private install(): Promise<EditorManifest> {
    if (this.pending) return this.pending;
    this.checked = this.now();
    this.status = { state: 'checking', received: 0, total: 0 };
    this.pending = (async () => {
      const manifest = editorManifestSchema.parse(
        JSON.parse((await this.download(this.manifestUrl, 256 * 1024)).toString('utf8')),
      );
      if (manifest.id === this.current) {
        const current = this.versions.get(manifest.id)!;
        if (
          JSON.stringify(current.files) !== JSON.stringify(manifest.files) ||
          current.entry !== manifest.entry ||
          JSON.stringify(current.css) !== JSON.stringify(manifest.css)
        )
          throw new Error('Editor ID was reused.');
        return current;
      }
      try {
        const existing = await this.cached(manifest.id);
        // Immutable IDs may not be reused for another inventory.
        if (JSON.stringify(existing) !== JSON.stringify(manifest))
          throw new Error('Editor ID was reused.');
      } catch {
        if (this.versions.has(manifest.id)) throw new Error('Editor ID was reused.');
        this.status = { state: 'downloading', received: 0, total: manifest.archive.size };
        const archiveUrl = new URL(manifest.archive.url ?? 'editor.json.gz', this.manifestUrl);
        if (
          archiveUrl.username ||
          archiveUrl.password ||
          (archiveUrl.protocol !== 'https:' &&
            !(
              archiveUrl.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(archiveUrl.hostname)
            ))
        )
          throw new Error('Invalid editor archive URL.');
        const bytes = await this.download(
          archiveUrl,
          Math.min(MAX_ARCHIVE, manifest.archive.size),
          true,
        );
        if (bytes.length !== manifest.archive.size || sha256(bytes) !== manifest.archive.sha256)
          throw new Error('Editor archive integrity check failed.');
        const records = archiveSchema.parse(
          JSON.parse(
            gunzipSync(bytes, {
              maxOutputLength: Math.ceil((MAX_EDITOR_BYTES * 4) / 3) + 1024 * 1024,
            }).toString('utf8'),
          ),
        );
        const expected = new Map(manifest.files.map((file) => [file.path, file]));
        if (records.length !== expected.size) throw new Error('Editor archive inventory mismatch.');
        const staging = await fs.mkdtemp(path.join(this.directory, '.staging-'));
        try {
          for (const record of records) {
            const file = expected.get(record.path);
            if (!file || record.data.length !== Math.ceil(file.size / 3) * 4)
              throw new Error('Editor archive inventory mismatch.');
            const contents = Buffer.from(record.data, 'base64');
            if (
              contents.toString('base64') !== record.data ||
              contents.length !== file.size ||
              sha256(contents) !== file.sha256
            )
              throw new Error('Editor file integrity check failed.');
            expected.delete(record.path);
            const filename = path.join(staging, record.path);
            await fs.mkdir(path.dirname(filename), { recursive: true });
            await fs.writeFile(filename, contents, { flag: 'wx', mode: 0o600 });
          }
          if (expected.size) throw new Error('Editor archive is incomplete.');
          await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest), {
            flag: 'wx',
            mode: 0o600,
          });
          const destination = path.join(this.directory, manifest.id);
          // Only replace an invalid cache; verified versions are immutable.
          await fs.rm(destination, { recursive: true, force: true });
          await fs.rename(staging, destination);
          this.versions.set(manifest.id, manifest);
        } finally {
          await fs.rm(staging, { recursive: true, force: true });
        }
      }
      const previous = this.current;
      const pointer = path.join(this.directory, '.current.tmp');
      await fs.writeFile(pointer, JSON.stringify({ current: manifest.id, previous }), {
        mode: 0o600,
      });
      await fs.rename(pointer, path.join(this.directory, 'current.json'));
      this.previous = previous;
      this.current = manifest.id;
      return manifest;
    })()
      .then((manifest) => {
        this.status = { state: 'ready', received: 0, total: 0 };
        return manifest;
      })
      .catch((error: unknown) => {
        this.status = {
          ...this.status,
          state: 'error',
          error:
            'Could not download a compatible editor. Check the server connection and try again.',
        };
        console.warn('Editor update failed:', error instanceof Error ? error.message : error);
        throw error;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  async location(exclude?: string): Promise<EditorLocation> {
    await this.init();
    let manifest: EditorManifest;
    if (exclude) {
      if (exclude !== this.current || !this.previous)
        throw new Error('No previous editor is available.');
      manifest = await this.cached(this.previous);
    } else if (this.current) {
      manifest = this.versions.get(this.current)!;
      if (this.now() - this.checked >= INTERVAL) void this.install().catch(() => {});
    } else manifest = await this.install();
    const base = `/editor/${manifest.id}/`;
    return {
      id: manifest.id,
      packageVersion: manifest.packageVersion,
      entry: base + manifest.entry,
      css: manifest.css.map((file) => base + file),
    };
  }

  async asset(id: string, relative: string): Promise<string | undefined> {
    await this.init();
    try {
      const manifest = await this.cached(id);
      if (!manifest.files.some((file) => file.path === relative)) return;
      return path.join(this.directory, id, relative);
    } catch {
      return;
    }
  }
}
