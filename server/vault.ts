import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  emptyScene,
  sceneSchema,
  type Document,
  type Entry,
  type LibraryProperty,
  type Scene,
  type TrashEntry,
} from '../shared/model.js';

export class VaultError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'invalid_request',
  ) {
    super(message);
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const exists = async (name: string) => {
  try {
    await fs.lstat(name);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

// A path is a vault-relative POSIX path without hidden, empty, or unsafe components.
const isVaultPath = (relative: unknown): relative is string =>
  typeof relative === 'string' &&
  relative.length > 0 &&
  relative.length <= 1000 &&
  relative
    .split('/')
    .every(
      (p) =>
        p &&
        !p.startsWith('.') &&
        !/[\\\x00-\x1f\x7f]/.test(p) &&
        p.length <= 180 &&
        p.trim() === p,
    );
const parentOf = (relative: string) => {
  const index = relative.lastIndexOf('/');
  return index < 0 ? '' : relative.slice(0, index);
};
const baseName = (relative: string) => relative.slice(relative.lastIndexOf('/') + 1);
const within = (relative: string, root: string) =>
  relative === root || relative.startsWith(`${root}/`);
const join = (root: string, rest: string) => (rest ? (root ? `${root}/${rest}` : rest) : root);
const relativeTo = (relative: string, root: string) =>
  relative === root ? '' : relative.slice(root.length + 1);
const unique = (values: string[]) => [...new Set(values)];

/*
 * Private workspace metadata in .workspace/library.json. Paths are full vault paths.
 * favorites and archived hold explicit flags; archive state is inherited by descendants.
 * order maps a folder ('' is the root) to the custom order of its direct children.
 */
const libraryPath = z.string().refine(isVaultPath);
const librarySchema = z
  .object({
    version: z.literal(1),
    favorites: z.array(libraryPath),
    archived: z.array(libraryPath),
    order: z.record(
      z.string().refine((key) => key === '' || isVaultPath(key)),
      z.array(libraryPath),
    ),
  })
  .passthrough();
type Library = z.infer<typeof librarySchema>;
const emptyLibrary = (): Library => ({ version: 1, favorites: [], archived: [], order: {} });

const normalizeLibrary = (library: Library): Library => {
  const order: Record<string, string[]> = {};
  for (const key of Object.keys(library.order).sort()) {
    const children = unique(library.order[key]).filter((p) => parentOf(p) === key);
    if (children.length) order[key] = children;
  }
  return {
    ...library,
    version: 1,
    favorites: unique(library.favorites).sort(),
    archived: unique(library.archived).sort(),
    order,
  };
};

// Metadata for a trashed subtree, stored with paths relative to the trashed item ('' is itself).
const snapshotSchema = z.object({
  version: z.literal(1),
  favorites: z.array(z.string()),
  archived: z.array(z.string()),
  order: z.record(z.string(), z.array(z.string())),
  position: z.object({ folder: z.string(), index: z.number().int().nonnegative() }).optional(),
});
type Snapshot = z.infer<typeof snapshotSchema>;

const extractSubtree = (library: Library, root: string): Snapshot => {
  const order: Record<string, string[]> = {};
  for (const [key, children] of Object.entries(library.order))
    if (within(key, root))
      order[relativeTo(key, root)] = children
        .filter((p) => within(p, root))
        .map((p) => relativeTo(p, root));
  const siblings = library.order[parentOf(root)] ?? [];
  const index = siblings.indexOf(root);
  return {
    version: 1,
    favorites: library.favorites.filter((p) => within(p, root)).map((p) => relativeTo(p, root)),
    archived: library.archived.filter((p) => within(p, root)).map((p) => relativeTo(p, root)),
    order,
    ...(index >= 0 ? { position: { folder: parentOf(root), index } } : {}),
  };
};

const dropSubtree = (library: Library, root: string) => {
  library.favorites = library.favorites.filter((p) => !within(p, root));
  library.archived = library.archived.filter((p) => !within(p, root));
  const order: Record<string, string[]> = {};
  for (const [key, children] of Object.entries(library.order))
    if (!within(key, root)) order[key] = children.filter((p) => !within(p, root));
  library.order = order;
};

const attachSubtree = (library: Library, snapshot: Snapshot, root: string) => {
  const valid = (relative: string) => relative === '' || isVaultPath(relative);
  const absolute = (relative: string) => join(root, relative);
  library.favorites.push(...snapshot.favorites.filter(valid).map(absolute));
  library.archived.push(...snapshot.archived.filter(valid).map(absolute));
  for (const [key, children] of Object.entries(snapshot.order))
    if (valid(key)) library.order[absolute(key)] = children.filter(valid).map(absolute);
  const position = snapshot.position;
  const siblings = position && library.order[position.folder];
  if (position && siblings && parentOf(root) === position.folder && !siblings.includes(root))
    siblings.splice(Math.min(position.index, siblings.length), 0, root);
};

const rebaseLibrary = (library: Library, from: string, to: string) => {
  // Anything already recorded at the destination is stale: the destination did not exist.
  dropSubtree(library, to);
  const rebase = (p: string) => (within(p, from) ? to + p.slice(from.length) : p);
  library.favorites = library.favorites.map(rebase);
  library.archived = library.archived.map(rebase);
  const order: Record<string, string[]> = {};
  for (const [key, children] of Object.entries(library.order)) {
    const folder = rebase(key);
    // A moved child leaves its old parent's order; a renamed child keeps its position.
    order[folder] = children.map(rebase).filter((p) => parentOf(p) === folder);
  }
  library.order = order;
};

const nameOrder = (a: Entry, b: Entry) =>
  baseName(a.path).localeCompare(baseName(b.path), 'en', { numeric: true }) ||
  a.path.localeCompare(b.path, 'en', { numeric: true });

const annotate = (entries: Entry[], library: Library) => {
  const favorites = new Set(library.favorites);
  const archived = new Set(library.archived);
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    entry.favorite = favorites.has(entry.path);
    let archiveRoot: string | undefined;
    for (let p = entry.path; p; p = parentOf(p))
      if (archived.has(p)) {
        archiveRoot = p;
        break;
      }
    entry.archived = archiveRoot !== undefined;
    if (archiveRoot !== undefined) entry.archiveRoot = archiveRoot;
    const parent = parentOf(entry.path);
    const siblings = groups.get(parent);
    if (siblings) siblings.push(entry);
    else groups.set(parent, [entry]);
  }
  for (const [folder, siblings] of groups) {
    const rank = new Map<string, number>();
    (library.order[folder] ?? []).forEach((p, index) => {
      if (!rank.has(p)) rank.set(p, index);
    });
    siblings
      .sort((a, b) => {
        const ra = rank.get(a.path);
        const rb = rank.get(b.path);
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return nameOrder(a, b);
      })
      .forEach((entry, index) => {
        entry.order = index;
      });
  }
};

const trashEntrySchema = z.object({
  id: z.string().regex(/^[\da-f-]{36}$/),
  path: z.string().refine(isVaultPath),
  kind: z.enum(['file', 'folder']),
  deleted: z.string(),
});

export class Vault {
  readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    // Metadata is private to this service, never exposed as static files.
    for (const name of ['.workspace', '.workspace/history', '.workspace/trash']) {
      const absolute = path.join(this.root, name);
      await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(absolute)).isSymbolicLink())
        throw new Error(`Metadata cannot be a symlink: ${name}`);
    }
  }

  async lock() {
    const name = path.join(this.root, '.workspace', 'server.lock');
    const token = `${process.pid}:${randomUUID()}`;
    const acquire = async (): Promise<void> => {
      try {
        await fs.writeFile(name, token, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const old = await fs.readFile(name, 'utf8');
        const pid = Number(old.split(':')[0]);
        try {
          process.kill(pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
            await fs.unlink(name);
            return acquire();
          }
        }
        throw new Error(
          'This vault is already open in another server. Stop it before starting another.',
        );
      }
    };
    await acquire();
    return async () => {
      if ((await fs.readFile(name, 'utf8').catch(() => '')) === token) await fs.unlink(name);
    };
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private validate(relative: string, allowRoot = false) {
    if (relative === '' && allowRoot) return;
    if (!isVaultPath(relative))
      throw new VaultError(
        400,
        'Invalid name or path. Do not use hidden paths, leading dots, or backslashes.',
      );
  }

  private async resolve(relative: string, allowRoot = false) {
    this.validate(relative, allowRoot);
    let current = this.root;
    for (const component of relative.split('/').filter(Boolean)) {
      current = path.join(current, component);
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new VaultError(400, 'Symbolic links are not allowed.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return current;
  }

  private async parent(relative: string) {
    const parent = path.posix.dirname(relative);
    const absolute = await this.resolve(parent === '.' ? '' : parent, true);
    if (!(await fs.stat(absolute)).isDirectory())
      throw new VaultError(400, 'The destination folder does not exist.');
  }

  private requireDocument(relative: string) {
    if (!relative.endsWith('.excalidraw'))
      throw new VaultError(400, 'The filename must end in .excalidraw.');
  }

  private async readRaw(absolute: string) {
    const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new VaultError(400, 'Not a file.');
      if (stat.size > 40 * 1024 * 1024) throw new VaultError(413, 'The file exceeds 40 MB.');
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }

  private parse(raw: string): Scene {
    try {
      return sceneSchema.parse(JSON.parse(raw));
    } catch {
      throw new VaultError(422, 'The file does not contain a valid Excalidraw scene.');
    }
  }

  private encode(scene: Scene) {
    const raw = JSON.stringify(sceneSchema.parse(scene), null, 2) + '\n';
    if (Buffer.byteLength(raw, 'utf8') > 40 * 1024 * 1024)
      throw new VaultError(413, 'The document exceeds 40 MB.');
    return raw;
  }

  // Listing is serialized with metadata operations so flags and paths are consistent.
  async list(): Promise<Entry[]> {
    return this.serial(async () => {
      const entries: Entry[] = [];
      const visit = async (folder: string) => {
        for (const entry of await fs.readdir(path.join(this.root, folder), {
          withFileTypes: true,
        })) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const relative = folder ? `${folder}/${entry.name}` : entry.name;
          if (!entry.isDirectory() && !(entry.isFile() && entry.name.endsWith('.excalidraw')))
            continue;
          const stat = await fs.lstat(path.join(this.root, relative)).catch(() => null);
          if (!stat || stat.isSymbolicLink()) continue;
          entries.push({
            path: relative,
            kind: entry.isDirectory() ? 'folder' : 'file',
            modified: stat.mtime.toISOString(),
          });
          if (entry.isDirectory()) await visit(relative);
        }
      };
      await visit('');
      annotate(entries, (await this.loadLibrary()).library);
      return entries.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
    });
  }

  async read(relative: string): Promise<Document> {
    this.requireDocument(relative);
    const raw = await this.readRaw(await this.resolve(relative));
    return { path: relative, revision: hash(raw), scene: this.parse(raw) };
  }

  async revision(relative: string) {
    this.requireDocument(relative);
    return hash(await this.readRaw(await this.resolve(relative)));
  }

  async create(relative: string, kind: Entry['kind'], scene = emptyScene()) {
    return this.serial(async () => {
      const absolute = await this.resolve(relative);
      await this.parent(relative);
      if (await exists(absolute))
        throw new VaultError(409, 'A file or folder with that name already exists.', 'exists');
      if (kind === 'folder') {
        await fs.mkdir(absolute, { mode: 0o700 });
        await this.forgetStale(relative);
        return;
      }
      this.requireDocument(relative);
      const raw = this.encode(scene);
      const temporary = path.join(path.dirname(absolute), `.save-${randomUUID()}`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(raw);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // A hard link publishes the complete file atomically and fails if it already exists.
        await fs.link(temporary, absolute);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      await this.syncDirectory(path.dirname(absolute));
      await this.forgetStale(relative);
      return { path: relative, scene, revision: hash(raw) };
    });
  }

  async save(relative: string, revision: string, scene: Scene): Promise<Document> {
    return this.serial(async () => {
      this.requireDocument(relative);
      const absolute = await this.resolve(relative);
      let old: string;
      try {
        old = await this.readRaw(absolute);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
          throw new VaultError(409, 'The file has been moved or deleted.', 'conflict');
        throw e;
      }
      if (hash(old) !== revision)
        throw new VaultError(409, 'The file has changed outside this editor.', 'conflict');
      const validated = sceneSchema.parse(scene);
      const raw = this.encode(validated);
      if (raw === old) return { path: relative, revision, scene: validated };
      const history = path.join(this.root, '.workspace/history', hash(relative));
      await fs.mkdir(history, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(history, `${revision}.excalidraw`), old, { mode: 0o600 });
      const temporary = path.join(path.dirname(absolute), `.save-${randomUUID()}`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(raw);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (hash(await this.readRaw(absolute).catch(() => '')) !== revision) {
          throw new VaultError(409, 'The file changed while saving.', 'conflict');
        }
        await fs.rename(temporary, absolute);
        await this.syncDirectory(path.dirname(absolute));
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      const versions = await this.history(relative);
      for (const item of versions.slice(20))
        await fs.unlink(path.join(history, `${item.revision}.excalidraw`));
      return { path: relative, revision: hash(raw), scene: validated };
    });
  }

  private async syncDirectory(directory: string) {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async move(from: string, to: string) {
    return this.serial(async () => {
      const source = await this.resolve(from);
      const target = await this.resolve(to);
      if (to.startsWith(`${from}/`))
        throw new VaultError(400, 'You cannot move a folder inside itself.');
      const stat = await fs.lstat(source);
      if (stat.isFile()) {
        this.requireDocument(from);
        this.requireDocument(to);
      }
      await this.parent(to);
      if (await exists(target))
        throw new VaultError(409, 'The destination already exists.', 'exists');
      const documents = await this.documentsIn(source, to);
      const library = (await this.loadLibrary()).library;
      for (const relative of [
        ...library.favorites,
        ...library.archived,
        ...Object.keys(library.order),
        ...Object.values(library.order).flat(),
      ])
        if (within(relative, from)) this.validate(to + relative.slice(from.length));
      await fs.rename(source, target);
      try {
        await this.updateLibrary((library) => rebaseLibrary(library, from, to));
      } catch (error) {
        // Keep files and metadata consistent: an unrecorded move is undone.
        await fs.rename(target, source).catch((rollback) => console.error(rollback));
        throw error;
      }
      for (const relative of documents) {
        await this.mergeHistory(
          this.historyDirectory(join(from, relative)),
          this.historyDirectory(join(to, relative)),
        ).catch((error) => console.error('History could not follow a move.', error));
      }
    });
  }

  async trash(relative: string) {
    return this.serial(async () => {
      const absolute = await this.resolve(relative);
      const stat = await fs.lstat(absolute);
      if (stat.isFile()) this.requireDocument(relative);
      const item: TrashEntry = {
        id: randomUUID(),
        path: relative,
        kind: stat.isDirectory() ? 'folder' : 'file',
        deleted: new Date().toISOString(),
      };
      const directory = path.join(this.root, '.workspace/trash', item.id);
      const content = path.join(directory, 'content');
      const documents = await this.documentsIn(absolute);
      const snapshot = extractSubtree((await this.loadLibrary()).library, relative);
      await fs.mkdir(directory, { mode: 0o700 });
      await this.writeAtomic(path.join(directory, 'library.json'), JSON.stringify(snapshot));
      await this.writeAtomic(path.join(directory, 'meta.json'), JSON.stringify(item));
      await fs.rename(absolute, content);
      try {
        await this.updateLibrary((library) => dropSubtree(library, relative));
      } catch (error) {
        try {
          await fs.rename(content, absolute);
          await fs.rm(directory, { recursive: true, force: true });
        } catch (rollback) {
          console.error(rollback);
        }
        throw error;
      }
      // History travels with the item, keyed by the path inside the trashed subtree.
      for (const inner of documents) {
        const source = this.historyDirectory(join(relative, inner));
        if (!(await exists(source))) continue;
        try {
          await fs.mkdir(path.join(directory, 'history'), { recursive: true, mode: 0o700 });
          await fs.rename(source, path.join(directory, 'history', hash(inner)));
        } catch (error) {
          console.error('History could not be moved to the trash.', error);
        }
      }
      return item;
    });
  }

  async listTrash(): Promise<TrashEntry[]> {
    const directory = path.join(this.root, '.workspace/trash');
    const result: TrashEntry[] = [];
    for (const id of await fs.readdir(directory)) {
      const entry = path.join(directory, id);
      if (!(await exists(path.join(entry, 'content')))) continue;
      try {
        const {
          id: key,
          path: original,
          kind,
          deleted,
        } = trashEntrySchema.parse(
          JSON.parse(await fs.readFile(path.join(entry, 'meta.json'), 'utf8')),
        );
        if (key === id) result.push({ id: key, path: original, kind, deleted });
      } catch (error) {
        console.error(`Ignoring an unreadable trash record: ${id}`, error);
      }
    }
    return result.sort((a, b) => b.deleted.localeCompare(a.deleted));
  }

  /*
   * Restores to destination, or to the original path. An occupied original path gets a
   * readable "(restored)" name; an occupied explicit destination is a conflict. Missing
   * parent folders are recreated. Metadata and history are reattached at the final path.
   */
  async restore(id: string, destination?: string) {
    return this.serial(async () => {
      if (!/^[\da-f-]{36}$/.test(id)) throw new VaultError(400, 'Invalid identifier.');
      const directory = path.join(this.root, '.workspace/trash', id);
      const content = path.join(directory, 'content');
      let meta: TrashEntry;
      try {
        meta = trashEntrySchema.parse(
          JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8')),
        );
      } catch (error) {
        if (errno(error) === 'ENOENT')
          throw new VaultError(404, 'This item is no longer in the trash.', 'not_found');
        throw new VaultError(422, 'This trash record cannot be read.', 'invalid_trash');
      }
      if (!(await exists(content)))
        throw new VaultError(404, 'This item is no longer in the trash.', 'not_found');
      let relative = destination ?? meta.path;
      this.validate(relative);
      if (meta.kind === 'file') this.requireDocument(relative);
      const created = await this.ensureParents(relative);
      const removeCreated = async () => {
        for (const folder of created.reverse()) await fs.rmdir(folder).catch(() => {});
      };
      let absolute: string;
      try {
        absolute = await this.resolve(relative);
        if (await exists(absolute)) {
          if (destination !== undefined)
            throw new VaultError(
              409,
              'The destination already exists. Restore with a different name.',
              'exists',
            );
          relative = await this.restoredName(relative, meta.kind);
          absolute = await this.resolve(relative);
        }
        await fs.rename(content, absolute);
      } catch (error) {
        await removeCreated();
        throw error;
      }
      const final = relative;
      try {
        const snapshot = await this.readSnapshot(directory);
        await this.updateLibrary((library) => {
          // Recreated parents are new folders, not the removed folders whose stale
          // archive flags or order may still be recorded at those paths.
          if (created[0])
            dropSubtree(library, path.relative(this.root, created[0]).split(path.sep).join('/'));
          dropSubtree(library, final);
          if (snapshot) attachSubtree(library, snapshot, final);
        });
      } catch (error) {
        try {
          await fs.rename(absolute, content);
          await removeCreated();
        } catch (rollback) {
          console.error(rollback);
        }
        throw error;
      }
      let complete = true;
      for (const inner of await this.documentsIn(absolute)) {
        try {
          if (
            !(await this.mergeHistory(
              path.join(directory, 'history', hash(inner)),
              this.historyDirectory(join(final, inner)),
            ))
          )
            complete = false;
        } catch (error) {
          complete = false;
          console.error('History could not be restored.', error);
        }
      }
      // A record without content is no longer listed; keep it only if history remains in it.
      if (complete) await fs.rm(directory, { recursive: true, force: true });
      return final;
    });
  }

  async setLibrary(paths: string[], property: LibraryProperty, value: boolean) {
    return this.serial(async () => {
      if (!paths.length) throw new VaultError(400, 'Select at least one item.');
      if (new Set(paths).size !== paths.length)
        throw new VaultError(400, 'Each item can appear only once.');
      for (const relative of paths) {
        const absolute = await this.resolve(relative);
        // Clearing a flag is allowed for an item that disappeared outside this service.
        if (value) await this.requireEntry(absolute, relative);
      }
      await this.updateLibrary((library) => {
        const key = property === 'favorite' ? 'favorites' : 'archived';
        const set = new Set(library[key]);
        for (const relative of paths) {
          if (value) set.add(relative);
          else set.delete(relative);
        }
        library[key] = [...set];
      });
    });
  }

  // Replaces the custom order of a folder's direct children. Omitted children follow by name.
  async order(folder: string, paths: string[]) {
    return this.serial(async () => {
      const absolute = await this.resolve(folder, true);
      const stat = await fs.lstat(absolute).catch((error) => {
        if (errno(error) === 'ENOENT')
          throw new VaultError(404, 'The folder no longer exists.', 'not_found');
        throw error;
      });
      if (!stat.isDirectory()) throw new VaultError(400, 'Only folders can be ordered.');
      if (new Set(paths).size !== paths.length)
        throw new VaultError(400, 'Each item can appear only once.');
      for (const relative of paths) {
        this.validate(relative);
        if (folder && within(folder, relative))
          throw new VaultError(400, 'A folder cannot be ordered inside itself.');
        if (parentOf(relative) !== folder)
          throw new VaultError(400, 'Every item must be directly inside the folder.');
        await this.requireEntry(await this.resolve(relative), relative);
      }
      await this.updateLibrary((library) => {
        if (paths.length) library.order[folder] = [...paths];
        else delete library.order[folder];
      });
    });
  }

  private async requireEntry(absolute: string, relative: string) {
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR')
        throw new VaultError(404, 'The file or folder no longer exists.', 'not_found');
      throw error;
    }
    if (stat.isSymbolicLink()) throw new VaultError(400, 'Symbolic links are not allowed.');
    if (!stat.isDirectory()) {
      if (!stat.isFile()) throw new VaultError(400, 'Not a file.');
      this.requireDocument(relative);
    }
  }

  private async ensureParents(relative: string) {
    const created: string[] = [];
    let current = this.root;
    for (const component of relative.split('/').slice(0, -1)) {
      current = path.join(current, component);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if (errno(error) !== 'ENOENT') throw error;
        await fs.mkdir(current, { mode: 0o700 });
        created.push(current);
        continue;
      }
      if (stat.isSymbolicLink()) throw new VaultError(400, 'Symbolic links are not allowed.');
      if (!stat.isDirectory())
        throw new VaultError(409, 'A file is in the place of a destination folder.', 'exists');
    }
    return created;
  }

  private async restoredName(relative: string, kind: Entry['kind']) {
    const folder = parentOf(relative);
    const name = baseName(relative);
    const extension = kind === 'file' ? '.excalidraw' : '';
    const stem = name
      .slice(0, name.length - extension.length)
      .replace(/ \(restored(?: \d+)?\)$/, '');
    for (let n = 1; n <= 1000; n++) {
      const candidate = join(folder, `${stem} (restored${n > 1 ? ` ${n}` : ''})${extension}`);
      if (!isVaultPath(candidate)) break;
      if (!(await exists(await this.resolve(candidate)))) return candidate;
    }
    throw new VaultError(
      409,
      'No free name is available. Restore with a different name.',
      'exists',
    );
  }

  private async readSnapshot(directory: string): Promise<Snapshot | undefined> {
    try {
      return snapshotSchema.parse(
        JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8')),
      );
    } catch (error) {
      // Records created before workspace metadata existed have no snapshot.
      if (errno(error) !== 'ENOENT') console.error('Ignoring unreadable trash metadata.', error);
      return undefined;
    }
  }

  // Relative paths of the documents inside a file ('') or folder, excluding hidden items.
  private async documentsIn(absolute: string, destination?: string): Promise<string[]> {
    const stat = await fs.lstat(absolute);
    if (stat.isFile()) return absolute.endsWith('.excalidraw') ? [''] : [];
    if (!stat.isDirectory()) return [];
    const result: string[] = [];
    const visit = async (folder: string) => {
      for (const entry of await fs.readdir(path.join(absolute, folder), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const relative = join(folder, entry.name);
        if (
          destination !== undefined &&
          (entry.isDirectory() || entry.name.endsWith('.excalidraw'))
        )
          this.validate(join(destination, relative));
        if (entry.isDirectory()) await visit(relative);
        else if (entry.isFile() && entry.name.endsWith('.excalidraw')) result.push(relative);
      }
    };
    await visit('');
    return result;
  }

  private historyDirectory(relative: string) {
    return path.join(this.root, '.workspace/history', hash(relative));
  }

  /*
   * Moves saved revisions into the destination history. Revision files are named by the
   * hash of their content, so an identical name with identical bytes is a duplicate. Any
   * differing file is left in the source. Returns whether the source was fully merged.
   */
  private async mergeHistory(source: string, target: string) {
    if (!(await exists(source))) return true;
    if (!(await exists(target))) {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.rename(source, target);
      return true;
    }
    let complete = true;
    for (const name of await fs.readdir(source)) {
      const from = path.join(source, name);
      const to = path.join(target, name);
      if (!(await exists(to))) await fs.rename(from, to);
      else if ((await fs.readFile(from)).equals(await fs.readFile(to))) await fs.unlink(from);
      else complete = false;
    }
    if (complete) await fs.rmdir(source);
    return complete;
  }

  private async loadLibrary(): Promise<{ library: Library; invalid: boolean }> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.root, '.workspace', 'library.json'), 'utf8');
    } catch (error) {
      if (errno(error) === 'ENOENT') return { library: emptyLibrary(), invalid: false };
      throw error;
    }
    try {
      return { library: librarySchema.parse(JSON.parse(raw)), invalid: false };
    } catch {
      if (!this.reportedInvalidLibrary)
        console.error('Workspace metadata is invalid; using defaults until the next change.');
      this.reportedInvalidLibrary = true;
      return { library: emptyLibrary(), invalid: true };
    }
  }
  private reportedInvalidLibrary = false;

  // Call only inside serial. Writes nothing when the change has no effect.
  private async updateLibrary(change: (library: Library) => void) {
    const { library, invalid } = await this.loadLibrary();
    const before = JSON.stringify(normalizeLibrary(library));
    change(library);
    const after = normalizeLibrary(library);
    if (JSON.stringify(after) === before) return;
    const directory = path.join(this.root, '.workspace');
    const file = path.join(directory, 'library.json');
    if (invalid) {
      // Keep the unreadable file for diagnosis instead of overwriting it.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.rename(file, path.join(directory, `library.invalid-${stamp}.json`));
      this.reportedInvalidLibrary = false;
    }
    await this.writeAtomic(file, JSON.stringify(after, null, 2) + '\n');
  }

  // Metadata that remains at a path which did not exist is stale and must not be inherited.
  private async forgetStale(relative: string) {
    await this.updateLibrary((library) => dropSubtree(library, relative)).catch((error) =>
      console.error('Stale workspace metadata could not be cleared.', error),
    );
  }

  private async writeAtomic(file: string, data: string) {
    const temporary = path.join(path.dirname(file), `.write-${randomUUID()}`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      await this.syncDirectory(path.dirname(file));
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  async history(relative: string) {
    await this.resolve(relative);
    const directory = path.join(this.root, '.workspace/history', hash(relative));
    if (!(await exists(directory))) return [];
    const items = await Promise.all(
      (await fs.readdir(directory)).map(async (name) => ({
        revision: name.replace('.excalidraw', ''),
        modified: (await fs.stat(path.join(directory, name))).mtime.toISOString(),
      })),
    );
    return items.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async historical(relative: string, revision: string) {
    await this.resolve(relative);
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new VaultError(400, 'Invalid revision.');
    return this.parse(
      await this.readRaw(
        path.join(this.root, '.workspace/history', hash(relative), `${revision}.excalidraw`),
      ),
    );
  }
}
