import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  emptyScene,
  sceneSchema,
  type Document,
  type Entry,
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
    if (
      typeof relative !== 'string' ||
      relative.length > 1000 ||
      relative
        .split('/')
        .some(
          (p) =>
            !p ||
            p.startsWith('.') ||
            /[\\\x00-\x1f\x7f]/.test(p) ||
            p.length > 180 ||
            p.trim() !== p,
        )
    )
      throw new VaultError(
        400,
        'Nombre o ruta no válidos. No uses rutas ocultas, puntos iniciales ni barras inversas.',
      );
  }

  private async resolve(relative: string, allowRoot = false) {
    this.validate(relative, allowRoot);
    let current = this.root;
    for (const component of relative.split('/').filter(Boolean)) {
      current = path.join(current, component);
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new VaultError(400, 'No se permiten enlaces simbólicos.');
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
      throw new VaultError(400, 'La carpeta de destino no existe.');
  }

  private requireDocument(relative: string) {
    if (!relative.endsWith('.excalidraw'))
      throw new VaultError(400, 'El archivo debe terminar en .excalidraw.');
  }

  private async readRaw(absolute: string) {
    const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new VaultError(400, 'No es un archivo.');
      if (stat.size > 40 * 1024 * 1024) throw new VaultError(413, 'El archivo supera 40 MB.');
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }

  private parse(raw: string): Scene {
    try {
      return sceneSchema.parse(JSON.parse(raw));
    } catch {
      throw new VaultError(422, 'El archivo no contiene una escena Excalidraw válida.');
    }
  }

  private encode(scene: Scene) {
    const raw = JSON.stringify(sceneSchema.parse(scene), null, 2) + '\n';
    if (Buffer.byteLength(raw, 'utf8') > 40 * 1024 * 1024)
      throw new VaultError(413, 'El documento supera 40 MB.');
    return raw;
  }

  async list(): Promise<Entry[]> {
    const entries: Entry[] = [];
    const visit = async (folder: string) => {
      for (const entry of await fs.readdir(path.join(this.root, folder), { withFileTypes: true })) {
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
    return entries.sort((a, b) => a.path.localeCompare(b.path, 'es', { numeric: true }));
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
        throw new VaultError(409, 'Ya existe un archivo o carpeta con ese nombre.', 'exists');
      if (kind === 'folder') {
        await fs.mkdir(absolute, { mode: 0o700 });
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
          throw new VaultError(409, 'El archivo se ha movido o eliminado.', 'conflict');
        throw e;
      }
      if (hash(old) !== revision)
        throw new VaultError(409, 'El archivo ha cambiado fuera de este editor.', 'conflict');
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
          throw new VaultError(409, 'El archivo ha cambiado durante el guardado.', 'conflict');
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
        throw new VaultError(400, 'No puedes mover una carpeta dentro de sí misma.');
      const stat = await fs.lstat(source);
      if (stat.isFile()) this.requireDocument(to);
      await this.parent(to);
      if (await exists(target)) throw new VaultError(409, 'El destino ya existe.', 'exists');
      await fs.rename(source, target);
    });
  }

  async trash(relative: string) {
    return this.serial(async () => {
      const absolute = await this.resolve(relative);
      const stat = await fs.lstat(absolute);
      const item: TrashEntry = {
        id: randomUUID(),
        path: relative,
        kind: stat.isDirectory() ? 'folder' : 'file',
        deleted: new Date().toISOString(),
      };
      const directory = path.join(this.root, '.workspace/trash', item.id);
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(path.join(directory, 'meta.json'), JSON.stringify(item), { mode: 0o600 });
      await fs.rename(absolute, path.join(directory, 'content'));
      return item;
    });
  }

  async listTrash(): Promise<TrashEntry[]> {
    const directory = path.join(this.root, '.workspace/trash');
    const result = [];
    for (const id of await fs.readdir(directory)) {
      const entry = path.join(directory, id);
      if (!(await exists(path.join(entry, 'content')))) continue;
      result.push(
        JSON.parse(await fs.readFile(path.join(entry, 'meta.json'), 'utf8')) as TrashEntry,
      );
    }
    return result.sort((a, b) => b.deleted.localeCompare(a.deleted));
  }

  async restore(id: string, destination?: string) {
    return this.serial(async () => {
      if (!/^[\da-f-]{36}$/.test(id)) throw new VaultError(400, 'Identificador no válido.');
      const directory = path.join(this.root, '.workspace/trash', id);
      const meta = JSON.parse(
        await fs.readFile(path.join(directory, 'meta.json'), 'utf8'),
      ) as TrashEntry;
      const relative = destination ?? meta.path;
      const absolute = await this.resolve(relative);
      if (meta.kind === 'file') this.requireDocument(relative);
      await this.parent(relative);
      if (await exists(absolute))
        throw new VaultError(409, 'El destino ya existe. Restaura con otro nombre.', 'exists');
      await fs.rename(path.join(directory, 'content'), absolute);
      await fs.rm(directory, { recursive: true });
      return relative;
    });
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
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new VaultError(400, 'Revisión no válida.');
    return this.parse(
      await this.readRaw(
        path.join(this.root, '.workspace/history', hash(relative), `${revision}.excalidraw`),
      ),
    );
  }
}
