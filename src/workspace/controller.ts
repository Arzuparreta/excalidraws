import { loadEditor } from '../editor/loader';
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { Document, Entry, HistoryEntry, Scene, TrashEntry } from '../../shared/model';
import type { EditorHandle, EditorState, ViewportPoint } from '../editor/contract';
import {
  EXTENSION,
  canvasLink,
  canvasName,
  folderCanvas,
  inCanvas,
  outermost,
  parentCanvas,
  relocated,
  relocatedLink,
} from '../../shared/canvas';
import { api, ApiError } from './api';
import { drafts } from './drafts';
import { DocumentSession, type SaveState } from './session';

export const basename = (path: string) => path.split('/').at(-1)!;
export const title = canvasName;
/** The content folder that contains a canvas ('' is the top level). Siblings share it. */
export const parent = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
/** True when the canvas `path` is `root` or inside it. Nothing is inside ''. */
export const within = inCanvas;
/** Removes duplicates and canvases already included by a selected ancestor. */
export const topLevel = (paths: string[]) => outermost(paths);
export const pathWithName = (entry: Pick<Entry, 'path'>, name: string) => {
  const trimmed = name.trim();
  return join(parent(entry.path), trimmed.endsWith(EXTENSION) ? trimmed : `${trimmed}${EXTENSION}`);
};
export const readSetting = (key: string) => {
  try {
    return localStorage.getItem(`excalidraws:${key}`);
  } catch {
    return null;
  }
};
export const saveSetting = (key: string, value: string) => {
  try {
    localStorage.setItem(`excalidraws:${key}`, value);
  } catch {
    /* Storage may be disabled. */
  }
};
const emptyState: SaveState = { status: 'saved', dirty: false, message: '', localError: false };
const departError = 'Save or resolve the current canvas before opening another one.';
const messageOf = (error: unknown, fallback = 'The operation could not be completed.') =>
  error instanceof Error && error.message ? error.message : fallback;
const translate = relocated;
/** A usable canvas name from free text, such as a label selected in the drawing. */
const canvasNameFrom = (value: unknown) =>
  typeof value === 'string'
    ? value
        .replace(/[\x00-\x1f\x7f]+/g, ' ')
        .replace(/[/\\]/g, '-')
        .replace(/\.excalidraw$/i, '')
        .replace(/^[\s.]+/, '')
        .replace(/\s+/g, ' ')
        .slice(0, 120)
        .trim()
    : '';
const displayName = (path: string) => title(path);
/** Name of the canvas that owns a content folder, quoted; the top level is the Library. */
const folderLabel = (folder: string) => (folder ? `"${basename(folder)}"` : 'Library');
const inside = (count: number) =>
  count ? ` and ${count === 1 ? 'the canvas' : `${count} canvases`} inside it` : '';
const quoted = (paths: string[], noun = 'items') =>
  paths.length === 1 ? `"${displayName(paths[0])}"` : `${paths.length} ${noun}`;
const sameEntry = (a: Entry, b: Entry) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key as keyof Entry] === b[key as keyof Entry]);
};
// Mirrors the server's fallback sibling order, so undoing a first reorder clears it.
const nameOrder = (a: string, b: string) =>
  basename(a).localeCompare(basename(b), 'en', { numeric: true }) ||
  a.localeCompare(b, 'en', { numeric: true });

export interface Renaming {
  path: string;
  name: string;
  error: string;
}
export interface Notice {
  message: string;
  canUndo: boolean;
}
export interface Navigation {
  paths: string[];
  index: number;
}
type HistoryMode = 'push' | 'replace' | 'none' | 'adopt';
interface OpenRequest {
  path: string;
  history: HistoryMode;
  /** Navigation index of the browser entry that requested this canvas. */
  index?: number;
  /** Navigation index to return to when a browser Back/Forward cannot be honored. */
  back?: number;
}
interface StoredNotice {
  message: string;
  paths: string[];
  undo?: () => Promise<void>;
}

// Browser history entries carry this page load's identifier, so indexes left by an
// earlier load of the page are never mistaken for entries of the current navigation.
const historyKey = 'excalidraws';
const pageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const historyIndex = (state: unknown) => {
  const value = isRecord(state) ? state[historyKey] : undefined;
  return isRecord(value) && value.page === pageId && typeof value.index === 'number'
    ? value.index
    : undefined;
};
const linkedCanvas = () => {
  try {
    return new URL(window.location.href).searchParams.get('canvas') ?? '';
  } catch {
    return '';
  }
};
const writeHistory = (mode: 'push' | 'replace', path: string, index: number) => {
  try {
    const url = new URL(window.location.href);
    if (path) url.searchParams.set('canvas', path);
    else url.searchParams.delete('canvas');
    const previous =
      mode === 'replace' && isRecord(window.history.state) ? window.history.state : {};
    const state = { ...previous, [historyKey]: { page: pageId, index } };
    const href = `${url.pathname}${url.search}${url.hash}`;
    if (mode === 'push') window.history.pushState(state, '', href);
    else window.history.replaceState(state, '', href);
  } catch {
    /* History can be unavailable in sandboxed frames. */
  }
};

export function createWorkspace() {
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [session, setSession] = createSignal<DocumentSession>();
  const [documentPath, setDocumentPath] = createSignal('');
  const [saveState, setState] = createSignal<SaveState>(emptyState);
  const [editorPending, setEditorPending] = createSignal(false);
  const [editorState, setEditorState] = createSignal<EditorState>();
  const state = createMemo<SaveState>(() =>
    editorPending()
      ? {
          ...saveState(),
          dirty: true,
          status: saveState().status === 'saved' ? 'pending' : saveState().status,
        }
      : saveState(),
  );
  const [loaded, setLoaded] = createSignal(false);
  const [queued, setQueued] = createSignal(0);
  const busy = () => queued() > 0;
  const [pendingPaths, setPendingPaths] = createSignal<Set<string>>(new Set());
  const [error, setError] = createSignal('');
  const [renaming, setRenaming] = createSignal<Renaming>();
  const [announcement, setAnnouncement] = createSignal('');
  const [trash, setTrash] = createSignal<TrashEntry[]>();
  const [history, setHistory] = createSignal<HistoryEntry[]>();
  const [reloadConfirm, setReloadConfirm] = createSignal(false);
  // A document switch is either an open request or an operation that mounts another
  // canvas (create, duplicate, import, restore, reload). Only then is the editor inert.
  const [openTarget, setOpenTarget] = createSignal('');
  const [operationTarget, setOperationTarget] = createSignal('');
  const switchTarget = createMemo(() => openTarget() || operationTarget());
  const [navigation, setNavigation] = createSignal<Navigation>({ paths: [], index: -1 });
  const [storedNotice, setStoredNotice] = createSignal<StoredNotice>();
  const notice = createMemo<Notice | undefined>(() => {
    const value = storedNotice();
    return value && { message: value.message, canUndo: !!value.undo };
  });
  let editor: EditorHandle | undefined;
  let importInput: HTMLInputElement | undefined;
  let importFolder = '';
  let disposed = false;
  let requested: OpenRequest | undefined;
  let opening: Promise<boolean | undefined> | undefined;
  let readController: AbortController | undefined;
  let refreshPending = false;
  let checking = false;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let treeSignature = '';
  let tail: Promise<unknown> = Promise.resolve();
  const pendingCounts = new Map<string, number>();
  let renameFlight: { value: Renaming; promise: Promise<Relocation | undefined> } | undefined;
  let lastRename: Relocation | undefined;
  type Relocation = { from: string; to: string };

  createEffect(() => {
    const current = session();
    setState(current?.snapshot() ?? emptyState);
    if (current) onCleanup(current.subscribe(() => setState(current.snapshot())));
  });
  const refresh = async () => {
    const tree = await api.entries();
    if (disposed) return tree;
    const signature = JSON.stringify(tree);
    if (treeSignature !== signature) {
      treeSignature = signature;
      setEntries((previous) => {
        const existing = new Map(previous.map((entry) => [entry.path, entry]));
        return tree.map((entry) => {
          const old = existing.get(entry.path);
          return old && sameEntry(old, entry) ? old : entry;
        });
      });
    }
    return tree;
  };
  const entry = (path: string) => entries().find((item) => item.path === path);
  /** Whether the canvas that owns a content folder exists ('' is the top level). */
  const isFolder = (folder: string) => !folder || !!entry(folderCanvas(folder));
  const affectsActive = (path: string) => within(session()?.document.path ?? '', path);
  const mount = async (document: Document, allowed = () => true, missing = false) => {
    const draft = await drafts.read(document.path).catch(() => undefined);
    if (disposed || !allowed()) return false;
    const next = new DocumentSession(document, api, drafts, draft);
    if (missing) next.preserveMissing();
    session()?.dispose();
    batch(() => {
      setSession(next);
      setDocumentPath(document.path);
    });
    saveSetting('last', document.path);
    return true;
  };

  // The navigation list mirrors the browser entries created by this page load, so the
  // in-app Back and Forward controls and the browser buttons move through the same visits.
  const visit = (path: string, mode: HistoryMode, index?: number) => {
    if (mode === 'push' || mode === 'none' || mode === 'adopt') setStoredNotice(undefined);
    const value = navigation();
    if (mode === 'push' && value.paths[value.index] !== path) {
      const paths = [...value.paths.slice(0, value.index + 1), path];
      setNavigation({ paths, index: paths.length - 1 });
      writeHistory('push', path, paths.length - 1);
      return;
    }
    if (mode === 'adopt') {
      const paths = [...value.paths.slice(0, value.index + 1), path];
      setNavigation({ paths, index: paths.length - 1 });
      writeHistory('replace', path, paths.length - 1);
      return;
    }
    const target = index ?? Math.max(0, value.index);
    const paths = [...value.paths];
    paths[target] = path;
    setNavigation({ paths, index: target });
    writeHistory('replace', path, target);
  };
  const check = async () => {
    if (disposed || document.visibilityState === 'hidden') return;
    if (checking || busy()) {
      refreshPending = true;
      return;
    }
    checking = true;
    refreshPending = false;
    const current = session();
    try {
      editor?.flush();
      const changed = await current?.checkExternal();
      if (changed)
        await mount(changed, () => {
          editor?.flush();
          return current === session() && !busy() && !current?.snapshot().dirty;
        });
      await refresh();
    } catch {
      /* Preserve the current scene and tree while disconnected. */
    } finally {
      checking = false;
      if (refreshPending) scheduleCheck();
    }
  };
  const scheduleCheck = () => {
    refreshPending = true;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => void check(), 180);
  };
  const hold = (paths: string[]) => {
    const keys = [...new Set(paths.filter(Boolean))];
    if (!keys.length) return () => {};
    for (const key of keys) pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1);
    setPendingPaths(new Set(pendingCounts.keys()));
    return () => {
      for (const key of keys) {
        const count = (pendingCounts.get(key) ?? 1) - 1;
        if (count > 0) pendingCounts.set(key, count);
        else pendingCounts.delete(key);
      }
      setPendingPaths(new Set(pendingCounts.keys()));
    };
  };
  // Every operation runs in order. Nothing is dropped while another one is running.
  // Errors are reported through error() and resolve the operation as undefined.
  const enqueue = <T>(
    operation: () => Promise<T>,
    paths: string[] = [],
  ): Promise<T | undefined> => {
    if (disposed) return Promise.resolve(undefined);
    setError('');
    const release = hold(paths);
    setQueued((count) => count + 1);
    const result = tail
      .then(async () => {
        if (disposed) return undefined;
        try {
          return await operation();
        } catch (e) {
          if (!disposed) setError(messageOf(e));
          return undefined;
        } finally {
          setOperationTarget('');
        }
      })
      .finally(() => {
        release();
        setQueued((count) => count - 1);
        if (queued() === 0 && refreshPending && !disposed) scheduleCheck();
      });
    tail = result.catch(() => undefined);
    return result;
  };
  const ensureSaved = async () => {
    editor?.flush();
    return !session() || session()!.flush();
  };
  const setNotice = (message: string, paths: string[] = [], undo?: () => Promise<void>) =>
    setStoredNotice({ message, paths, undo });

  // Serialize departure, cancel stale reads and commit only the latest requested canvas.
  // No inactive editor or document cache is kept in memory.
  const requestOpen = (target: OpenRequest): Promise<boolean> => {
    if (!target.path || disposed) return Promise.resolve(false);
    readController?.abort();
    if (!opening && target.path === session()?.document.path) {
      requested = undefined;
      if (target.history === 'none' && target.index !== undefined)
        visit(target.path, 'none', target.index);
      return Promise.resolve(true);
    }
    requested = target;
    setOpenTarget(target.path);
    if (opening) {
      setError('');
      return opening.then(() => session()?.document.path === target.path);
    }
    const fail = (failed: OpenRequest) => {
      // Keep the address bar truthful when a browser Back/Forward could not be honored.
      if (failed.history !== 'none' && failed.history !== 'adopt') return;
      if (failed.index !== undefined && failed.back !== undefined && failed.back >= 0) {
        const delta = failed.back - failed.index;
        if (delta) window.history.go(delta);
        return;
      }
      writeHistory('replace', documentPath(), navigation().index);
    };
    const operation = enqueue(async () => {
      let current: OpenRequest | undefined;
      try {
        let departed = false;
        while (requested && !disposed) {
          const next: OpenRequest = requested;
          current = next;
          setOpenTarget(next.path);
          if (
            next.history === 'none' &&
            next.index !== undefined &&
            next.back !== undefined &&
            !entry(next.path)
          ) {
            // A queued operation may have deleted this historical visit since
            // popstate inspected the tree. Skip it in the original direction.
            const direction = next.index < next.back ? -1 : 1;
            const paths = navigation().paths;
            let index = next.index;
            while (index >= 0 && index < paths.length && !entry(paths[index])) index += direction;
            window.history.go(index - next.index);
            return false;
          }
          if (next.path === session()?.document.path) {
            if (next.history !== 'push') visit(next.path, next.history, next.index);
            return true;
          }
          if (!departed || session()?.snapshot().dirty) {
            departed = await ensureSaved();
            if (requested !== next) continue;
            if (!departed) throw new Error(departError);
          }
          readController = new AbortController();
          let document: Document;
          try {
            document = await api.read(next.path, readController.signal);
          } catch (e) {
            if (requested !== next) continue;
            throw e;
          }
          if (requested !== next || session()?.snapshot().dirty) continue;
          if (await mount(document, () => requested === next)) {
            visit(next.path, next.history, next.index);
            return true;
          }
        }
        return false;
      } catch (e) {
        if (current) fail(current);
        throw e;
      } finally {
        requested = undefined;
        readController = undefined;
        opening = undefined;
        setOpenTarget('');
      }
    });
    opening = operation;
    return operation.then((done) => !!done);
  };
  const open = (path: string) => requestOpen({ path, history: 'push' });
  const navigationIndex = (direction: -1 | 1) => {
    const value = navigation();
    let index = value.index + direction;
    while (index >= 0 && index < value.paths.length) {
      if (entry(value.paths[index])) return index;
      index += direction;
    }
    return -1;
  };
  const canNavigate = (direction: -1 | 1) => navigationIndex(direction) !== -1;
  const navigate = (direction: -1 | 1) => {
    const value = navigation();
    const index = navigationIndex(direction);
    if (index === -1) return;
    const path = value.paths[index];
    if (historyIndex(window.history.state) === value.index) window.history.go(index - value.index);
    else void requestOpen({ path, history: 'replace', index });
  };

  const relocate = async (from: string, to: string) => {
    if (from === to) return;
    const current = session();
    const path = current?.document.path;
    const affected = !!current && !!path && within(path, from);
    const resume = affected ? current.pauseSaving() : undefined;
    // The server rewrites links to the moved canvas in every other canvas. The open one
    // is updated in the editor instead, so its unsaved drawing is never replaced.
    const exclude = editor && current ? current.document.path : undefined;
    try {
      await api.move(from, to, exclude);
      const index = navigation().index;
      batch(() => {
        const name = renaming();
        if (name && within(name.path, from))
          setRenaming({ ...name, path: translate(name.path, from, to) });
        setEntries((items) =>
          items.map((item) =>
            within(item.path, from)
              ? {
                  ...item,
                  path: translate(item.path, from, to),
                  ...(item.archiveRoot && { archiveRoot: translate(item.archiveRoot, from, to) }),
                }
              : item,
          ),
        );
        setNavigation((value) => ({
          ...value,
          paths: value.paths.map((item) => translate(item, from, to)),
        }));
        if (requested && within(requested.path, from)) {
          requested = { ...requested, path: translate(requested.path, from, to) };
          setOpenTarget(requested.path);
        }
        if (affected) {
          const next = translate(path, from, to);
          current.relocate(next);
          setDocumentPath(next);
          saveSetting('last', next);
          writeHistory('replace', next, index);
        }
      });
    } finally {
      resume?.();
    }
    if (exclude) editor?.rewriteLinks((link) => relocatedLink(link, from, to));
  };

  const startRename = (path: string) => {
    const item = entry(path);
    if (!item) return;
    setRenaming({ path, name: title(path), error: '' });
  };
  const cancelRename = () => {
    if (renameFlight && renameFlight.value === renaming()) return;
    setRenaming(undefined);
  };
  const commitRename = (): Promise<Relocation | undefined> => {
    const value = renaming();
    if (!value) return Promise.resolve({ from: '', to: '' });
    if (renameFlight?.value === value) return renameFlight.promise;
    const promise = enqueue(async (): Promise<Relocation | undefined> => {
      try {
        const name = value.name.trim();
        if (!name) throw new Error('Enter a name.');
        if (/[/\\]/.test(name)) throw new Error('Names cannot contain slashes.');
        const item = entry(value.path);
        if (!item) throw new Error('This item is no longer available.');
        const target = pathWithName(item, name);
        if (target !== value.path) {
          if (affectsActive(value.path) && !(await ensureSaved()))
            throw new Error('Save your current canvas before renaming.');
          await relocate(value.path, target);
          lastRename = { from: value.path, to: target };
        }
        const current = renaming();
        if (current === value || current?.path === target) setRenaming(undefined);
        setAnnouncement(`Renamed to ${name}.`);
        if (target !== value.path) await refresh();
        return { from: value.path, to: target };
      } catch (e) {
        const current = renaming();
        if (current === value || current?.path === value.path)
          setRenaming({ ...(current ?? value), error: messageOf(e, 'Could not rename.') });
        return undefined;
      }
    }, [value.path]);
    const flight = { value, promise };
    renameFlight = flight;
    void promise.finally(() => {
      if (renameFlight === flight) renameFlight = undefined;
    });
    return promise;
  };
  const rename = async () => !!(await commitRename());
  const finishRename = async (path: string) => {
    const result = await commitRename();
    if (disposed || !result) return undefined;
    const relocation = result.from ? result : lastRename;
    if (relocation && within(path, relocation.from) && !entry(path))
      return translate(path, relocation.from, relocation.to);
    return path;
  };

  type Created = { path: string; name: string; document: Document };
  const createUnique = async (
    folder: string,
    name: (attempt: number) => string,
    scene?: Scene,
  ): Promise<Created> => {
    const occupied = new Set(entries().map((item) => item.path));
    for (let attempt = 0; attempt < 1000 && !disposed; attempt++) {
      const base = name(attempt);
      const path = join(folder, `${base}${EXTENSION}`);
      if (occupied.has(path)) continue;
      try {
        return { path, name: base, document: await api.create(path, scene) };
      } catch (e) {
        // Another client may have claimed this name since the tree was read.
        if (!(e instanceof ApiError) || e.code !== 'exists') throw e;
        occupied.add(path);
      }
    }
    throw new Error('Could not find an available name.');
  };
  const numbered = (base: string) => (attempt: number) => (attempt ? `${base} (${attempt})` : base);

  // Links between canvases. The open editor owns the drawing; these only change its scene.
  const linkLabel = (path: string) => ({ label: title(path), link: canvasLink(path) });
  /** Links the selected elements to a canvas. */
  const linkSelection = (path: string) => {
    if (!editor?.linkSelection(canvasLink(path))) return false;
    setAnnouncement(`Linked the selection to ${title(path)}.`);
    return true;
  };
  /** Adds labels that link to canvases: at a viewport point, or centered in view. */
  const insertLinks = (paths: string[], point?: ViewportPoint) => {
    if (!paths.length || !editor?.insertLinks(paths.map(linkLabel), point)) return false;
    setAnnouncement(
      paths.length === 1 ? `Added a link to ${title(paths[0]!)}.` : `Added ${paths.length} links.`,
    );
    return true;
  };
  /**
   * Creates a canvas inside the open one without leaving it, and links the selection to
   * it, or adds a label that links to it.
   */
  const createLinked = (name?: string) => {
    const current = session();
    if (!current) return Promise.resolve(undefined);
    const owner = current.document.path;
    return enqueue(async () => {
      const base = canvasNameFrom(name) || 'Untitled canvas';
      const folder = owner.slice(0, -EXTENSION.length);
      if (!entry(owner)) throw new Error('Save this canvas before adding canvases inside it.');
      const created = await createUnique(folder, numbered(base));
      await refresh();
      if (session()?.document.path === owner) {
        const selected = (editorState()?.selection.count ?? 0) > 0;
        if (selected) editor?.linkSelection(canvasLink(created.path));
        else editor?.insertLinks([linkLabel(created.path)]);
      }
      setAnnouncement(`Created ${created.name} inside ${title(owner)} and linked it.`);
      return created.path;
    }, [owner]);
  };
  // Opens a canvas that an operation just created, if the current one can be left.
  const openCreated = async (created: Created, message: string) => {
    setOperationTarget(created.path);
    if (!(await ensureSaved())) {
      setNotice(`${message} Save or resolve the current canvas to open it.`);
      return false;
    }
    if (await mount(created.document)) visit(created.path, 'push');
    setAnnouncement(message);
    return true;
  };

  /** Creates a canvas inside the canvas that owns `folder` ('' is the top level), and opens it. */
  const create = (folder: unknown = '', name?: unknown) => {
    const destination = typeof folder === 'string' ? folder : '';
    return enqueue(async () => {
      const base = canvasNameFrom(name) || 'Untitled canvas';
      if (!isFolder(destination)) throw new Error('The destination canvas is no longer available.');
      setOperationTarget(join(destination, `${base}${EXTENSION}`));
      if (!(await ensureSaved())) throw new Error(departError);
      const created = await createUnique(destination, numbered(base));
      if (await mount(created.document)) visit(created.path, 'push');
      await refresh();
      setAnnouncement(
        destination
          ? `Created ${created.name} inside ${basename(destination)}.`
          : `Created ${created.name}.`,
      );
      return created.path;
    }, [folderCanvas(destination)]);
  };

  const moveAll = async (moves: Relocation[]) => {
    const done: Relocation[] = [];
    const failures: string[] = [];
    for (const { from, to } of moves) {
      try {
        if (affectsActive(from) && !(await ensureSaved()))
          throw new Error('Save or resolve your current canvas before moving it.');
        await relocate(from, to);
        done.push({ from, to });
      } catch (e) {
        failures.push(
          e instanceof ApiError && e.code === 'exists'
            ? `"${title(to)}" already exists in ${folderLabel(parent(to))}.`
            : `"${displayName(from)}": ${messageOf(e)}`,
        );
      }
    }
    return { done, failures };
  };
  const move = (
    paths: string[],
    folder: string,
    placement?: { target: string; where: 'before' | 'after' },
  ) => {
    const sources = topLevel(paths);
    return enqueue(async () => {
      if (!isFolder(folder)) throw new Error('The destination canvas is no longer available.');
      const previousOrders = new Map(
        [...new Set([folder, ...sources.map(parent)])].map((location) => [
          location,
          entries()
            .filter((item) => parent(item.path) === location)
            .sort(
              (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || nameOrder(a.path, b.path),
            )
            .map((item) => item.path),
        ]),
      );
      const result: string[] = [];
      const moves: Relocation[] = [];
      const failures: string[] = [];
      for (const from of sources) {
        if (!entry(from)) failures.push(`"${displayName(from)}" is no longer available.`);
        else if (within(folderCanvas(folder), from))
          failures.push(`"${displayName(from)}" cannot be moved inside itself.`);
        else if (parent(from) === folder) result.push(from);
        else moves.push({ from, to: join(folder, basename(from)) });
      }
      const outcome = await moveAll(moves);
      failures.push(...outcome.failures);
      result.push(...outcome.done.map(({ to }) => to));
      await refresh();
      const moved = outcome.done;
      if (moved.length && placement) {
        const moving = new Set(result);
        const order = entries()
          .filter((item) => parent(item.path) === folder && !moving.has(item.path))
          .sort(
            (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || nameOrder(a.path, b.path),
          )
          .map((item) => item.path);
        const index = order.indexOf(placement.target);
        if (index >= 0) {
          order.splice(index + (placement.where === 'after' ? 1 : 0), 0, ...moving);
          try {
            await api.order(folder, order);
            await refresh();
          } catch (error) {
            // The move still succeeded; retain its Undo if placing it failed.
            failures.push(`Moved, but the position could not be saved. ${messageOf(error)}`);
          }
        }
      }
      if (moved.length)
        setNotice(
          `Moved ${quoted(moved.map(({ to }) => to))} to ${folderLabel(folder)}.`,
          moved.map(({ to }) => to),
          async () => {
            const back = await moveAll(
              moved.map(({ from, to }) => ({ from: to, to: from })).reverse(),
            );
            await refresh();
            // A move removes a child from its previous sibling order. Restore that
            // position too, while retaining any new children added since the move.
            for (const [location, paths] of previousOrders) {
              if (!isFolder(location)) continue;
              const remaining = paths.filter((path) => entry(path) && parent(path) === location);
              const natural = [...remaining].sort(nameOrder);
              await api.order(
                location,
                remaining.join('\n') === natural.join('\n') ? [] : remaining,
              );
            }
            await refresh();
            if (back.failures.length)
              throw new Error(`Undo incomplete. ${back.failures.join(' ')}`);
          },
        );
      if (failures.length) setError(failures.join(' '));
      return moved.length || !failures.length ? result : undefined;
    }, sources);
  };

  const reorder = (folder: string, paths: string[]) =>
    enqueue(async () => {
      const siblings = entries().filter((item) => parent(item.path) === folder);
      const previous = siblings
        .filter((item) => item.order !== undefined)
        .sort((a, b) => a.order! - b.order!)
        .map((item) => item.path);
      const byName = siblings.map((item) => item.path).sort(nameOrder);
      const restore = previous.join('\n') === byName.join('\n') ? [] : previous;
      await api.order(folder, paths);
      await refresh();
      setNotice(`Order of ${folderLabel(folder)} updated.`, paths, async () => {
        await refresh();
        await api.order(
          folder,
          restore.filter((path) => entry(path) && parent(path) === folder),
        );
        await refresh();
      });
      return true;
    }, paths).then((done) => !!done);

  const setArchived = (paths: string[], value: boolean) =>
    enqueue(async () => {
      const items = new Map(entries().map((item) => [item.path, item]));
      const explicit = (path: string) => {
        const item = items.get(path);
        return !!item?.archived && (item.archiveRoot ?? item.path) === path;
      };
      let targets: string[];
      if (value) {
        targets = topLevel(paths).filter((path) => items.has(path) && !items.get(path)!.archived);
      } else {
        // Unarchiving makes the item visible again, including its archived ancestors.
        const roots = new Set<string>();
        for (const path of paths) {
          const item = items.get(path);
          if (!item?.archived) continue;
          if (item.archiveRoot) roots.add(item.archiveRoot);
          for (let current = path; current; current = parentCanvas(current))
            if (explicit(current)) roots.add(current);
        }
        targets = [...roots];
      }
      if (!targets.length) return true;
      await api.setLibrary(targets, 'archived', value);
      await refresh();
      setNotice(`${value ? 'Archived' : 'Unarchived'} ${quoted(targets)}.`, targets, async () => {
        await api.setLibrary(targets, 'archived', !value);
        await refresh();
      });
      return true;
    }, paths).then((done) => !!done);

  const setFavorite = (paths: string[], value: boolean) =>
    enqueue(async () => {
      const targets = [...new Set(paths)].filter((path) => {
        const item = entry(path);
        return item && !!item.favorite !== value;
      });
      if (!targets.length) return true;
      await api.setLibrary(targets, 'favorite', value);
      await refresh();
      setAnnouncement(
        `${value ? 'Added' : 'Removed'} ${quoted(targets)} ${value ? 'to' : 'from'} Favorites.`,
      );
      return true;
    }, paths).then((done) => !!done);

  const duplicate = (input?: unknown) => {
    const path = typeof input === 'string' && input ? input : documentPath();
    if (!path) return Promise.resolve(undefined);
    return enqueue(async () => {
      const current = session();
      const active = current?.document.path === path;
      let scene: Scene;
      let saved = true;
      if (current && active) {
        // Copy the drawing as shown, including a draft that cannot be saved to its file.
        setOperationTarget(path);
        saved = await ensureSaved();
        scene = current.getScene();
      } else {
        if (!entry(path)) throw new Error('This canvas is no longer available.');
        scene = (await api.read(path)).scene;
      }
      const folder = isFolder(parent(path)) ? parent(path) : '';
      const base = title(path).replace(/ \(copy(?: \d+)?\)$/, '');
      const created = await createUnique(
        folder,
        (attempt) => `${base} (copy${attempt ? ` ${attempt + 1}` : ''})`,
        scene,
      );
      if (current && active && session() === current) {
        setOperationTarget(created.path);
        if (await mount(created.document)) {
          visit(created.path, 'push');
          // The copy now holds the unsaved version. The original file stays as it is.
          if (!saved) await current.discard().catch(() => undefined);
        }
      }
      await refresh();
      setAnnouncement(`Duplicated as ${created.name}.`);
      return created.path;
    }, [path]);
  };

  const trashEntries = (paths: string[]) => {
    const targets = topLevel(paths);
    return enqueue(async () => {
      const items: TrashEntry[] = [];
      const failures: string[] = [];
      let activeTrashed: string | undefined;
      for (const path of targets) {
        if (!entry(path)) {
          failures.push(`"${displayName(path)}" is no longer available.`);
          continue;
        }
        const current = session();
        const affected = !!current && affectsActive(path);
        let resume: (() => void) | undefined;
        try {
          if (affected) {
            if (!(await ensureSaved()))
              throw new Error('Save or resolve your current canvas before moving it to Trash.');
            resume = current.pauseSaving();
          }
          items.push(await api.trash(path));
          const name = renaming();
          if (name && within(name.path, path)) setRenaming(undefined);
          if (affected) {
            // Text and keyboard edits can still be coalesced in the adapter.
            editor?.flush();
            resume?.();
            resume = undefined;
            if (current.snapshot().dirty) {
              // Drawn while the request was running: keep it here as a recoverable draft.
              current.preserveMissing();
            } else {
              activeTrashed = current.document.path;
              current.dispose();
              batch(() => {
                setSession(undefined);
                setDocumentPath('');
              });
              saveSetting('last', '');
              writeHistory('replace', '', navigation().index);
            }
          }
        } catch (e) {
          failures.push(`"${displayName(path)}": ${messageOf(e)}`);
        } finally {
          resume?.();
        }
      }
      await refresh();
      if (trash() !== undefined) setTrash(await api.listTrash());
      if (items.length)
        setNotice(
          items.length === 1
            ? `Moved ${quoted([items[0]!.path])}${inside(items[0]!.inside)} to Trash.`
            : `Moved ${quoted(
                items.map((item) => item.path),
                'canvases',
              )} to Trash.`,
          items.map((item) => item.path),
          () => restoreItems(items, activeTrashed),
        );
      if (failures.length) setError(failures.join(' '));
      return items.length > 0 && !failures.length;
    }, targets).then((done) => !!done);
  };
  const restoreItems = async (items: TrashEntry[], activeTrashed?: string) => {
    const restored: { item: TrashEntry; path: string }[] = [];
    const failures: string[] = [];
    for (const item of [...items].reverse()) {
      try {
        // Without a path the server restores to the original place or a free readable name.
        restored.push({ item, path: (await api.restore(item.id)).path });
      } catch (e) {
        failures.push(`"${displayName(item.path)}": ${messageOf(e)}`);
      }
    }
    await refresh();
    if (trash() !== undefined) setTrash(await api.listTrash());
    const owner = activeTrashed && restored.find(({ item }) => within(activeTrashed, item.path));
    if (owner && activeTrashed && !session()) {
      const path = translate(activeTrashed, owner.item.path, owner.path);
      if (await mount(await api.read(path))) visit(path, 'replace');
    }
    const renamed = restored.filter(({ item, path }) => item.path !== path);
    if (renamed.length)
      setNotice(
        renamed
          .map(
            ({ item, path }) => `Restored "${displayName(item.path)}" as "${displayName(path)}".`,
          )
          .join(' ') + ' The original name is in use.',
      );
    else setAnnouncement(`Restored ${quoted(restored.map(({ path }) => path))}.`);
    if (failures.length) throw new Error(`Some items could not be restored. ${failures.join(' ')}`);
  };
  const restoreTrash = (id: string, destination?: unknown) =>
    enqueue(async () => {
      const { path } = await api.restore(
        id,
        typeof destination === 'string' ? destination : undefined,
      );
      await refresh();
      if (trash() !== undefined) setTrash(await api.listTrash());
      setNotice(`Restored "${displayName(path)}" to ${folderLabel(parent(path))}.`);
      return path;
    }, [id]);

  const dismissNotice = () => setStoredNotice(undefined);
  const undo = async () => {
    const value = storedNotice();
    if (!value?.undo) return;
    // Clear first so the same change cannot be undone twice.
    setStoredNotice(undefined);
    const done = await enqueue(async () => {
      await value.undo!();
      return true;
    }, value.paths);
    if (done) setAnnouncement('Undone.');
  };

  const download = async (input?: unknown) => {
    const path = typeof input === 'string' && input ? input : documentPath();
    if (!path) return;
    try {
      const current = session();
      let scene: Scene;
      if (current && current.document.path === path) {
        editor?.flush();
        scene = current.getScene();
      } else scene = (await api.read(path)).scene;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(scene, null, 2)], { type: 'application/vnd.excalidraw+json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = basename(path);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(messageOf(e, 'Could not download the canvas.'));
    }
  };
  const onImport = (files: FileList | null, folder?: unknown) => {
    const destination = typeof folder === 'string' ? folder : importFolder;
    importFolder = '';
    if (!files?.length) return Promise.resolve(undefined);
    // FileList is live: capture it before resetting the input for another import.
    const imported = Array.from(files);
    if (importInput) importInput.value = '';
    return enqueue(async () => {
      if (!isFolder(destination)) throw new Error('The destination canvas is no longer available.');
      const { importScene } = await loadEditor();
      const failures: string[] = [];
      let last: Created | undefined;
      let count = 0;
      for (const file of imported) {
        try {
          if (file.size > 40 * 1024 * 1024) throw new Error('The file exceeds 40 MB.');
          const scene = await importScene(file);
          const original =
            file.name
              .replace(/\.excalidraw$|\.json$/g, '')
              .replace(/[/\\]/g, '-')
              .trim() || 'Imported canvas';
          last = await createUnique(destination, numbered(original), scene);
          count++;
        } catch (e) {
          failures.push(`"${file.name}": ${messageOf(e)}`);
        }
      }
      await refresh();
      if (last)
        await openCreated(
          last,
          count === 1 ? `Imported ${last.name}.` : `Imported ${count} canvases.`,
        );
      if (failures.length) setError(failures.join(' '));
      return last?.path;
    }, [destination]);
  };
  const showHistory = () =>
    enqueue(async () => {
      const current = session();
      if (!current) return;
      // Save first when possible so the latest drawing appears as a version.
      await ensureSaved();
      setHistory(await api.history(current.document.path));
    }).then(() => undefined);
  const restoreHistory = (revision: string) =>
    enqueue(async () => {
      const current = session();
      if (!current) return;
      const path = current.document.path;
      const scene = await api.historical(path, revision);
      const folder = isFolder(parent(path)) ? parent(path) : '';
      const base = title(path).replace(/ \(restored(?: \d+)?\)$/, '');
      const created = await createUnique(
        folder,
        (attempt) => `${base} (restored${attempt ? ` ${attempt + 1}` : ''})`,
        scene,
      );
      setHistory(undefined);
      await refresh();
      await openCreated(created, `Restored version saved as ${created.name}.`);
      return created.path;
    }, [documentPath()]);
  const reload = () =>
    enqueue(async () => {
      const current = session();
      if (!current) return;
      setOperationTarget(current.document.path);
      const remote = await api.read(current.document.path);
      await current.discard();
      if (session() === current) await mount(remote);
      setReloadConfirm(false);
    }).then(() => undefined);

  onMount(() => {
    void enqueue(async () => {
      const tree = await refresh();
      const files = new Set(tree.map((e) => e.path));
      const linked = linkedCanvas();
      const last = readSetting('last') ?? '';
      let opened = '';
      let failure: unknown;
      // A canvas in the address takes precedence over the last canvas of this browser.
      for (const candidate of [...new Set([linked, last])]) {
        if (!candidate || opened) continue;
        try {
          if (files.has(candidate)) {
            if (await mount(await api.read(candidate))) opened = candidate;
            continue;
          }
          // A missing canvas with a local draft is recovered rather than replaced.
          const draft = await drafts.read(candidate).catch(() => undefined);
          if (
            draft &&
            (await mount(
              { path: candidate, revision: draft.revision, scene: draft.scene },
              undefined,
              true,
            ))
          )
            opened = candidate;
          else if (candidate === linked)
            failure ??= new Error('The linked canvas is not available.');
        } catch (e) {
          failure ??= e;
        }
      }
      if (!opened) {
        const first = tree.find((e) => !e.archived);
        if (first && (await mount(await api.read(first.path)))) opened = first.path;
      }
      setNavigation(opened ? { paths: [opened], index: 0 } : { paths: [], index: -1 });
      writeHistory('replace', opened, opened ? 0 : -1);
      if (failure) throw failure;
    }).finally(() => setLoaded(true));
    let events: EventSource | undefined;
    const connect = () => {
      if (document.visibilityState === 'hidden') {
        events?.close();
        events = undefined;
        editor?.flush();
        void session()?.flush();
        return;
      }
      if (!events) {
        events = new EventSource('/api/events');
        events.addEventListener('change', scheduleCheck);
        events.addEventListener('open', scheduleCheck);
      }
      scheduleCheck();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      editor?.flush();
      if (session()?.snapshot().dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const popState = (event: PopStateEvent) => {
      const value = navigation();
      const index = historyIndex(event.state);
      if (index !== undefined && index !== value.index) {
        const direction = index < value.index ? -1 : 1;
        let next = index;
        while (next >= 0 && next < value.paths.length && !entry(value.paths[next]))
          next += direction;
        if (next !== index) {
          // Deleted historical visits must not trap Back/Forward on a dead canvas.
          window.history.go(next - index);
          return;
        }
      }
      // The navigation list follows renames and moves, unlike older addresses.
      const path = (index !== undefined ? value.paths[index] : undefined) || linkedCanvas();
      if (!path) {
        if (documentPath()) writeHistory('replace', documentPath(), value.index);
        return;
      }
      void requestOpen(
        index !== undefined
          ? { path, history: 'none', index, back: value.index }
          : { path, history: 'adopt' },
      );
    };
    connect();
    document.addEventListener('visibilitychange', connect);
    window.addEventListener('focus', scheduleCheck);
    window.addEventListener('online', connect);
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('popstate', popState);
    onCleanup(() => {
      disposed = true;
      clearTimeout(checkTimer);
      events?.close();
      readController?.abort();
      session()?.dispose();
      document.removeEventListener('visibilitychange', connect);
      window.removeEventListener('focus', scheduleCheck);
      window.removeEventListener('online', connect);
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('popstate', popState);
    });
  });
  return {
    entries,
    session,
    documentPath,
    state,
    loaded,
    busy,
    pendingPaths,
    error,
    setError,
    renaming,
    setRenaming,
    startRename,
    cancelRename,
    rename,
    finishRename,
    announcement,
    notice,
    dismissNotice,
    undo,
    trash,
    setTrash,
    history,
    setHistory,
    reloadConfirm,
    setReloadConfirm,
    switchTarget,
    canNavigate,
    open,
    navigate,
    create,
    move,
    reorder,
    setArchived,
    setFavorite,
    duplicate,
    trashEntries,
    download,
    onImport,
    showHistory,
    restoreHistory,
    restoreTrash,
    reload,
    showTrash: () =>
      enqueue(async () => {
        setTrash(await api.listTrash());
      }).then(() => undefined),
    refresh: () =>
      enqueue(async () => {
        await refresh();
      }).then(() => undefined),
    /** Whether a viewport point is over the open editor's drawing area. */
    pointInEditor: (point: ViewportPoint) => !!editor?.contains(point),
    setEditor: (handle: EditorHandle | undefined) => {
      editor = handle;
    },
    setEditorPending,
    editorState,
    setEditorState,
    linkSelection,
    insertLinks,
    createLinked,
    setImportInput: (input: HTMLInputElement) => {
      importInput = input;
    },
    /** Opens the file picker. Imported canvases go to folder, or the root by default. */
    importFiles: (folder?: unknown) => {
      importFolder = typeof folder === 'string' ? folder : '';
      importInput?.click();
    },
  };
}
export type Workspace = ReturnType<typeof createWorkspace>;
