import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  FolderOpen,
  History,
  LayoutPanelLeft,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Shapes,
  Trash2,
  Undo2,
  X,
  TriangleAlert,
} from 'lucide-react';
import type { Document, Entry, HistoryEntry, Scene, TrashEntry } from '../../shared/model';
import { api } from './api';
import { drafts } from './drafts';
import { DocumentSession, type SaveState } from './session';
import { ExcalidrawAdapter, importScene } from '../editor/ExcalidrawAdapter';

const basename = (path: string) => path.split('/').at(-1)!;
const title = (path: string) => basename(path).replace(/\.excalidraw$/, '');
const parent = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const displayDate = (value: string) =>
  new Date(value).toLocaleString('en', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
const safeRead = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage may be disabled. */
  }
};
const emptyState: SaveState = { status: 'saved', dirty: false, message: '', localError: false };

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className="dialog"
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

type Prompt = {
  mode: 'file' | 'folder' | 'rename' | 'move' | 'copy';
  path?: string;
  name: string;
  folder: string;
};

export function Workspace() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [session, setSession] = useState<DocumentSession>();
  const sessionRef = useRef<DocumentSession>();
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(true);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedFolder, setSelectedFolder] = useState('');
  const [prompt, setPrompt] = useState<Prompt>();
  const [deleting, setDeleting] = useState<Entry>();
  const [trash, setTrash] = useState<TrashEntry[]>();
  const [history, setHistory] = useState<HistoryEntry[]>();
  const [menu, setMenu] = useState<string>();
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const state = useSyncExternalStore(
    session?.subscribe ?? (() => () => {}),
    session?.snapshot ?? (() => emptyState),
  );
  const folders = entries.filter((e) => e.kind === 'folder');

  const refresh = useCallback(async () => {
    const tree = await api.entries();
    setEntries(tree);
    return tree;
  }, []);
  const mount = useCallback(
    async (document: Document, expected?: DocumentSession, missing = false) => {
      let draft;
      try {
        draft = await drafts.read(document.path);
      } catch {
        /* Server editing still works without IndexedDB. */
      }
      if (
        expected &&
        (sessionRef.current !== expected || expected.snapshot().dirty || busyRef.current)
      )
        return;
      const next = new DocumentSession(document, api, drafts, draft);
      if (missing) next.preserveMissing();
      sessionRef.current?.dispose();
      sessionRef.current = next;
      setSession(next);
      setGeneration((n) => n + 1);
      remember('excalidraws:last', document.path);
      setMobileOpen(false);
    },
    [],
  );

  const run = useCallback(async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The operation could not be completed.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run(async () => {
      const tree = await refresh();
      const last = safeRead('excalidraws:last');
      if (last && !tree.some((entry) => entry.path === last)) {
        const draft = await drafts.read(last).catch(() => undefined);
        if (draft) {
          await mount(
            { path: last, revision: draft.revision, scene: draft.scene },
            undefined,
            true,
          );
          return;
        }
      }
      const first =
        tree.find((e) => e.kind === 'file' && e.path === last) ??
        tree.find((e) => e.kind === 'file');
      if (first) await mount(await api.read(first.path));
    }).finally(() => setLoaded(true));
    return () => {
      sessionRef.current?.dispose();
    };
  }, [mount, refresh, run]);

  useEffect(() => {
    let checking = false;
    const check = async () => {
      if (checking || busyRef.current || document.visibilityState === 'hidden') return;
      checking = true;
      const current = sessionRef.current;
      try {
        const changed = await current?.checkExternal();
        if (
          changed &&
          current === sessionRef.current &&
          !busyRef.current &&
          !current?.snapshot().dirty
        )
          await mount(changed, current);
        await refresh();
      } catch {
        /* An offline server must not clear the tree or editor. */
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => {
      void check();
    }, 2500);
    window.addEventListener('online', check);
    window.addEventListener('focus', check);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (sessionRef.current?.snapshot().dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [mount, refresh]);

  const ensureSaved = async () => !sessionRef.current || (await sessionRef.current.flush());
  const open = (path: string) => {
    if (path === sessionRef.current?.document.path) {
      setMobileOpen(false);
      return;
    }
    void run(async () => {
      if (!(await ensureSaved())) return;
      await mount(await api.read(path));
    });
  };
  const ask = (mode: Prompt['mode'], path?: string) => {
    setMenu(undefined);
    setPrompt({
      mode,
      path,
      name:
        mode === 'rename' && path
          ? title(path)
          : mode === 'copy' && session
            ? `${title(session.document.path)} (copy)`
            : '',
      folder: path ? parent(path) : selectedFolder,
    });
  };
  const submitPrompt = (event: FormEvent) => {
    event.preventDefault();
    if (!prompt) return;
    void run(async () => {
      const { mode, path, folder } = prompt;
      const name = prompt.name.trim();
      if (!name && mode !== 'move') throw new Error('Enter a name.');
      if (mode !== 'move' && /[/\\]/.test(name))
        throw new Error('The name cannot contain slashes. Choose a folder from the list.');
      if (mode === 'copy') {
        const current = sessionRef.current;
        if (!current) return;
        const document = await api.create(
          join(folder, name.endsWith('.excalidraw') ? name : `${name}.excalidraw`),
          'file',
          current.getScene(),
        );
        await current.discard();
        await mount(document);
      } else {
        if (!(await ensureSaved())) {
          setPrompt(undefined);
          return;
        }
        if (mode === 'file' || mode === 'folder') {
          const relative = join(
            folder,
            mode === 'file' && !name.endsWith('.excalidraw') ? `${name}.excalidraw` : name,
          );
          const result = await api.create(relative, mode === 'file' ? 'file' : 'folder');
          if (mode === 'file') await mount(result);
          else {
            setSelectedFolder(relative);
            setCollapsed((value) => new Set([...value].filter((p) => p !== folder)));
          }
        } else if (path) {
          const entry = entries.find((e) => e.path === path)!;
          const target =
            mode === 'move'
              ? join(folder, basename(path))
              : join(
                  parent(path),
                  entry.kind === 'file' && !name.endsWith('.excalidraw')
                    ? `${name}.excalidraw`
                    : name,
                );
          if (path !== target) {
            await api.move(path, target);
            const current = sessionRef.current?.document.path;
            if (current === path || current?.startsWith(`${path}/`)) {
              await mount(await api.read(target + current.slice(path.length)));
            }
            if (selectedFolder === path || selectedFolder.startsWith(`${path}/`))
              setSelectedFolder(target + selectedFolder.slice(path.length));
          }
        }
      }
      await refresh();
      setPrompt(undefined);
    });
  };
  const deleteEntry = () =>
    void run(async () => {
      if (!deleting || !(await ensureSaved())) {
        setDeleting(undefined);
        return;
      }
      await api.trash(deleting.path);
      const active = sessionRef.current?.document.path;
      if (active === deleting.path || active?.startsWith(`${deleting.path}/`)) {
        sessionRef.current?.dispose();
        sessionRef.current = undefined;
        setSession(undefined);
        remember('excalidraws:last', '');
      }
      if (selectedFolder === deleting.path || selectedFolder.startsWith(`${deleting.path}/`))
        setSelectedFolder('');
      setDeleting(undefined);
      await refresh();
    });
  const download = () => {
    if (!session) return;
    const blob = new Blob([JSON.stringify(session.getScene(), null, 2)], {
      type: 'application/vnd.excalidraw+json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = basename(session.document.path);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const onImport = (files: FileList | null) => {
    if (!files?.length) return;
    // FileList is live: clearing the input before an awaited save empties it.
    const importedFiles = Array.from(files);
    void run(async () => {
      if (!(await ensureSaved())) return;
      let last: Document | undefined;
      for (const file of importedFiles) {
        if (file.size > 40 * 1024 * 1024) throw new Error('The file exceeds 40 MB.');
        const scene = await importScene(file);
        const original = file.name.replace(/\.excalidraw$|\.json$/g, '');
        let suffix = 0;
        while (true) {
          const path = join(
            selectedFolder,
            `${original}${suffix ? ` (${suffix})` : ''}.excalidraw`,
          );
          try {
            last = await api.create(path, 'file', scene);
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
      if (last) await mount(last);
    });
    if (importRef.current) importRef.current.value = '';
  };
  const reload = () =>
    void run(async () => {
      if (!sessionRef.current) return;
      const current = sessionRef.current;
      const remote = await api.read(current.document.path);
      await current.discard();
      await mount(remote);
      setReloadConfirm(false);
    });

  const renderTree = (folder: string, depth = 0): ReactNode =>
    entries
      .filter((e) => parent(e.path) === folder)
      .map((entry) => {
        const isFolder = entry.kind === 'folder';
        const matches =
          !search ||
          entry.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()) ||
          (isFolder &&
            entries.some(
              (e) =>
                e.path.startsWith(`${entry.path}/`) &&
                e.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
            ));
        if (!matches) return null;
        const expanded = !!search || !collapsed.has(entry.path);
        const active = isFolder
          ? selectedFolder === entry.path
          : session?.document.path === entry.path;
        return (
          <div key={entry.path}>
            <div
              className={`tree-row ${active ? 'active' : ''}`}
              style={{ paddingLeft: 12 + depth * 15 }}
            >
              <button
                className="tree-select"
                aria-current={!isFolder && active ? 'page' : undefined}
                aria-expanded={isFolder ? expanded : undefined}
                title={entry.path}
                onClick={() => {
                  if (isFolder) {
                    setSelectedFolder(entry.path);
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(entry.path)) next.delete(entry.path);
                      else next.add(entry.path);
                      return next;
                    });
                  } else {
                    setSelectedFolder(parent(entry.path));
                    open(entry.path);
                  }
                }}
              >
                {isFolder ? (
                  <>
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
                  </>
                ) : (
                  <FileText size={16} className="file-icon" />
                )}
                <span>{isFolder ? basename(entry.path) : title(entry.path)}</span>
                {!isFolder && active && state.dirty && (
                  <span className="dirty-dot" aria-label="Unsaved changes" />
                )}
              </button>
              <button
                className="row-menu icon-button"
                aria-label={`Actions for ${title(entry.path)}`}
                aria-expanded={menu === entry.path}
                onClick={() => setMenu(menu === entry.path ? undefined : entry.path)}
              >
                <MoreHorizontal size={16} />
              </button>
            </div>
            {menu === entry.path && (
              <div className="entry-actions">
                <span className="entry-action-name">{title(entry.path)}</span>
                <button onClick={() => ask('rename', entry.path)}>
                  <Pencil size={14} />
                  Rename
                </button>
                <button onClick={() => ask('move', entry.path)}>
                  <ArrowRight size={14} />
                  Move to…
                </button>
                <button
                  className="danger-text"
                  onClick={() => {
                    setDeleting(entry);
                    setMenu(undefined);
                  }}
                >
                  <Trash2 size={14} />
                  Move to trash
                </button>
              </div>
            )}
            {isFolder && expanded && renderTree(entry.path, depth + 1)}
          </div>
        );
      });

  const statusLabels = {
    saved: 'Saved',
    pending: 'Pending changes',
    saving: 'Saving…',
    offline: 'Not saved',
    conflict: 'Conflict',
  };
  return (
    <div className="workspace">
      <input
        ref={importRef}
        type="file"
        accept=".excalidraw,.json"
        multiple
        hidden
        onChange={(event) => onImport(event.target.files)}
        aria-label="Import files"
      />
      {mobileOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close explorer"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`} aria-label="Canvas explorer">
        <div className="brand">
          <span className="brand-icon">
            <Shapes size={23} strokeWidth={1.6} />
          </span>
          <span>
            excalidraws<span className="brand-caption">A SPACE FOR YOUR IDEAS</span>
          </span>
          <button
            className="icon-button mobile-only"
            aria-label="Close sidebar"
            onClick={() => setMobileOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button className="primary new-canvas" onClick={() => ask('file')} disabled={busy}>
          <Plus size={18} />
          New canvas<span>↵</span>
        </button>
        <div className="search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search canvases…"
            aria-label="Search canvases"
          />
          {search && (
            <button className="icon-button" aria-label="Clear search" onClick={() => setSearch('')}>
              <X size={13} />
            </button>
          )}
        </div>
        <div className="tree-heading">
          <button
            className={selectedFolder === '' ? 'root-selected' : ''}
            onClick={() => setSelectedFolder('')}
          >
            MY CANVASES
          </button>
          <div>
            <button
              className="icon-button"
              aria-label="New folder"
              title="New folder"
              onClick={() => ask('folder')}
              disabled={busy}
            >
              <FolderPlus size={16} />
            </button>
            <button
              className="icon-button"
              aria-label="Import canvases"
              title="Import .excalidraw"
              onClick={() => importRef.current?.click()}
              disabled={busy}
            >
              <ArrowUpFromLine size={16} />
            </button>
          </div>
        </div>
        <nav className="file-tree" aria-label="Files">
          {renderTree('')}
          {loaded && !entries.length && (
            <p className="tree-empty">
              Your ideas will live here.
              <br />
              Create your first canvas to get started.
            </p>
          )}
          {search &&
            !entries.some((e) =>
              e.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
            ) && <p className="tree-empty">No canvases match that name.</p>}
        </nav>
        {selectedFolder && (
          <div className="destination" title={selectedFolder}>
            <FolderOpen size={13} />
            Create in {basename(selectedFolder)}
            <button
              className="icon-button"
              aria-label="Create in root"
              onClick={() => setSelectedFolder('')}
            >
              <X size={12} />
            </button>
          </div>
        )}
        <div className="sidebar-bottom">
          <button onClick={() => void run(async () => setTrash(await api.listTrash()))}>
            <Trash2 size={16} />
            Trash
          </button>
          <div className="vault-note">
            <span className="connection-dot" />
            Files on your server<span>.excalidraw</span>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <button
            className="icon-button mobile-only"
            aria-label="Open explorer"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <LayoutPanelLeft size={16} />
            <span className="breadcrumb-parent">
              {session ? parent(session.document.path) || 'My canvases' : 'My canvases'}
            </span>
            {session && (
              <>
                <ChevronRight size={13} />
                <h1>{title(session.document.path)}</h1>
              </>
            )}
          </div>
          {session && (
            <div className="document-tools">
              <span
                className={`save-status ${state.status}`}
                role="status"
                title={state.message || 'Saved to the server'}
              >
                {state.status === 'saved' ? (
                  <Check size={14} />
                ) : state.status === 'saving' ? (
                  <LoaderCircle size={14} className="spin" />
                ) : state.status === 'conflict' || state.status === 'offline' ? (
                  <TriangleAlert size={14} />
                ) : (
                  <Circle size={9} />
                )}
                <span>{statusLabels[state.status]}</span>
              </span>
              <span className="tool-separator" />
              <button
                className="icon-button"
                title="Version history"
                aria-label="Version history"
                onClick={() =>
                  void run(async () => {
                    if (await ensureSaved()) setHistory(await api.history(session.document.path));
                  })
                }
              >
                <History size={17} />
              </button>
              <button
                className="icon-button"
                title="Download .excalidraw"
                aria-label="Download canvas"
                onClick={download}
              >
                <ArrowDownToLine size={17} />
              </button>
              <button
                className="icon-button"
                title="Rename canvas"
                aria-label="Rename canvas"
                onClick={() => ask('rename', session.document.path)}
              >
                <Pencil size={16} />
              </button>
            </div>
          )}
        </header>
        {error && (
          <div className="notice error" role="alert">
            <TriangleAlert size={18} />
            <span>{error}</span>
            <button
              className="text-button"
              onClick={() => {
                setError('');
                if (!session && !entries.length)
                  void run(async () => {
                    await refresh();
                  });
              }}
            >
              Retry
            </button>
            <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {state.localError && (
          <div className="notice warning" role="alert">
            Your browser cannot save a local draft. Keep this page open until the status shows
            “Saved”.
          </div>
        )}
        {session && (state.status === 'conflict' || state.status === 'offline') && (
          <div className="notice warning" role="alert">
            <TriangleAlert size={18} />
            <span>{state.message}</span>
            {state.status === 'offline' ? (
              <button onClick={() => void session.flush()}>Retry saving</button>
            ) : (
              <button onClick={() => setReloadConfirm(true)}>Load from server</button>
            )}
            <button onClick={() => ask('copy')}>Save a copy</button>
            <button className="text-button" onClick={download}>
              Download
            </button>
          </div>
        )}
        <div className={`editor-area ${busy ? 'is-busy' : ''}`}>
          {session ? (
            <ExcalidrawAdapter
              key={`${session.document.path}:${generation}`}
              scene={session.initialScene}
              onChange={session.change}
              onImport={() => importRef.current?.click()}
              disabled={busy}
            />
          ) : (
            <div className="welcome">
              <div className="welcome-art">
                <Shapes size={62} strokeWidth={1.1} />
                <span className="art-dot" />
                <span className="art-line" />
              </div>
              <span className="eyebrow">MAKE ROOM FOR YOUR IDEAS</span>
              <h1>It all starts with a line.</h1>
              <p>
                A place to draw, connect ideas, and think out loud.
                <br />
                Every canvas, a file. Always within reach.
              </p>
              <button className="primary" onClick={() => ask('file')} disabled={busy}>
                <FilePlus2 size={18} />
                Create my first canvas
              </button>
              <button
                className="text-button import-welcome"
                onClick={() => importRef.current?.click()}
                disabled={busy}
              >
                Or import an .excalidraw file <ArrowRight size={14} />
              </button>
              <div className="welcome-features">
                <span>
                  <Check size={14} />
                  Automatic saving
                </span>
                <span>
                  <Folder size={14} />
                  Your files, on your server
                </span>
              </div>
            </div>
          )}
          {busy && (
            <div className="busy-overlay" aria-label="Processing">
              <LoaderCircle size={24} className="spin" />
            </div>
          )}
        </div>
      </main>

      {prompt && (
        <Modal
          title={
            {
              file: 'New canvas',
              folder: 'New folder',
              rename: 'Rename',
              move: 'Move to another folder',
              copy: 'Save a copy',
            }[prompt.mode]
          }
          onClose={() => {
            if (!busy) setPrompt(undefined);
          }}
        >
          <form onSubmit={submitPrompt}>
            {prompt.mode !== 'move' && (
              <label>
                Name
                <input
                  autoFocus
                  required
                  maxLength={160}
                  value={prompt.name}
                  placeholder={
                    prompt.mode === 'folder' ? 'For example, Projects' : 'For example, A new idea'
                  }
                  onChange={(e) => setPrompt({ ...prompt, name: e.target.value })}
                />
              </label>
            )}
            {prompt.mode !== 'rename' && (
              <label>
                Folder
                <select
                  autoFocus={prompt.mode === 'move'}
                  value={prompt.folder}
                  onChange={(e) => setPrompt({ ...prompt, folder: e.target.value })}
                >
                  <option value="">My canvases /</option>
                  {folders
                    .filter(
                      (e) =>
                        prompt.mode !== 'move' ||
                        (e.path !== prompt.path && !e.path.startsWith(`${prompt.path}/`)),
                    )
                    .map((e) => (
                      <option key={e.path} value={e.path}>
                        {e.path}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {prompt.mode === 'copy' && (
              <p className="dialog-help">
                Your current drawing will be saved as a new file. The server file will keep its
                current version.
              </p>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" onClick={() => setPrompt(undefined)} disabled={busy}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy || (prompt.mode !== 'move' && !prompt.name.trim())}
              >
                {prompt.mode === 'move'
                  ? 'Move'
                  : prompt.mode === 'rename'
                    ? 'Rename'
                    : prompt.mode === 'copy'
                      ? 'Save copy'
                      : 'Create'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal title="Move to trash" onClose={() => setDeleting(undefined)}>
          <p>
            «{title(deleting.path)}»
            {deleting.kind === 'folder' ? ' and its contents will be moved' : ' will be moved'} to
            the trash. You can restore it later.
          </p>
          <div className="dialog-actions">
            <button onClick={() => setDeleting(undefined)}>Cancel</button>
            <button className="danger-button" disabled={busy} onClick={deleteEntry}>
              Move to trash
            </button>
          </div>
        </Modal>
      )}
      {trash && (
        <Modal title="Trash" onClose={() => setTrash(undefined)}>
          <p className="dialog-help">
            Files stay here until you restore them. They are not deleted automatically.
          </p>
          <div className="version-list">
            {!trash.length && <p>The trash is empty.</p>}
            {trash.map((item) => (
              <div className="version-row" key={item.id}>
                <div>
                  <strong>{item.path}</strong>
                  <small>{displayDate(item.deleted)}</small>
                </div>
                <button
                  aria-label={`Restore ${title(item.path)}`}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.restore(item.id);
                      setTrash(await api.listTrash());
                      await refresh();
                    })
                  }
                >
                  <Undo2 size={15} />
                  Restore
                </button>
              </div>
            ))}
          </div>
          {error && <p className="form-error">{error}</p>}
        </Modal>
      )}
      {history && session && (
        <Modal title="Version history" onClose={() => setHistory(undefined)}>
          <p className="dialog-help">
            The last 20 previous versions of this file. Restoring a version creates a new canvas.
          </p>
          <div className="version-list">
            {!history.length && <p>There are no previous versions yet.</p>}
            {history.map((item) => (
              <div className="version-row" key={item.revision}>
                <Clock3 size={17} />
                <div>
                  <strong>{displayDate(item.modified)}</strong>
                  <small>{item.revision.slice(0, 10)}</small>
                </div>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (!(await ensureSaved())) return;
                      const scene = await api.historical(session.document.path, item.revision);
                      const name = join(
                        parent(session.document.path),
                        `${title(session.document.path)} (restored ${Date.now()}).excalidraw`,
                      );
                      const doc = await api.create(name, 'file', scene);
                      await refresh();
                      await mount(doc);
                      setHistory(undefined);
                    })
                  }
                >
                  Restore a copy
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {reloadConfirm && (
        <Modal title="Load the server version" onClose={() => setReloadConfirm(false)}>
          <p>
            This replaces the open drawing with the current server file. Save a copy or download
            your drawing first to keep your local changes.
          </p>
          <div className="dialog-actions">
            <button
              onClick={() => {
                setReloadConfirm(false);
                ask('copy');
              }}
            >
              Save a copy first
            </button>
            <button className="danger-button" onClick={reload} disabled={busy}>
              Load from server
            </button>
          </div>
          {error && <p className="form-error">{error}</p>}
        </Modal>
      )}
    </div>
  );
}
