import { batch, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { Document, Entry, HistoryEntry, TrashEntry } from '../../shared/model';
import type { EditorHandle } from '../editor/ExcalidrawAdapter';
import { api, ApiError } from './api';
import { drafts } from './drafts';
import { DocumentSession, type SaveState } from './session';

export const basename = (path: string) => path.split('/').at(-1)!;
export const title = (path: string) => basename(path).replace(/\.excalidraw$/, '');
export const parent = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
export const pathWithName = (entry: Pick<Entry, 'path' | 'kind'>, name: string) => {
  const trimmed = name.trim();
  return join(
    parent(entry.path),
    entry.kind === 'file' && !trimmed.endsWith('.excalidraw') ? `${trimmed}.excalidraw` : trimmed,
  );
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
export type Prompt = {
  mode: 'move' | 'copy';
  path?: string;
  name: string;
  folder: string;
};

export function createWorkspace() {
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [session, setSession] = createSignal<DocumentSession>();
  const [documentPath, setDocumentPath] = createSignal('');
  const [saveState, setState] = createSignal<SaveState>(emptyState);
  const [editorPending, setEditorPending] = createSignal(false);
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
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [selectedFolder, setSelectedFolder] = createSignal('');
  const [prompt, setPrompt] = createSignal<Prompt>();
  const [renaming, setRenaming] = createSignal<{ path: string; name: string; error: string }>();
  const [announcement, setAnnouncement] = createSignal('');
  const [deleting, setDeleting] = createSignal<Entry>();
  const [trash, setTrash] = createSignal<TrashEntry[]>();
  const [history, setHistory] = createSignal<HistoryEntry[]>();
  const [reloadConfirm, setReloadConfirm] = createSignal(false);
  const [switchTarget, setSwitchTarget] = createSignal('');
  const [navigation, setNavigation] = createSignal({ paths: [] as string[], index: -1 });
  let editor: EditorHandle | undefined;
  let importInput: HTMLInputElement | undefined;
  let disposed = false;
  let switching = false;
  let requested: { path: string; index?: number } | undefined;
  let readController: AbortController | undefined;
  let refreshPending = false;
  let checking = false;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let treeSignature = '';
  let operationDone: Promise<void> | undefined;

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
          return old?.kind === entry.kind && old.modified === entry.modified ? old : entry;
        });
      });
    }
    return tree;
  };
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
    setSelectedFolder(parent(document.path));
    return true;
  };
  const recordNavigation = (path: string, index?: number) => {
    setNavigation((value) =>
      index === undefined
        ? value.paths[value.index] === path
          ? value
          : {
              paths: [...value.paths.slice(0, value.index + 1), path].slice(-50),
              index: Math.min(value.index + 1, 49),
            }
        : { ...value, index },
    );
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
        await mount(changed, () => current === session() && !busy() && !current?.snapshot().dirty);
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
  const run = async (operation: () => Promise<void>) => {
    if (busy()) return;
    let finishOperation!: () => void;
    operationDone = new Promise((resolve) => {
      finishOperation = resolve;
    });
    batch(() => {
      setBusy(true);
      setError('');
    });
    try {
      await operation();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The operation could not be completed.');
    } finally {
      setBusy(false);
      if (refreshPending) scheduleCheck();
      finishOperation();
      operationDone = undefined;
    }
  };
  const ensureSaved = async () => {
    editor?.flush();
    return !session() || session()!.flush();
  };

  // Serialize departure, cancel stale reads and commit only the latest requested board.
  // No inactive editor or document cache is kept in memory.
  const open = (path: string, index?: number) => {
    if (busy() && !switching) return;
    requested = { path, index };
    readController?.abort();
    if (switching) {
      setSwitchTarget(path);
      return;
    }
    if (path === session()?.document.path) {
      requested = undefined;
      return;
    }
    switching = true;
    void run(async () => {
      try {
        setSwitchTarget(path);
        if (!(await ensureSaved())) return;
        while (requested && !disposed) {
          const target = requested;
          setSwitchTarget(target.path);
          if (target.path === session()?.document.path) break;
          readController = new AbortController();
          try {
            const document = await api.read(target.path, readController.signal);
            if (requested !== target) continue;
            const mounted = await mount(document, () => requested === target);
            if (mounted) {
              recordNavigation(target.path, target.index);
              break;
            }
          } catch (e) {
            if (requested !== target) continue;
            throw e;
          }
        }
      } finally {
        requested = undefined;
        readController = undefined;
        switching = false;
        setSwitchTarget('');
      }
    });
  };
  const navigate = (direction: number) => {
    const value = navigation();
    const index = value.index + direction;
    const path = value.paths[index];
    if (path) open(path, index);
  };
  const ask = (mode: Prompt['mode'], path?: string) => {
    if (busy()) return;
    setError('');
    setPrompt({
      mode,
      path,
      name: mode === 'copy' && session() ? `${title(session()!.document.path)} (copy)` : '',
      folder: path ? parent(path) : selectedFolder(),
    });
  };
  const updatePaths = (from: string, to?: string) => {
    const translate = (path: string) =>
      path === from || path.startsWith(`${from}/`)
        ? to === undefined
          ? undefined
          : to + path.slice(from.length)
        : path;
    setNavigation((value) => {
      const active = translate(value.paths[value.index] ?? '');
      const paths = value.paths.map(translate).filter((p): p is string => p !== undefined);
      return { paths, index: Math.max(-1, paths.lastIndexOf(active ?? '')) };
    });
    setSelectedFolder(translate(selectedFolder()) ?? '');
  };
  const relocate = async (from: string, to: string) => {
    if (from === to) return;
    const current = session();
    const path = current?.document.path;
    const affected = current && path && (path === from || path.startsWith(`${from}/`));
    const resume = affected ? current.pauseSaving() : undefined;
    try {
      await api.move(from, to);
      batch(() => {
        if (renaming()?.path === from) setRenaming(undefined);
        setEntries((items) =>
          items.map((entry) =>
            entry.path === from || entry.path.startsWith(`${from}/`)
              ? { ...entry, path: to + entry.path.slice(from.length) }
              : entry,
          ),
        );
        updatePaths(from, to);
        if (affected) {
          const next = to + path.slice(from.length);
          current.relocate(next);
          setDocumentPath(next);
          if (path === from) setSelectedFolder(parent(next));
          saveSetting('last', next);
        }
      });
    } finally {
      resume?.();
    }
  };
  const startRename = (path: string) => {
    if (busy()) return;
    const entry = entries().find((e) => e.path === path);
    if (!entry) return;
    setRenaming({
      path,
      name: entry.kind === 'file' ? title(path) : basename(path),
      error: '',
    });
  };
  const cancelRename = () => {
    if (!busy()) setRenaming(undefined);
  };
  const rename = async () => {
    const value = renaming();
    if (!value) return true;
    if (busy()) return false;
    let renamed = false;
    await run(async () => {
      try {
        const name = value.name.trim();
        if (!name) throw new Error('Enter a name.');
        if (/[/\\]/.test(name)) throw new Error('Names cannot contain slashes.');
        const entry = entries().find((e) => e.path === value.path);
        if (!entry) throw new Error('This item is no longer available.');
        const target = pathWithName(entry, name);
        if (target !== value.path) {
          if (!(await ensureSaved())) throw new Error('Save your current canvas before renaming.');
          await relocate(value.path, target);
        }
        setRenaming(undefined);
        renamed = true;
        setAnnouncement(`Renamed to ${name}.`);
      } catch (e) {
        setRenaming({ ...value, error: e instanceof Error ? e.message : 'Could not rename.' });
      }
      if (renamed) await refresh();
    });
    return renamed;
  };
  const finishRename = async (path: string) => {
    const value = renaming();
    const entry = entries().find((item) => item.path === value?.path);
    if (busy() && !switching) await operationDone;
    if (disposed) return undefined;
    if (!(await rename())) return undefined;
    if (value && entry && (path === value.path || path.startsWith(`${value.path}/`)))
      return pathWithName(entry, value.name) + path.slice(value.path.length);
    return path;
  };
  const create = (kind: Entry['kind']) =>
    void run(async () => {
      if (kind === 'file' && !(await ensureSaved())) return;
      const folder = selectedFolder();
      const base = kind === 'file' ? 'Untitled canvas' : 'Untitled folder';
      const extension = kind === 'file' ? '.excalidraw' : '';
      const occupied = new Set(entries().map((entry) => entry.path));
      let suffix = 0;
      while (!disposed) {
        const name = `${base}${suffix ? ` (${suffix})` : ''}`;
        const path = join(folder, `${name}${extension}`);
        if (occupied.has(path)) {
          suffix++;
          continue;
        }
        try {
          const document = await api.create(path, kind);
          if (kind === 'file') {
            await mount(document);
            recordNavigation(path);
          }
          await refresh();
          if (kind === 'folder') setRenaming({ path, name, error: '' });
          setAnnouncement(`Created ${name}.`);
          return;
        } catch (e) {
          // Another client may have claimed this name since the tree was read.
          if (!(e instanceof ApiError) || e.code !== 'exists') throw e;
          suffix++;
        }
      }
    });
  const submitPrompt = (event: SubmitEvent) => {
    event.preventDefault();
    const value = prompt();
    if (!value) return;
    void run(async () => {
      const { mode, path, folder } = value;
      const name = value.name.trim();
      if (!name && mode !== 'move') throw new Error('Enter a name.');
      if (mode !== 'move' && /[/\\]/.test(name))
        throw new Error('The name cannot contain slashes. Choose a folder from the list.');
      if (mode === 'copy') {
        editor?.flush();
        const current = session();
        if (!current) return;
        const document = await api.create(
          join(folder, name.endsWith('.excalidraw') ? name : `${name}.excalidraw`),
          'file',
          current.getScene(),
        );
        await current.discard();
        await mount(document);
        recordNavigation(document.path);
      } else {
        if (!(await ensureSaved())) {
          setPrompt(undefined);
          return;
        }
        if (path) {
          const entry = entries().find((e) => e.path === path);
          if (!entry) throw new Error('This file is no longer available.');
          await relocate(path, join(folder, basename(path)));
        }
      }
      await refresh();
      setPrompt(undefined);
    });
  };
  const deleteEntry = () =>
    void run(async () => {
      const entry = deleting();
      if (!entry || !(await ensureSaved())) {
        setDeleting(undefined);
        return;
      }
      await api.trash(entry.path);
      const active = session()?.document.path;
      if (active === entry.path || active?.startsWith(`${entry.path}/`)) {
        session()?.dispose();
        setSession(undefined);
        setDocumentPath('');
        saveSetting('last', '');
      }
      updatePaths(entry.path);
      setDeleting(undefined);
      await refresh();
    });
  const download = () => {
    editor?.flush();
    const current = session();
    if (!current) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(current.getScene(), null, 2)], {
        type: 'application/vnd.excalidraw+json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = basename(current.document.path);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const onImport = (files: FileList | null) => {
    if (!files?.length) return;
    const imported = Array.from(files);
    void run(async () => {
      if (!(await ensureSaved())) return;
      const { importScene } = await import('../editor/ExcalidrawAdapter');
      let last: Document | undefined;
      for (const file of imported) {
        if (file.size > 40 * 1024 * 1024) throw new Error('The file exceeds 40 MB.');
        const scene = await importScene(file);
        const original = file.name.replace(/\.excalidraw$|\.json$/g, '');
        let suffix = 0;
        while (true) {
          try {
            last = await api.create(
              join(selectedFolder(), `${original}${suffix ? ` (${suffix})` : ''}.excalidraw`),
              'file',
              scene,
            );
            break;
          } catch (e) {
            if (e instanceof Error && 'code' in e && e.code === 'exists') {
              suffix++;
              continue;
            }
            throw e;
          }
        }
      }
      await refresh();
      if (last) {
        await mount(last);
        recordNavigation(last.path);
      }
    });
    if (importInput) importInput.value = '';
  };
  const showHistory = () =>
    void run(async () => {
      if (await ensureSaved()) setHistory(await api.history(session()!.document.path));
    });
  const restoreHistory = (revision: string) =>
    void run(async () => {
      if (!(await ensureSaved())) return;
      const path = session()!.document.path;
      const scene = await api.historical(path, revision);
      const restored = await api.create(
        join(parent(path), `${title(path)} (restored ${Date.now()}).excalidraw`),
        'file',
        scene,
      );
      await refresh();
      await mount(restored);
      recordNavigation(restored.path);
      setHistory(undefined);
    });
  const restoreTrash = (id: string) =>
    void run(async () => {
      await api.restore(id);
      setTrash(await api.listTrash());
      await refresh();
    });
  const reload = () =>
    void run(async () => {
      const current = session();
      if (!current) return;
      const remote = await api.read(current.document.path);
      await current.discard();
      await mount(remote);
      setReloadConfirm(false);
    });

  onMount(() => {
    void run(async () => {
      const tree = await refresh();
      const last = readSetting('last');
      if (last && !tree.some((entry) => entry.path === last)) {
        const draft = await drafts.read(last).catch(() => undefined);
        if (draft) {
          await mount(
            { path: last, revision: draft.revision, scene: draft.scene },
            undefined,
            true,
          );
          recordNavigation(last);
          return;
        }
      }
      const first =
        tree.find((e) => e.kind === 'file' && e.path === last) ??
        tree.find((e) => e.kind === 'file');
      if (first) {
        await mount(await api.read(first.path));
        recordNavigation(first.path);
      }
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
    connect();
    document.addEventListener('visibilitychange', connect);
    window.addEventListener('focus', scheduleCheck);
    window.addEventListener('online', connect);
    window.addEventListener('beforeunload', beforeUnload);
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
    });
  });
  return {
    entries,
    session,
    documentPath,
    state,
    loaded,
    busy,
    error,
    setError,
    selectedFolder,
    setSelectedFolder,
    prompt,
    setPrompt,
    renaming,
    setRenaming,
    startRename,
    cancelRename,
    rename,
    finishRename,
    create,
    announcement,
    deleting,
    setDeleting,
    trash,
    setTrash,
    history,
    setHistory,
    reloadConfirm,
    setReloadConfirm,
    switchTarget,
    navigation,
    folders: createMemo(() => entries().filter((e) => e.kind === 'folder')),
    open,
    navigate,
    ask,
    submitPrompt,
    deleteEntry,
    download,
    onImport,
    showHistory,
    restoreHistory,
    restoreTrash,
    reload,
    showTrash: () =>
      void run(async () => {
        setTrash(await api.listTrash());
      }),
    refresh: () =>
      void run(async () => {
        await refresh();
      }),
    setEditor: (handle: EditorHandle | undefined) => {
      editor = handle;
    },
    setEditorPending,
    setImportInput: (input: HTMLInputElement) => {
      importInput = input;
    },
    importFiles: () => importInput?.click(),
  };
}
