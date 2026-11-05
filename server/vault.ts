import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  EXTENSION,
  childFolder,
  folderCanvas,
  folderOf,
  inCanvas,
  parentCanvas,
  relocated,
  relocatedLink,
} from '../shared/canvas.js';
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
/** Revision of a canvas whose file has not been written yet. */
export const EMPTY_REVISION = hash('');
const exists = async (name: string) => {
  try {
    await fs.lstat(name);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};
const isDirectory = async (name: string) => {
  try {
    const stat = await fs.lstat(name);
    return stat.isDirectory();
  } catch (error) {
    if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR') return false;
    throw error;
  }
};
const isFile = async (name: string) => {
  try {
    const stat = await fs.lstat(name);
    return stat.isFile();
  } catch (error) {
    if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR') return false;
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
const baseName = (relative: string) => relative.slice(relative.lastIndexOf('/') + 1);
const join = (root: string, rest: string) => (rest ? (root ? `${root}/${rest}` : rest) : root);
const unique = (values: string[]) => [...new Set(values)];
/** True when the folder `key` is the content folder of `root` or lies inside it. */
const folderWithin = (key: string, root: string) =>
  key === childFolder(root) || key.startsWith(`${childFolder(root)}/`);
/** A canvas path relative to the canvas `root`: '' for itself, `Inner.excalidraw` inside. */
const relativeCanvas = (relative: string, root: string) =>
  relative === root ? '' : relative.slice(childFolder(root).length + 1);
const absoluteCanvas = (relative: string, root: string) =>
  relative ? `${childFolder(root)}/${relative}` : root;
/** A folder key relative to the canvas `root`: '' for its content folder. */
const relativeFolder = (key: string, root: string) =>
  key === childFolder(root) ? '' : key.slice(childFolder(root).length + 1);
const absoluteFolder = (relative: string, root: string) => join(childFolder(root), relative);
/** Earlier versions recorded folders by their own path. A folder is now a canvas. */
const asCanvas = (relative: string) =>
  relative && !relative.endsWith(EXTENSION) ? `${relative}${EXTENSION}` : relative;

/*
 * Private workspace metadata in .workspace/library.json. Paths are canvas paths.
 * favorites and archived hold explicit flags; archive state is inherited by the canvases
 * inside. order maps a content folder ('' is the top level) to the custom order of the
 * canvases directly inside it.
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
    const children = unique(library.order[key].map(asCanvas)).filter((p) => folderOf(p) === key);
    if (children.length) order[key] = children;
  }
  return {
    ...library,
    version: 1,
    favorites: unique(library.favorites.map(asCanvas)).sort(),
    archived: unique(library.archived.map(asCanvas)).sort(),
    order,
  };
};

// Metadata for a trashed canvas and its contents, stored relative to it ('' is itself).
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
    if (folderWithin(key, root))
      order[relativeFolder(key, root)] = children
        .filter((p) => inCanvas(p, root))
        .map((p) => relativeCanvas(p, root));
  const siblings = library.order[folderOf(root)] ?? [];
  const index = siblings.indexOf(root);
  return {
    version: 1,
    favorites: library.favorites
      .filter((p) => inCanvas(p, root))
      .map((p) => relativeCanvas(p, root)),
    archived: library.archived.filter((p) => inCanvas(p, root)).map((p) => relativeCanvas(p, root)),
    order,
    ...(index >= 0 ? { position: { folder: folderOf(root), index } } : {}),
  };
};

const dropSubtree = (library: Library, root: string) => {
  library.favorites = library.favorites.filter((p) => !inCanvas(p, root));
  library.archived = library.archived.filter((p) => !inCanvas(p, root));
  const order: Record<string, string[]> = {};
  for (const [key, children] of Object.entries(library.order))
    if (!folderWithin(key, root)) order[key] = children.filter((p) => !inCanvas(p, root));
  library.order = order;
};

const attachSubtree = (library: Library, snapshot: Snapshot, root: string) => {
  const valid = (relative: string) => relative === '' || isVaultPath(relative);
  const canvas = (relative: string) => absoluteCanvas(asCanvas(relative), root);
  library.favorites.push(...snapshot.favorites.filter(valid).map(canvas));
  library.archived.push(...snapshot.archived.filter(valid).map(canvas));
  for (const [key, children] of Object.entries(snapshot.order))
    if (valid(key)) library.order[absoluteFolder(key, root)] = children.filter(valid).map(canvas);
  const position = snapshot.position;
  const siblings = position && library.order[position.folder];
  if (position && siblings && folderOf(root) === position.folder && !siblings.includes(root))
    siblings.splice(Math.min(position.index, siblings.length), 0, root);
};

const rebaseLibrary = (library: Library, from: string, to: string) => {
  // Anything already recorded at the destination is stale: the destination did not exist.
  dropSubtree(library, to);
  const rebase = (p: string) => relocated(p, from, to);
  const rebaseFolder = (key: string) =>
    folderWithin(key, from) ? childFolder(to) + key.slice(childFolder(from).length) : key;
  library.favorites = library.favorites.map(rebase);
  library.archived = library.archived.map(rebase);
  const order: Record<string, string[]> = {};
  for (const [key, children] of Object.entries(library.order)) {
    const folder = rebaseFolder(key);
    // A moved canvas leaves its old parent's order; a renamed one keeps its position.
    order[folder] = children.map(rebase).filter((p) => folderOf(p) === folder);
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
    for (let p = entry.path; p; p = parentCanvas(p))
      if (archived.has(p)) {
        archiveRoot = p;
        break;
      }
    entry.archived = archiveRoot !== undefined;
    if (archiveRoot !== undefined) entry.archiveRoot = archiveRoot;
    const folder = folderOf(entry.path);
    const siblings = groups.get(folder);
    if (siblings) siblings.push(entry);
    else groups.set(folder, [entry]);
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

/*
 * A trash record holds `content` (the canvas file) and `children` (its content folder).
 * Records written before canvases could contain canvases hold a single `content`, which
 * was either a file or a folder; a trashed folder comes back as a canvas without a file.
 */
const trashEntrySchema = z.object({
  id: z.string().regex(/^[\da-f-]{36}$/),
  path: z.string().refine(isVaultPath),
  kind: z.enum(['file', 'folder']),
  deleted: z.string(),
  inside: z.number().int().nonnegative().optional(),
});
type TrashMeta = z.infer<typeof trashEntrySchema>;
interface TrashRecord {
  meta: TrashMeta;
  /** The canvas path to restore. */
  path: string;
  file?: string;
  children?: string;
}
/** History of a trashed canvas is keyed by its path relative to the trashed canvas. */
const trashKey = (relative: string, root: string) => relativeCanvas(relative, root);

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

  private requireDocument(relative: string) {
    if (!relative.endsWith(EXTENSION) || relative.endsWith(`/${EXTENSION}`))
      throw new VaultError(400, 'The filename must end in .excalidraw.');
  }

  /** The file and content folder of a canvas, and which of them exist. */
  private async locate(relative: string) {
    this.requireDocument(relative);
    const file = await this.resolve(relative);
    const folder = await this.resolve(childFolder(relative));
    return { file, folder, hasFile: await isFile(file), hasFolder: await isDirectory(folder) };
  }

  private async requireCanvas(relative: string) {
    const canvas = await this.locate(relative);
    if (!canvas.hasFile && !canvas.hasFolder)
      throw new VaultError(404, 'The canvas no longer exists.', 'not_found');
    return canvas;
  }

  private async occupied(relative: string) {
    const canvas = await this.locate(relative);
    return (await exists(canvas.file)) || (await exists(canvas.folder));
  }

  /**
   * Makes sure the canvas that will contain `relative` has its content folder. Returns the
   * folder when this call created it, so a failed operation can remove it again.
   */
  private async prepareFolder(relative: string): Promise<string | undefined> {
    const folder = folderOf(relative);
    if (!folder) return undefined;
    const absolute = await this.resolve(folder);
    try {
      if ((await fs.lstat(absolute)).isDirectory()) return undefined;
      throw new VaultError(409, 'A file is in the place of the destination folder.', 'exists');
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
    if (!(await isFile(await this.resolve(folderCanvas(folder)))))
      throw new VaultError(404, 'The destination canvas no longer exists.', 'not_found');
    await fs.mkdir(absolute, { mode: 0o700 });
    return absolute;
  }

  /**
   * A content folder that became empty is removed, so the folder exists only while its
   * canvas contains canvases. A canvas without a file keeps its folder: it is the canvas.
   */
  private async removeEmptyFolder(folder: string) {
    if (!folder) return;
    try {
      if (!(await isFile(await this.resolve(folderCanvas(folder))))) return;
      await fs.rmdir(await this.resolve(folder));
    } catch {
      /* Not empty, already gone, or holding hidden files: keep it. */
    }
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

  /** The file's content, or undefined for a canvas that exists only as a content folder. */
  private async readCanvas(relative: string) {
    const canvas = await this.locate(relative);
    try {
      return await this.readRaw(canvas.file);
    } catch (error) {
      if (errno(error) === 'ENOENT' && (await isDirectory(canvas.folder))) return undefined;
      throw error;
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
      // Returns the number of canvases directly inside the folder.
      const visit = async (folder: string): Promise<number> => {
        const files = new Set<string>();
        const folders = new Set<string>();
        for (const entry of await fs.readdir(path.join(this.root, folder), {
          withFileTypes: true,
        })) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) folders.add(entry.name);
          else if (entry.isFile() && entry.name.endsWith(EXTENSION))
            files.add(entry.name.slice(0, -EXTENSION.length));
        }
        let count = 0;
        for (const name of new Set([...files, ...folders])) {
          const content = join(folder, name);
          const relative = `${content}${EXTENSION}`;
          if (!isVaultPath(relative)) continue;
          const saved = files.has(name);
          const stat = await fs
            .lstat(path.join(this.root, saved ? relative : content))
            .catch(() => null);
          if (!stat || stat.isSymbolicLink()) continue;
          const entry: Entry = {
            path: relative,
            modified: stat.mtime.toISOString(),
            children: 0,
            ...(saved ? {} : { unsaved: true }),
          };
          entries.push(entry);
          count++;
          if (folders.has(name)) entry.children = await visit(content);
        }
        return count;
      };
      await visit('');
      annotate(entries, (await this.loadLibrary()).library);
      return entries.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
    });
  }

  async read(relative: string): Promise<Document> {
    const raw = await this.readCanvas(relative);
    if (raw === undefined) return { path: relative, revision: EMPTY_REVISION, scene: emptyScene() };
    return { path: relative, revision: hash(raw), scene: this.parse(raw) };
  }

  async revision(relative: string) {
    const raw = await this.readCanvas(relative);
    return raw === undefined ? EMPTY_REVISION : hash(raw);
  }

  async create(relative: string, scene = emptyScene()) {
    return this.serial(async () => {
      const canvas = await this.locate(relative);
      if ((await exists(canvas.file)) || (await exists(canvas.folder)))
        throw new VaultError(409, 'A canvas with that name already exists.', 'exists');
      const raw = this.encode(scene);
      const created = await this.prepareFolder(relative);
      try {
        await this.publish(canvas.file, raw);
      } catch (error) {
        if (created) await fs.rmdir(created).catch(() => {});
        if (errno(error) === 'EEXIST')
          throw new VaultError(409, 'A canvas with that name already exists.', 'exists');
        throw error;
      }
      await this.forgetStale(relative);
      return { path: relative, scene, revision: hash(raw) };
    });
  }

  /** Writes a new file atomically. Fails with EEXIST instead of replacing a file. */
  private async publish(absolute: string, raw: string) {
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
  }

  async save(relative: string, revision: string, scene: Scene): Promise<Document> {
    return this.serial(async () => {
      let old: string | undefined;
      try {
        old = await this.readCanvas(relative);
      } catch (e) {
        if (errno(e) === 'ENOENT')
          throw new VaultError(409, 'The file has been moved or deleted.', 'conflict');
        throw e;
      }
      const current = old === undefined ? EMPTY_REVISION : hash(old);
      if (current !== revision)
        throw new VaultError(409, 'The file has changed outside this editor.', 'conflict');
      const validated = sceneSchema.parse(scene);
      const raw = this.encode(validated);
      if (raw === old) return { path: relative, revision, scene: validated };
      if (old === undefined) {
        // The first save of a canvas that so far existed only as its content folder.
        try {
          await this.publish(await this.resolve(relative), raw);
        } catch (error) {
          if (errno(error) === 'EEXIST' || errno(error) === 'ENOENT')
            throw new VaultError(409, 'The file changed while saving.', 'conflict');
          throw error;
        }
      } else await this.replace(relative, old, raw);
      return { path: relative, revision: hash(raw), scene: validated };
    });
  }

  /** Replaces an existing file whose content is `old`, keeping `old` as a version. */
  private async replace(relative: string, old: string, raw: string) {
    const absolute = await this.resolve(relative);
    const revision = hash(old);
    const history = this.historyDirectory(relative);
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
  }

  private async syncDirectory(directory: string) {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Moves or renames a canvas together with the canvases inside it. Links in other
   * canvases that point into it are rewritten; `exclude` names a canvas whose links the
   * client updates itself, typically the open one. Returns the canvases rewritten.
   */
  async move(from: string, to: string, exclude?: string) {
    return this.serial(async () => {
      if (from === to) return { rewritten: [] as string[] };
      const source = await this.requireCanvas(from);
      const target = await this.locate(to);
      if (inCanvas(to, from)) throw new VaultError(400, 'A canvas cannot be moved inside itself.');
      if ((await exists(target.file)) || (await exists(target.folder)))
        throw new VaultError(409, 'The destination already exists.', 'exists');
      const documents = await this.canvasFiles(from, to);
      const library = (await this.loadLibrary()).library;
      for (const relative of [
        ...library.favorites,
        ...library.archived,
        ...Object.values(library.order).flat(),
      ])
        if (inCanvas(relative, from)) this.validate(relocated(relative, from, to));
      for (const key of Object.keys(library.order))
        if (folderWithin(key, from))
          this.validate(childFolder(to) + key.slice(childFolder(from).length));
      const created = await this.prepareFolder(to);
      const undo: (() => Promise<void>)[] = [];
      const rollback = async () => {
        for (const step of undo.reverse()) await step().catch((error) => console.error(error));
        if (created) await fs.rmdir(created).catch(() => {});
      };
      try {
        if (source.hasFile) {
          await fs.rename(source.file, target.file);
          undo.push(() => fs.rename(target.file, source.file));
        }
        if (source.hasFolder) {
          await fs.rename(source.folder, target.folder);
          undo.push(() => fs.rename(target.folder, source.folder));
        }
        await this.updateLibrary((library) => rebaseLibrary(library, from, to));
      } catch (error) {
        // Keep files and metadata consistent: an unrecorded move is undone.
        await rollback();
        throw error;
      }
      for (const relative of documents) {
        await this.mergeHistory(
          this.historyDirectory(relative),
          this.historyDirectory(relocated(relative, from, to)),
        ).catch((error) => console.error('History could not follow a move.', error));
      }
      await this.removeEmptyFolder(folderOf(from));
      const rewritten = await this.rewriteLinks(
        from,
        to,
        exclude === undefined ? undefined : relocated(exclude, from, to),
      ).catch((error) => {
        console.error('Links to a moved canvas could not be updated.', error);
        return [] as string[];
      });
      return { rewritten };
    });
  }

  /** Points links to `from` and the canvases inside it at their new paths. */
  private async rewriteLinks(from: string, to: string, exclude?: string) {
    const rewritten: string[] = [];
    for (const relative of await this.canvasFiles()) {
      if (relative === exclude) continue;
      try {
        const old = await this.readRaw(await this.resolve(relative));
        if (!old.includes('canvas=')) continue;
        const scene = JSON.parse(old) as Scene;
        if (!Array.isArray(scene?.elements)) continue;
        let changed = false;
        scene.elements = scene.elements.map((element) => {
          const link = element?.link;
          const next = typeof link === 'string' ? relocatedLink(link, from, to) : undefined;
          if (next === undefined) return element;
          changed = true;
          return {
            ...element,
            link: next,
            version: (typeof element.version === 'number' ? element.version : 0) + 1,
            versionNonce: randomInt(2 ** 31),
            updated: Date.now(),
          };
        });
        if (!changed) continue;
        await this.replace(relative, old, this.encode(scene));
        rewritten.push(relative);
      } catch (error) {
        console.error(`Links in ${relative} could not be updated.`, error);
      }
    }
    return rewritten;
  }

  async trash(relative: string) {
    return this.serial(async () => {
      const canvas = await this.requireCanvas(relative);
      const id = randomUUID();
      const directory = path.join(this.root, '.workspace/trash', id);
      const content = path.join(directory, 'content');
      const children = path.join(directory, 'children');
      const documents = await this.canvasFiles(relative);
      const inside = canvas.hasFolder ? (await this.canvasesUnder(canvas.folder)).length : 0;
      const meta: TrashMeta = {
        id,
        path: relative,
        kind: 'file',
        deleted: new Date().toISOString(),
        inside,
      };
      const snapshot = extractSubtree((await this.loadLibrary()).library, relative);
      await fs.mkdir(directory, { mode: 0o700 });
      await this.writeAtomic(path.join(directory, 'library.json'), JSON.stringify(snapshot));
      await this.writeAtomic(path.join(directory, 'meta.json'), JSON.stringify(meta));
      const undo: (() => Promise<void>)[] = [];
      try {
        if (canvas.hasFile) {
          await fs.rename(canvas.file, content);
          undo.push(() => fs.rename(content, canvas.file));
        }
        if (canvas.hasFolder) {
          await fs.rename(canvas.folder, children);
          undo.push(() => fs.rename(children, canvas.folder));
        }
        await this.updateLibrary((library) => dropSubtree(library, relative));
      } catch (error) {
        try {
          for (const step of undo.reverse()) await step();
          await fs.rm(directory, { recursive: true, force: true });
        } catch (rollback) {
          console.error(rollback);
        }
        throw error;
      }
      // History travels with the canvas, keyed by its path inside the trashed canvas.
      for (const inner of documents) {
        const source = this.historyDirectory(inner);
        if (!(await exists(source))) continue;
        try {
          await fs.mkdir(path.join(directory, 'history'), { recursive: true, mode: 0o700 });
          await fs.rename(source, path.join(directory, 'history', hash(trashKey(inner, relative))));
        } catch (error) {
          console.error('History could not be moved to the trash.', error);
        }
      }
      await this.removeEmptyFolder(folderOf(relative));
      const item: TrashEntry = { id, path: relative, inside, deleted: meta.deleted };
      return item;
    });
  }

  private async trashRecord(directory: string, id: string): Promise<TrashRecord> {
    let meta: TrashMeta;
    try {
      meta = trashEntrySchema.parse(
        JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8')),
      );
    } catch (error) {
      if (errno(error) === 'ENOENT')
        throw new VaultError(404, 'This item is no longer in the trash.', 'not_found');
      throw new VaultError(422, 'This trash record cannot be read.', 'invalid_trash');
    }
    if (meta.id !== id) throw new VaultError(422, 'This trash record cannot be read.');
    const content = path.join(directory, 'content');
    if (meta.kind === 'folder')
      return {
        meta,
        path: asCanvas(meta.path),
        children: (await isDirectory(content)) ? content : undefined,
      };
    const children = path.join(directory, 'children');
    return {
      meta,
      path: meta.path,
      file: (await isFile(content)) ? content : undefined,
      children: (await isDirectory(children)) ? children : undefined,
    };
  }

  async listTrash(): Promise<TrashEntry[]> {
    const directory = path.join(this.root, '.workspace/trash');
    const result: TrashEntry[] = [];
    for (const id of await fs.readdir(directory)) {
      try {
        const record = await this.trashRecord(path.join(directory, id), id);
        if (!record.file && !record.children) continue;
        const inside =
          record.meta.inside ??
          (record.children ? (await this.canvasesUnder(record.children)).length : 0);
        result.push({ id, path: record.path, inside, deleted: record.meta.deleted });
      } catch (error) {
        if (error instanceof VaultError && error.code === 'not_found') continue;
        console.error(`Ignoring an unreadable trash record: ${id}`, error);
      }
    }
    return result.sort((a, b) => b.deleted.localeCompare(a.deleted));
  }

  /*
   * Restores to destination, or to the original path. An occupied original path gets a
   * readable "(restored)" name; an occupied explicit destination is a conflict. Missing
   * containing canvases come back as empty canvases. Metadata and history are reattached.
   */
  async restore(id: string, destination?: string) {
    return this.serial(async () => {
      if (!/^[\da-f-]{36}$/.test(id)) throw new VaultError(400, 'Invalid identifier.');
      const directory = path.join(this.root, '.workspace/trash', id);
      const record = await this.trashRecord(directory, id);
      if (!record.file && !record.children)
        throw new VaultError(404, 'This item is no longer in the trash.', 'not_found');
      let relative = destination ?? record.path;
      this.validate(relative);
      this.requireDocument(relative);
      const created = await this.ensureParents(relative);
      const removeCreated = async () => {
        for (const folder of [...created].reverse()) await fs.rmdir(folder).catch(() => {});
      };
      let canvas: Awaited<ReturnType<Vault['locate']>>;
      const undo: (() => Promise<void>)[] = [];
      try {
        if (await this.occupied(relative)) {
          if (destination !== undefined)
            throw new VaultError(
              409,
              'The destination already exists. Restore with a different name.',
              'exists',
            );
          relative = await this.restoredName(relative);
        }
        canvas = await this.locate(relative);
        if (record.file) {
          await fs.rename(record.file, canvas.file);
          const from = record.file;
          undo.push(() => fs.rename(canvas.file, from));
        }
        if (record.children) {
          await fs.rename(record.children, canvas.folder);
          const from = record.children;
          undo.push(() => fs.rename(canvas.folder, from));
        }
      } catch (error) {
        for (const step of undo.reverse()) await step().catch((e) => console.error(e));
        await removeCreated();
        throw error;
      }
      const final = relative;
      try {
        const snapshot = await this.readSnapshot(directory);
        // Recreated folders are new canvases without files, not the removed canvases whose
        // stale archive flags or order may still be recorded at those paths.
        const fresh: string[] = [];
        for (const folder of created) {
          const key = path.relative(this.root, folder).split(path.sep).join('/');
          if (!(await isFile(await this.resolve(folderCanvas(key))))) {
            fresh.push(folderCanvas(key));
            break;
          }
        }
        await this.updateLibrary((library) => {
          for (const canvas of fresh) dropSubtree(library, canvas);
          dropSubtree(library, final);
          if (snapshot) attachSubtree(library, snapshot, final);
        });
      } catch (error) {
        try {
          for (const step of undo.reverse()) await step();
          await removeCreated();
        } catch (rollback) {
          console.error(rollback);
        }
        throw error;
      }
      let complete = true;
      for (const inner of await this.canvasFiles(final)) {
        try {
          if (
            !(await this.mergeHistory(
              path.join(directory, 'history', hash(trashKey(inner, final))),
              this.historyDirectory(inner),
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
        // Clearing a flag is allowed for a canvas that disappeared outside this service.
        if (value) await this.requireCanvas(relative);
        else this.requireDocument(relative);
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

  /**
   * Replaces the custom order of the canvases directly inside a content folder ('' is the
   * top level). Omitted canvases follow by name. An empty list clears the custom order.
   */
  async order(folder: string, paths: string[]) {
    return this.serial(async () => {
      this.validate(folder, true);
      if (new Set(paths).size !== paths.length)
        throw new VaultError(400, 'Each item can appear only once.');
      if (folder && paths.length) await this.requireCanvas(folderCanvas(folder));
      for (const relative of paths) {
        this.validate(relative);
        this.requireDocument(relative);
        if (folderOf(relative) !== folder)
          throw new VaultError(400, 'Every canvas must be directly inside the same canvas.');
        await this.requireCanvas(relative);
      }
      await this.updateLibrary((library) => {
        if (paths.length) library.order[folder] = [...paths];
        else delete library.order[folder];
      });
    });
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

  private async restoredName(relative: string) {
    const folder = folderOf(relative);
    const name = baseName(relative);
    const stem = name
      .slice(0, name.length - EXTENSION.length)
      .replace(/ \(restored(?: \d+)?\)$/, '');
    for (let n = 1; n <= 1000; n++) {
      const candidate = join(folder, `${stem} (restored${n > 1 ? ` ${n}` : ''})${EXTENSION}`);
      if (!isVaultPath(candidate)) break;
      if (!(await this.occupied(candidate))) return candidate;
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

  /**
   * Canvases at any depth inside an absolute content folder, as paths relative to it.
   * With `validate`, the same paths inside that vault folder must be valid as well.
   */
  private async canvasesUnder(absolute: string, validate?: string) {
    const result: string[] = [];
    const visit = async (folder: string) => {
      const files = new Set<string>();
      const folders = new Set<string>();
      for (const entry of await fs.readdir(path.join(absolute, folder), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) folders.add(entry.name);
        else if (entry.isFile() && entry.name.endsWith(EXTENSION))
          files.add(entry.name.slice(0, -EXTENSION.length));
      }
      for (const name of new Set([...files, ...folders])) {
        const relative = `${join(folder, name)}${EXTENSION}`;
        if (validate !== undefined) {
          this.validate(join(validate, relative));
          if (folders.has(name)) this.validate(join(validate, join(folder, name)));
        }
        result.push(relative);
        if (folders.has(name)) await visit(join(folder, name));
      }
    };
    await visit('');
    return result;
  }

  /**
   * Vault paths of the canvas files that exist in a canvas, including itself, or in the
   * whole vault. With `destination`, its paths after a move to there must be valid too.
   */
  private async canvasFiles(root?: string, destination?: string): Promise<string[]> {
    const files: string[] = [];
    const visit = async (folder: string) => {
      for (const entry of await fs.readdir(path.join(this.root, folder), {
        withFileTypes: true,
      })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const relative = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (destination !== undefined && root)
            this.validate(childFolder(destination) + relative.slice(childFolder(root).length));
          await visit(relative);
        } else if (entry.isFile() && entry.name.endsWith(EXTENSION) && isVaultPath(relative)) {
          if (destination !== undefined && root)
            this.validate(relocated(relative, root, destination));
          files.push(relative);
        }
      }
    };
    if (root === undefined) {
      await visit('');
      return files;
    }
    const canvas = await this.locate(root);
    if (canvas.hasFile) files.push(root);
    if (destination !== undefined) this.validate(destination);
    if (canvas.hasFolder) await visit(childFolder(root));
    return files;
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
      // Folders recorded by earlier versions are read as the canvases they now are.
      return { library: normalizeLibrary(librarySchema.parse(JSON.parse(raw))), invalid: false };
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
    const directory = this.historyDirectory(relative);
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
      await this.readRaw(path.join(this.historyDirectory(relative), `${revision}.excalidraw`)),
    );
  }
}
