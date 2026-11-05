import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from 'solid-js';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  CornerLeftUp,
  Ellipsis,
  FilePlus2,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  History,
  Library,
  ListChecks,
  LocateFixed,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Star,
  StarOff,
  Trash2,
  Undo2,
  X,
} from 'lucide-solid';
import type { TrashEntry } from '../../shared/model';
import { EditorSurface } from '../editor/EditorSurface';
import { CanvasTree, type DropTarget, type TreeApi } from './CanvasTree';
import { createWorkspace } from './controller';
import { InlineName } from './InlineName';
import { MovePicker } from './MovePicker';
import { Popover, type DismissReason } from './Popover';
import { createTheme, themeOptions } from './theme';
import {
  ancestors,
  buildRows,
  displayName,
  folderLabel,
  insertRelative,
  isInside,
  parentOf,
  pathTitle,
  readSetting,
  renamedPath,
  saveSetting,
  siblingOrder,
  topLevel,
  type LibraryEntry,
  type Row,
  type SortMode,
  type View,
} from './tree';

// The explorer becomes an overlay below 1024 px wide or 500 px high (phone landscape).
const DRAWER_QUERY = '(max-width: 1023px), (max-height: 499px)';
const COARSE_QUERY = '(pointer: coarse)';
const FINE_QUERY = '(pointer: fine)';
const SLOW_BUSY_MS = 400;

const statusLabels = {
  saved: 'Saved',
  pending: 'Saving…',
  saving: 'Saving…',
  offline: 'Not saved',
  conflict: 'Conflict',
} as const;
const sortOptions: { value: SortMode; label: string }[] = [
  { value: 'recent', label: 'Recent changes' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'custom', label: 'Custom order' },
];
const views: { id: View; label: string; icon: () => JSX.Element }[] = [
  { id: 'library', label: 'Library', icon: () => <Library size={18} aria-hidden="true" /> },
  { id: 'favorites', label: 'Favorites', icon: () => <Star size={18} aria-hidden="true" /> },
  { id: 'archive', label: 'Archive', icon: () => <Archive size={18} aria-hidden="true" /> },
  { id: 'trash', label: 'Trash', icon: () => <Trash2 size={18} aria-hidden="true" /> },
];
const dateTime = (value: string) =>
  new Date(value).toLocaleString('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const readCollapsed = () => {
  try {
    const value = JSON.parse(readSetting('collapsed') ?? '[]');
    return new Set<string>(Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set<string>();
  }
};
const readSort = (): SortMode => {
  const value = readSetting('sort');
  return value === 'name' || value === 'custom' ? value : 'recent';
};
const media = (query: string) => {
  const list = window.matchMedia(query);
  const [matches, setMatches] = createSignal(list.matches);
  const change = () => setMatches(list.matches);
  list.addEventListener('change', change);
  onCleanup(() => list.removeEventListener('change', change));
  return matches;
};

type Point = { x: number; y: number };
type Layer = 'sidebar' | 'topbar';
type Pop = { anchor: HTMLElement; point?: Point; layer: Layer; restore(): void } & (
  | { kind: 'row'; path: string }
  | { kind: 'create'; folder: string }
  | { kind: 'sort' }
  | { kind: 'settings' }
  | { kind: 'move'; paths: string[] }
  | { kind: 'document' }
  | { kind: 'history' }
);

function MenuItem(props: {
  icon?: JSX.Element;
  label: string;
  shortcut?: string;
  keys?: string;
  danger?: boolean;
  disabled?: boolean;
  radio?: boolean;
  checked?: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      class="menu-item"
      classList={{ danger: props.danger }}
      role={props.radio ? 'menuitemradio' : 'menuitem'}
      aria-checked={props.radio ? !!props.checked : undefined}
      aria-keyshortcuts={props.keys}
      disabled={props.disabled}
      data-name-transition
      onClick={() => props.onSelect()}
    >
      <span class="menu-icon" aria-hidden="true">
        {props.radio ? props.checked ? <Check size={15} /> : null : props.icon}
      </span>
      <span class="menu-label">{props.label}</span>
      <Show when={props.shortcut}>
        <kbd class="menu-shortcut" aria-hidden="true">
          {props.shortcut}
        </kbd>
      </Show>
    </button>
  );
}

export function Workspace() {
  const theme = createTheme();
  const w = createWorkspace();
  const drawerMode = media(DRAWER_QUERY);
  const coarse = media(COARSE_QUERY);
  const fine = media(FINE_QUERY);
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  // The desktop collapse preference is independent from the overlay drawer.
  const [collapsedPref, setCollapsedPref] = createSignal(
    readSetting('sidebar-collapsed') === 'true',
  );
  const [view, setView] = createSignal<View>('library');
  const [query, setQuery] = createSignal('');
  const [sort, setSort] = createSignal<SortMode>(readSort());
  const [collapsed, setCollapsed] = createSignal(readCollapsed());
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [selectMode, setSelectMode] = createSignal(false);
  const [focusPath, setFocusPath] = createSignal<string>();
  const [pop, setPop] = createSignal<Pop>();
  const [renameLocation, setRenameLocation] = createSignal<Layer>('topbar');
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [slowBusy, setSlowBusy] = createSignal(false);
  let anchorPath: string | undefined;
  let tree: TreeApi | undefined;
  let sidebar!: HTMLElement;
  let searchInput!: HTMLInputElement;
  let closeButton!: HTMLButtonElement;
  let toggleButton: HTMLButtonElement | undefined;
  let titleButton: HTMLButtonElement | undefined;
  let loadButton: HTMLButtonElement | undefined;

  const sidebarVisible = () => (drawerMode() ? drawerOpen() : !collapsedPref());
  const activePath = w.documentPath;
  const entries = () => w.entries() as LibraryEntry[];
  const entryMap = createMemo(() => new Map(entries().map((entry) => [entry.path, entry])));
  const activeEntry = createMemo(() => entryMap().get(activePath()));
  const searching = () => !!query().trim();
  const rowHeight = () => (coarse() ? 44 : 32);
  const rows = createMemo(() =>
    buildRows({
      entries: entries(),
      view: view(),
      sort: sort(),
      collapsed: collapsed(),
      query: query(),
    }),
  );
  const selecting = () => selectMode() || selected().size > 0;
  const activeName = () =>
    w.renaming()?.path === activePath() ? w.renaming()!.name : pathTitle(activePath());
  const editingActiveIn = (location: Layer) =>
    w.renaming()?.path === activePath() && renameLocation() === location;
  const treeRenamingPath = () => {
    const value = w.renaming();
    if (!value) return undefined;
    return value.path !== activePath() || renameLocation() === 'sidebar' ? value.path : undefined;
  };
  const showTrashList = () => view() === 'trash' && !searching();

  createEffect(() => saveSetting('sidebar-collapsed', String(collapsedPref())));
  createEffect(() => saveSetting('sort', sort()));
  createEffect(() => saveSetting('collapsed', JSON.stringify([...collapsed()])));
  createEffect(() => {
    const path = activePath();
    document.title = path ? `${pathTitle(path)} · Excalidraws` : 'Excalidraws';
  });
  // Brief operations do not flash a progress label; document switches show one at once.
  createEffect(() => {
    if (!w.busy()) return setSlowBusy(false);
    const timer = setTimeout(() => setSlowBusy(true), SLOW_BUSY_MS);
    onCleanup(() => clearTimeout(timer));
  });
  // Selection follows the list: items that leave it (moved, trashed, filtered) drop out.
  createEffect(
    on(rows, (list) => {
      const current = selected();
      if (!current.size) return;
      const visible = new Set(list.map((row) => row.entry.path));
      if ([...current].every((path) => visible.has(path))) return;
      setSelected(new Set([...current].filter((path) => visible.has(path))));
    }),
  );
  // Keep the current canvas findable after it is opened elsewhere, moved or renamed.
  createEffect(
    on(
      activePath,
      (path) => {
        const entry = entryMap().get(path);
        if (!entry || entry.archived) return;
        expandTo(path);
        tree?.reveal(path);
      },
      { defer: true },
    ),
  );

  const messageOf = (e: unknown) =>
    e instanceof Error ? e.message : 'The operation could not be completed.';
  const attempt = async <T,>(work: () => Promise<T>) => {
    try {
      return await work();
    } catch (e) {
      w.setError(messageOf(e));
      return undefined;
    }
  };
  /** Commits an inline rename first; resolves to the (possibly renamed) path or undefined. */
  const commit = async (path = '') => (w.renaming() ? await w.finishRename(path) : path);
  /** Runs an explorer action after any inline rename has been committed successfully. */
  const committed = (action: () => unknown) =>
    void commit().then((path) => {
      if (path !== undefined) void action();
    });
  const focusInExplorer = () =>
    !!document.activeElement && sidebar.contains(document.activeElement);

  const expandTo = (path: string, self = false) => {
    const opened = new Set([...ancestors(path), ...(self ? [path] : [])]);
    if ([...opened].every((folder) => !collapsed().has(folder))) return;
    setCollapsed((previous) => new Set([...previous].filter((folder) => !opened.has(folder))));
  };
  const toggleFolder = (path: string, expanded: boolean) => {
    if (w.renaming() && w.renaming()!.path !== path) void w.rename();
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (expanded) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  /** Shows a path in the explorer: the right view, ancestors expanded, scrolled into view. */
  const reveal = (path: string, focus = false) => {
    const entry = entryMap().get(path);
    if (!entry) return;
    const inResults = searching() && rows().some((row) => row.entry.path === path);
    const current = view();
    const fits =
      (current === 'library' && !entry.archived) ||
      (current === 'archive' && entry.archived) ||
      (current === 'favorites' && !!entry.favorite && !entry.archived);
    batch(() => {
      if (!inResults) {
        if (searching()) setQuery('');
        if (!fits) setView(entry.archived ? 'archive' : 'library');
      }
      expandTo(path);
    });
    queueMicrotask(() => (focus ? tree?.focus(path) : tree?.reveal(path)));
  };

  const openExplorer = (focus: 'tree' | 'search' | 'none' = 'tree') => {
    // The drawer makes the main area inert; a document menu there could no longer be used.
    if (drawerMode() && pop()?.layer === 'topbar') setPop(undefined);
    if (drawerMode()) setDrawerOpen(true);
    else setCollapsedPref(false);
    queueMicrotask(() => {
      if (focus === 'search') searchInput.focus();
      else if (focus === 'tree') focusExplorerEntry();
    });
  };
  const focusExplorerEntry = () => {
    if (!showTrashList() && rows().length && tree) tree.focus();
    else closeButton?.focus();
  };
  const closeExplorer = () => {
    if (pop()?.layer === 'sidebar') setPop(undefined);
    if (drawerMode()) setDrawerOpen(false);
    else setCollapsedPref(true);
    queueMicrotask(() => toggleButton?.focus());
  };
  const focusSearch = () => openExplorer('search');

  const closePop = (restoreFocus: boolean) => {
    const current = pop();
    if (!current) return;
    setPop(undefined);
    if (current.kind === 'history') w.setHistory(undefined);
    if (restoreFocus) current.restore();
  };
  const dismissPop = (reason: DismissReason) => {
    const current = pop();
    const hadFocus = !!document.activeElement?.closest('.popover');
    closePop(reason === 'escape' || reason === 'tab');
    // A vanished anchor must not strand focus on the document body.
    if (reason === 'anchor' && hadFocus)
      queueMicrotask(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        if (current?.layer === 'sidebar') {
          const path = current.kind === 'row' ? current.path : focusPath();
          if (path && rows().some((row) => row.entry.path === path)) tree?.focus(path, false);
          else closeButton?.focus({ preventScroll: true });
        } else titleButton?.focus();
      });
  };
  const rowRestore = (path: string) => () => {
    if (entryMap().has(path) && rows().some((row) => row.entry.path === path)) tree?.focus(path);
    else focusExplorerEntry();
  };
  const elementRestore = (element: HTMLElement) => () => {
    if (element.isConnected) element.focus();
  };

  // Selection.
  const toggleSelected = (path: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    anchorPath = path;
  };
  const selectRange = (from: string, to: string) => {
    const order = rows().map((row) => row.entry.path);
    const start = order.indexOf(anchorPath ?? from);
    const end = order.indexOf(to);
    if (start < 0 || end < 0) return toggleSelected(to);
    anchorPath ??= from;
    setSelected(new Set(order.slice(Math.min(start, end), Math.max(start, end) + 1)));
  };
  const clearSelection = () => {
    if (!selecting()) return false;
    batch(() => {
      setSelected(new Set<string>());
      setSelectMode(false);
    });
    anchorPath = undefined;
    return true;
  };
  const targetsFor = (path: string) =>
    selected().has(path) && selected().size > 1 ? topLevel(selected()) : [path];

  // Explorer operations. The controller queues them; nothing here blocks drawing.
  const createIn = async (kind: 'file' | 'folder', folder: string) => {
    if ((await commit()) === undefined) return;
    closePop(false);
    batch(() => {
      if (folder) expandTo(folder, true);
      setQuery('');
      if (view() !== 'library') setView('library');
      setRenameLocation('sidebar');
    });
    const path = await attempt(() => w.create(kind, folder));
    if (!path) return;
    if (kind === 'folder') reveal(path);
    else {
      reveal(path);
      // A new canvas is an explicit choice of what to draw next.
      if (drawerMode() && drawerOpen()) closeExplorer();
    }
  };
  const neighbourAfter = (removed: string[]) => {
    const list = rows().map((row) => row.entry.path);
    const gone = (path: string) => removed.some((root) => isInside(path, root));
    let last = -1;
    list.forEach((path, index) => {
      if (gone(path)) last = index;
    });
    const first = list.findIndex(gone);
    return (
      list.slice(last + 1).find((path) => !gone(path)) ??
      list
        .slice(0, Math.max(0, first))
        .reverse()
        .find((path) => !gone(path))
    );
  };
  const afterRemoval = (removed: string[], hadFocus: boolean) => {
    const next = neighbourAfter(removed);
    return () => {
      if (!hadFocus) return;
      if (next && rows().some((row) => row.entry.path === next)) tree?.focus(next);
      else focusExplorerEntry();
    };
  };
  const trashItems = async (paths: string[], hadFocus = focusInExplorer()) => {
    const targets = topLevel(paths);
    if (!targets.length) return;
    const restore = afterRemoval(targets, hadFocus);
    const done = await attempt(() => w.trashEntries(targets));
    if (done !== undefined) clearSelection();
    restore();
  };
  const archiveItems = async (paths: string[], value: boolean, hadFocus = focusInExplorer()) => {
    const targets = topLevel(paths);
    const leaves = (value && view() === 'library') || (!value && view() === 'archive');
    const restore = leaves ? afterRemoval(targets, hadFocus) : undefined;
    const done = await attempt(() => w.setArchived(targets, value));
    if (done) clearSelection();
    if (restore) restore();
    else if (hadFocus && targets[0]) tree?.focus(targets[0]);
  };
  const favoriteItems = async (paths: string[], value: boolean, hadFocus = focusInExplorer()) => {
    const restore = !value && view() === 'favorites' ? afterRemoval(paths, hadFocus) : undefined;
    const done = await attempt(() => w.setFavorite(paths, value));
    if (done && selected().size) clearSelection();
    if (restore) restore();
  };
  const moveItems = async (
    paths: string[],
    folder: string,
    hadFocus = focusInExplorer(),
    placement?: { target: string; where: 'before' | 'after' },
  ) => {
    const moved = await attempt(() => w.move(topLevel(paths), folder, placement));
    if (!moved?.length) return moved;
    clearSelection();
    if (folder) expandTo(folder, true);
    const first = moved[0]!;
    if (hadFocus) reveal(first, true);
    else reveal(first);
    return moved;
  };
  const reorderRelative = async (paths: string[], target: string, where: 'before' | 'after') => {
    const folder = parentOf(target);
    const list = insertRelative(siblingOrder(entries(), folder), paths, target, where);
    if (!list) return false;
    return !!(await attempt(() => w.reorder(folder, list)));
  };
  const siblingsOf = (path: string) => {
    const row = rows().find((item) => item.entry.path === path);
    if (!row || row.flat) return [];
    return rows()
      .filter(
        (item) =>
          !item.flat && item.depth === row.depth && parentOf(item.entry.path) === parentOf(path),
      )
      .map((item) => item.entry.path);
  };
  const moveStep = async (path: string, delta: -1 | 1, hadFocus = focusInExplorer()) => {
    if (sort() !== 'custom') return;
    const siblings = siblingsOf(path);
    const neighbour = siblings[siblings.indexOf(path) + delta];
    if (!neighbour) return;
    await reorderRelative([path], neighbour, delta < 0 ? 'before' : 'after');
    if (hadFocus) tree?.focus(path);
  };
  const drop = async (paths: string[], target: DropTarget) => {
    const moving = topLevel(paths);
    if ((await commit()) === undefined) return;
    if (target.kind === 'into') return void (await moveItems(moving, target.folder));
    const folder = parentOf(target.path);
    if (moving.every((path) => parentOf(path) === folder))
      return void (await reorderRelative(moving, target.path, target.kind));
    // One drag is one operation, including its destination position and Undo.
    await moveItems(moving, folder, focusInExplorer(), {
      target: target.path,
      where: target.kind,
    });
  };
  const duplicateItem = async (path: string) => {
    const copy = await attempt(() => w.duplicate(path));
    if (copy) reveal(copy);
  };
  const openFile = (path: string) => {
    const fromDrawer = drawerMode() && drawerOpen();
    if (fromDrawer) closeExplorer();
    void attempt(() => w.open(path)).then((opened) => {
      if (opened && fromDrawer) titleButton?.focus();
    });
  };
  const activate = (row: Row) => {
    const path = row.entry.path;
    if (row.entry.kind === 'file') return openFile(path);
    if (row.flat) {
      // Search and Favorites are flat: a folder opens at its place in the hierarchy.
      batch(() => {
        setQuery('');
        setView(row.entry.archived ? 'archive' : 'library');
        expandTo(path, true);
      });
      queueMicrotask(() => tree?.focus(path));
      return;
    }
    toggleFolder(path, !row.expanded);
  };
  const rowClick = (row: Row, event: MouseEvent) => {
    const path = row.entry.path;
    if (w.renaming()?.path === path) return void w.rename();
    const from = anchorPath ?? focusPath() ?? activePath();
    const additive = event.ctrlKey || event.metaKey;
    void (async () => {
      const target = await commit(path);
      if (target === undefined) return;
      setFocusPath(target);
      if (event.shiftKey && from) return selectRange(from, target);
      if (additive || selecting()) return toggleSelected(target);
      const current = rows().find((item) => item.entry.path === target) ?? row;
      activate(current);
    })();
  };
  const startRename = async (path: string, location: Layer) => {
    if (w.renaming()?.path === path) {
      setRenameLocation(location);
      return;
    }
    const target = await commit(path);
    if (target === undefined) return;
    closePop(false);
    setRenameLocation(location);
    if (location === 'sidebar') reveal(target);
    w.startRename(target);
  };
  const restoreTrashItem = async (item: TrashEntry, button: HTMLElement) => {
    const list = button.closest('ul');
    const index = list
      ? [...list.querySelectorAll('button')].indexOf(button as HTMLButtonElement)
      : -1;
    const path = await attempt(() => w.restoreTrash(item.id));
    if (!path) return;
    queueMicrotask(() => {
      const buttons = sidebar.querySelectorAll<HTMLButtonElement>('.trash-list button');
      (
        buttons[Math.min(index, buttons.length - 1)] ??
        sidebar.querySelector<HTMLElement>('#view-tab-trash') ??
        closeButton
      ).focus();
    });
  };

  // Popover openers.
  const openRowMenu = async (path: string, anchor: HTMLElement, point?: Point) => {
    const current = pop();
    if (current?.kind === 'row' && current.path === path && !point) return closePop(true);
    const target = await commit(path);
    if (target === undefined) return;
    const element =
      target === path && anchor.isConnected
        ? anchor
        : sidebar.querySelector<HTMLElement>(`[data-entry-path="${CSS.escape(target)}"]`);
    if (!element) return;
    setFocusPath(target);
    setPop({
      kind: 'row',
      path: target,
      anchor: element,
      point,
      layer: 'sidebar',
      restore: rowRestore(target),
    });
  };
  const openCreateMenu = async (folder: string, anchor: HTMLElement) => {
    if (pop()?.kind === 'create') return closePop(true);
    const target = await commit(folder);
    if (target === undefined || !anchor.isConnected) return;
    setPop({
      kind: 'create',
      folder: target,
      anchor,
      layer: 'sidebar',
      restore: rowRestore(target),
    });
  };
  const openMove = (
    paths: string[],
    anchor: HTMLElement,
    layer: Layer,
    restore: () => void,
    point?: Point,
  ) => setPop({ kind: 'move', paths: topLevel(paths), anchor, point, layer, restore });
  const openSort = async (anchor: HTMLElement) => {
    if (pop()?.kind === 'sort') return closePop(true);
    if ((await commit()) === undefined) return;
    setPop({ kind: 'sort', anchor, layer: 'sidebar', restore: elementRestore(anchor) });
  };
  const openSettings = async (anchor: HTMLElement) => {
    if (pop()?.kind === 'settings') return closePop(true);
    if ((await commit()) === undefined) return;
    setPop({ kind: 'settings', anchor, layer: 'sidebar', restore: elementRestore(anchor) });
  };
  const openDocumentMenu = async (anchor: HTMLElement) => {
    if (pop()?.kind === 'document') return closePop(true);
    if ((await commit()) === undefined) return;
    setPop({ kind: 'document', anchor, layer: 'topbar', restore: elementRestore(anchor) });
  };
  const openHistory = async (anchor: HTMLElement) => {
    if (pop()?.kind === 'history') return closePop(true);
    if ((await commit()) === undefined) return;
    w.setHistory(undefined);
    setPop({ kind: 'history', anchor, layer: 'topbar', restore: elementRestore(anchor) });
    setHistoryLoading(true);
    await attempt(() => w.showHistory());
    setHistoryLoading(false);
  };
  const menuPath = () => {
    const current = pop();
    if (current?.kind === 'row') return current.path;
    if (current?.kind === 'move' && current.layer === 'sidebar') return current.paths[0];
    return undefined;
  };

  const renderRename = () => (
    <InlineName
      value={w.renaming()!}
      label={
        entryMap().get(w.renaming()?.path ?? '')?.kind === 'folder' ? 'Folder name' : 'Canvas name'
      }
      busy={w.pendingPaths().has(w.renaming()?.path ?? '')}
      onInput={(name) => w.setRenaming((value) => value && { ...value, name, error: '' })}
      onSave={async (restoreFocus) => {
        const previousFocus = document.activeElement;
        const value = w.renaming();
        const inTopbar = value?.path === activePath() && renameLocation() === 'topbar';
        const entry = value && entryMap().get(value.path);
        const saved = await w.rename();
        if (
          saved &&
          restoreFocus &&
          value &&
          !w.renaming() &&
          (document.activeElement === previousFocus || document.activeElement === document.body)
        ) {
          if (inTopbar) queueMicrotask(() => titleButton?.focus());
          else if (entry) tree?.focus(renamedPath(entry, value.name));
        }
        return saved;
      }}
      onCancel={() => {
        const value = w.renaming();
        const inTopbar = value?.path === activePath() && renameLocation() === 'topbar';
        w.cancelRename();
        if (inTopbar) queueMicrotask(() => titleButton?.focus());
        else if (value) tree?.focus(value.path);
      }}
    />
  );

  // Popover contents.
  const RowMenu = (props: { path: string }) => {
    const entry = () => entryMap().get(props.path);
    const targets = () => targetsFor(props.path);
    const multiple = () => targets().length > 1;
    const items = () =>
      targets()
        .map((path) => entryMap().get(path))
        .filter((e): e is LibraryEntry => !!e);
    const sharedParent = () => {
      const parents = new Set(targets().map(parentOf));
      return parents.size === 1 ? [...parents][0]! : undefined;
    };
    const allFavorite = () => items().every((item) => item.favorite);
    const allArchived = () => items().every((item) => item.archived);
    const custom = () => sort() === 'custom' && view() === 'library' && !searching();
    const siblings = () => siblingsOf(props.path);
    const position = () => siblings().indexOf(props.path);
    // Whether focus was in the explorer is read before the menu closes and takes it along.
    const run = (action: (hadFocus: boolean) => unknown, restoreFocus = true) => {
      const hadFocus = focusInExplorer();
      closePop(restoreFocus);
      void action(hadFocus);
    };
    const restore = rowRestore(props.path);
    return (
      <Show when={entry()}>
        {(item) => (
          <>
            <p class="popover-title" title={props.path}>
              {multiple() ? `${targets().length} selected` : displayName(item())}
            </p>
            <Show when={!multiple()}>
              <MenuItem
                icon={<Pencil size={15} />}
                label="Rename"
                shortcut="F2"
                keys="F2"
                onSelect={() => void startRename(props.path, 'sidebar')}
              />
              <Show when={item().kind === 'folder' && !item().archived}>
                <MenuItem
                  icon={<FilePlus2 size={15} />}
                  label="New canvas here"
                  onSelect={() => run(() => createIn('file', props.path), false)}
                />
                <MenuItem
                  icon={<FolderPlus size={15} />}
                  label="New folder here"
                  onSelect={() => run(() => createIn('folder', props.path), false)}
                />
                <MenuItem
                  icon={<ArrowUpFromLine size={15} />}
                  label="Import here"
                  onSelect={() => run(() => w.importFiles(props.path))}
                />
              </Show>
            </Show>
            <MenuItem
              icon={<FolderInput size={15} />}
              label="Move to…"
              onSelect={() => {
                const anchor = pop()?.anchor;
                const point = pop()?.point;
                if (anchor) openMove(targets(), anchor, 'sidebar', restore, point);
              }}
            />
            <Show when={sharedParent()}>
              {(folder) => (
                <MenuItem
                  icon={<CornerLeftUp size={15} />}
                  label={`Move out to ${folderLabel(parentOf(folder()))}`}
                  onSelect={() =>
                    run((focus) => moveItems(targets(), parentOf(folder()), focus), false)
                  }
                />
              )}
            </Show>
            <Show when={!multiple() && custom()}>
              <MenuItem
                icon={<ArrowUp size={15} />}
                label="Move up"
                shortcut="Alt ↑"
                keys="Alt+ArrowUp"
                disabled={position() <= 0}
                onSelect={() => run((focus) => moveStep(props.path, -1, focus), false)}
              />
              <MenuItem
                icon={<ArrowDown size={15} />}
                label="Move down"
                shortcut="Alt ↓"
                keys="Alt+ArrowDown"
                disabled={position() < 0 || position() >= siblings().length - 1}
                onSelect={() => run((focus) => moveStep(props.path, 1, focus), false)}
              />
            </Show>
            <Show when={!multiple() && item().kind === 'file'}>
              <MenuItem
                icon={<Copy size={15} />}
                label="Duplicate"
                onSelect={() => run(() => duplicateItem(props.path))}
              />
              <MenuItem
                icon={<ArrowDownToLine size={15} />}
                label="Download"
                onSelect={() => run(() => w.download(props.path))}
              />
            </Show>
            <MenuItem
              icon={allFavorite() ? <StarOff size={15} /> : <Star size={15} />}
              label={allFavorite() ? 'Remove from favorites' : 'Add to favorites'}
              onSelect={() => run((focus) => favoriteItems(targets(), !allFavorite(), focus))}
            />
            <MenuItem
              icon={allArchived() ? <ArchiveRestore size={15} /> : <Archive size={15} />}
              label={
                allArchived()
                  ? !multiple() && item().archiveRoot && item().archiveRoot !== props.path
                    ? `Unarchive ${folderLabel(item().archiveRoot!)}`
                    : 'Unarchive'
                  : 'Archive'
              }
              onSelect={() => run((focus) => archiveItems(targets(), !allArchived(), focus), false)}
            />
            <Show
              when={multiple()}
              fallback={
                <MenuItem
                  icon={<ListChecks size={15} />}
                  label="Select"
                  shortcut="Space"
                  keys="Space"
                  onSelect={() =>
                    run(() => {
                      setSelectMode(true);
                      if (!selected().has(props.path)) toggleSelected(props.path);
                    })
                  }
                />
              }
            >
              <MenuItem
                icon={<X size={15} />}
                label="Clear selection"
                onSelect={() => run(clearSelection)}
              />
            </Show>
            <div class="menu-separator" role="separator" />
            <MenuItem
              icon={<Trash2 size={15} />}
              label="Move to trash"
              shortcut="Del"
              keys="Delete"
              danger
              onSelect={() => run((focus) => trashItems(targets(), focus), false)}
            />
          </>
        )}
      </Show>
    );
  };
  const DocumentMenu = () => {
    const entry = activeEntry;
    const run = (action: () => unknown, restoreFocus = true) => {
      closePop(restoreFocus);
      void action();
    };
    const more = () => pop()?.anchor;
    return (
      <>
        <p class="popover-title" title={activePath()}>
          {pathTitle(activePath())}
        </p>
        <Show when={entry()}>
          <MenuItem
            icon={<Pencil size={15} />}
            label="Rename"
            onSelect={() => void startRename(activePath(), 'topbar')}
          />
        </Show>
        <Show when={drawerMode()}>
          <MenuItem
            icon={<History size={15} />}
            label="Version history"
            onSelect={() => {
              const anchor = more();
              setPop(undefined);
              if (anchor) void openHistory(anchor);
            }}
          />
          <MenuItem
            icon={<ArrowDownToLine size={15} />}
            label="Download"
            onSelect={() => run(() => w.download())}
          />
        </Show>
        <MenuItem
          icon={<Copy size={15} />}
          label="Duplicate"
          onSelect={() => run(() => duplicateItem(activePath()))}
        />
        <Show when={entry()}>
          {(item) => (
            <>
              <MenuItem
                icon={<FolderInput size={15} />}
                label="Move to…"
                onSelect={() => {
                  const anchor = more();
                  if (anchor) openMove([item().path], anchor, 'topbar', elementRestore(anchor));
                }}
              />
              <MenuItem
                icon={item().favorite ? <StarOff size={15} /> : <Star size={15} />}
                label={item().favorite ? 'Remove from favorites' : 'Add to favorites'}
                onSelect={() => run(() => favoriteItems([item().path], !item().favorite, false))}
              />
              <MenuItem
                icon={item().archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                label={
                  item().archived
                    ? item().archiveRoot && item().archiveRoot !== item().path
                      ? `Unarchive ${folderLabel(item().archiveRoot!)}`
                      : 'Unarchive'
                    : 'Archive'
                }
                onSelect={() => run(() => archiveItems([item().path], !item().archived, false))}
              />
              <MenuItem
                icon={<LocateFixed size={15} />}
                label="Show in explorer"
                onSelect={() => run(showInExplorer, false)}
              />
              <div class="menu-separator" role="separator" />
              <MenuItem
                icon={<Trash2 size={15} />}
                label="Move to trash"
                danger
                onSelect={() => run(() => trashItems([item().path], false))}
              />
            </>
          )}
        </Show>
      </>
    );
  };
  const showInExplorer = () => {
    openExplorer('none');
    reveal(activePath(), true);
  };
  const HistoryPanel = () => (
    <div class="history-panel">
      <p class="popover-title">Version history</p>
      <p class="popover-help">Restoring a version creates a copy beside this canvas.</p>
      <Show
        when={w.history()}
        fallback={
          <p class="popover-empty">
            {historyLoading() ? 'Loading versions…' : 'Versions could not be loaded.'}
          </p>
        }
      >
        {(items) => (
          <Show
            when={items().length}
            fallback={<p class="popover-empty">There are no earlier versions yet.</p>}
          >
            <ul class="version-list">
              <For each={items()}>
                {(item) => (
                  <li class="version-row">
                    <time dateTime={item.modified}>{dateTime(item.modified)}</time>
                    <button
                      type="button"
                      class="text-button"
                      aria-label={`Restore a copy from ${dateTime(item.modified)}`}
                      onClick={() => {
                        closePop(true);
                        void attempt(() => w.restoreHistory(item.revision));
                      }}
                    >
                      Restore a copy
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </div>
  );
  const popContent = (
    current: Pop,
  ): { label: string; role: 'menu' | 'dialog'; body: JSX.Element } => {
    switch (current.kind) {
      case 'row':
        return { label: 'Item actions', role: 'menu', body: <RowMenu path={current.path} /> };
      case 'create':
        return {
          label: `New in ${folderLabel(current.folder)}`,
          role: 'menu',
          body: (
            <>
              <p class="popover-title">{folderLabel(current.folder)}</p>
              <MenuItem
                icon={<FilePlus2 size={15} />}
                label="New canvas here"
                onSelect={() => void createIn('file', current.folder)}
              />
              <MenuItem
                icon={<FolderPlus size={15} />}
                label="New folder here"
                onSelect={() => void createIn('folder', current.folder)}
              />
              <MenuItem
                icon={<ArrowUpFromLine size={15} />}
                label="Import here"
                onSelect={() => {
                  closePop(true);
                  w.importFiles(current.folder);
                }}
              />
            </>
          ),
        };
      case 'sort':
        return {
          label: 'Sort canvases',
          role: 'menu',
          body: (
            <>
              <p class="popover-title">Sort by</p>
              <For each={sortOptions}>
                {(option) => (
                  <MenuItem
                    radio
                    checked={sort() === option.value}
                    label={option.label}
                    onSelect={() => {
                      setSort(option.value);
                      closePop(true);
                    }}
                  />
                )}
              </For>
            </>
          ),
        };
      case 'settings':
        return {
          label: 'Settings',
          role: 'menu',
          body: (
            <>
              <p class="popover-title" id="theme-label">
                Theme
              </p>
              <div role="group" aria-labelledby="theme-label">
                <For each={themeOptions}>
                  {(option) => (
                    <MenuItem
                      radio
                      checked={theme.preference() === option.value}
                      label={option.label}
                      onSelect={() => {
                        theme.setPreference(option.value);
                        closePop(true);
                      }}
                    />
                  )}
                </For>
              </div>
            </>
          ),
        };
      case 'move':
        return {
          label: 'Move to folder',
          role: 'dialog',
          body: (
            <MovePicker
              folders={w.folders() as LibraryEntry[]}
              moving={current.paths}
              title={
                current.paths.length === 1
                  ? `Move ${displayName(entryMap().get(current.paths[0]!) ?? { path: current.paths[0]!, kind: 'file' })}`
                  : `Move ${current.paths.length} items`
              }
              onPick={(folder) => {
                const hadFocus = current.layer === 'sidebar' && focusInExplorer();
                closePop(current.layer === 'topbar');
                void moveItems(current.paths, folder, hadFocus).then((moved) => {
                  if (hadFocus && !moved?.length) current.restore();
                });
              }}
            />
          ),
        };
      case 'document':
        return { label: 'Canvas actions', role: 'menu', body: <DocumentMenu /> };
      case 'history':
        return { label: 'Version history', role: 'dialog', body: <HistoryPanel /> };
    }
  };
  const renderPop = (layer: Layer) => (
    <Show when={pop()?.layer === layer ? pop() : undefined} keyed>
      {(current) => {
        const content = popContent(current);
        return (
          <Popover
            anchor={current.anchor}
            point={current.point}
            label={content.label}
            role={content.role}
            class={`popover-${current.kind}`}
            id={current.kind === 'settings' ? 'settings-menu' : undefined}
            align={current.kind === 'create' || current.kind === 'settings' ? 'start' : 'end'}
            onDismiss={dismissPop}
          >
            {content.body}
          </Popover>
        );
      }}
    </Show>
  );

  const Messages = () => (
    <>
      <Show when={w.error()}>
        <div class="message error" role="alert">
          <CircleAlert size={16} />
          <span>{w.error()}</span>
          <button
            type="button"
            class="icon-button"
            aria-label="Dismiss error"
            title="Dismiss error"
            onClick={() => w.setError('')}
          >
            <X size={15} />
          </button>
        </div>
      </Show>
      <Show when={w.notice()}>
        {(notice) => (
          <div class="message notice" role="group" aria-label="Notification">
            <span>{notice().message}</span>
            <Show when={notice().canUndo}>
              <button type="button" class="text-button" onClick={() => void w.undo()}>
                <Undo2 size={15} />
                Undo
              </button>
            </Show>
            <button
              type="button"
              class="icon-button"
              aria-label="Dismiss notification"
              title="Dismiss notification"
              onClick={w.dismissNotice}
            >
              <X size={15} />
            </button>
          </div>
        )}
      </Show>
    </>
  );
  const treeEmpty = () => (
    <div class="list-empty">
      <Show when={w.loaded()} fallback={<p>Loading canvases…</p>}>
        <Show when={!searching()} fallback={<p>No matching canvases.</p>}>
          <Show when={view() === 'library'}>
            <p>No canvases yet.</p>
          </Show>
          <Show when={view() === 'favorites'}>
            <p>No favorites yet.</p>
          </Show>
          <Show when={view() === 'archive'}>
            <p>Nothing is archived.</p>
          </Show>
        </Show>
      </Show>
    </div>
  );
  const listTitle = () =>
    searching() ? 'Results' : (views.find((item) => item.id === view())?.label ?? '');
  const listCount = () =>
    showTrashList()
      ? (w.trash()?.length ?? 0)
      : searching() || view() === 'favorites'
        ? rows().length
        : entries().filter(
            (entry) =>
              entry.kind === 'file' && (view() === 'archive' ? entry.archived : !entry.archived),
          ).length;
  const selectedItems = () =>
    [...selected()].map((path) => entryMap().get(path)).filter((e): e is LibraryEntry => !!e);
  const chooseView = (next: View) => {
    batch(() => {
      clearSelection();
      setQuery('');
      setView(next);
    });
    if (next === 'trash') void attempt(() => w.showTrash());
  };

  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (event.key === 'Escape') {
        if (drawerMode() && drawerOpen()) {
          event.preventDefault();
          closeExplorer();
        }
        return;
      }
      const key = event.key.toLowerCase();
      const globalSearch = event.shiftKey && key === 'f';
      const explorerSearch = !event.shiftKey && key === 'k' && !target?.closest('.editor-area');
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (globalSearch || explorerSearch)) {
        // Preserve the editor's Ctrl/Cmd+K link shortcut; Ctrl/Cmd+Shift+F searches globally.
        event.preventDefault();
        focusSearch();
        return;
      }
      if (event.key === 'Tab' && drawerMode() && drawerOpen()) {
        const focusable = [
          ...sidebar.querySelectorAll<HTMLElement>(
            'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), [tabindex="0"]',
          ),
        ].filter((element) => element.getClientRects().length);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!sidebar.contains(document.activeElement)) {
          event.preventDefault();
          first?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    onCleanup(() => document.removeEventListener('keydown', keydown));
  });
  createEffect(
    on(
      drawerMode,
      (isDrawer, wasDrawer) => {
        if (isDrawer === wasDrawer) return;
        const managing =
          pop()?.layer === 'sidebar' ||
          (!!w.renaming() && renameLocation() === 'sidebar') ||
          focusInExplorer();
        if (!managing) return;
        if (isDrawer && !collapsedPref()) setDrawerOpen(true);
        else if (!isDrawer && drawerOpen()) setCollapsedPref(false);
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => drawerMode() && drawerOpen(),
      (open) => {
        if (open)
          queueMicrotask(() => sidebar.contains(document.activeElement) || focusExplorerEntry());
      },
      { defer: true },
    ),
  );
  // An unresolved conflict confirmation is closed when the conflict itself is gone.
  createEffect(() => {
    const status = w.state().status;
    if (status !== 'conflict' && status !== 'offline' && w.reloadConfirm())
      w.setReloadConfirm(false);
  });

  return (
    <div
      class="workspace"
      classList={{
        drawer: drawerMode(),
        'drawer-open': drawerMode() && drawerOpen(),
        'sidebar-closed': !sidebarVisible(),
        coarse: coarse(),
      }}
    >
      <span class="sr-only" aria-live="polite">
        {w.announcement()}
      </span>
      <span class="sr-only" aria-live="polite">
        {w.notice()?.message ?? ''}
      </span>
      <input
        type="file"
        accept=".excalidraw,.json"
        multiple
        hidden
        aria-label="Import files"
        ref={w.setImportInput}
        onChange={(event) => void w.onImport(event.currentTarget.files)}
      />
      <Show when={drawerMode() && drawerOpen()}>
        <button
          type="button"
          class="sidebar-scrim"
          aria-label="Close explorer"
          tabIndex={-1}
          onClick={closeExplorer}
        />
      </Show>
      <aside
        id="canvas-explorer"
        class="sidebar"
        aria-label="Canvas explorer"
        ref={sidebar}
        inert={!sidebarVisible()}
      >
        <div class="sidebar-header">
          <button
            ref={closeButton}
            type="button"
            class="icon-button"
            aria-label="Close sidebar"
            title="Close sidebar"
            onClick={closeExplorer}
          >
            <PanelLeftClose size={18} />
          </button>
          <span class="brand">Excalidraws</span>
          <div class="navigation-buttons">
            <button
              type="button"
              class="icon-button"
              aria-label="Previous canvas"
              title="Previous canvas"
              data-name-transition
              disabled={w.navigation().index <= 0}
              onClick={() => void w.rename().then((saved) => saved && w.navigate(-1))}
            >
              <ArrowLeft size={17} />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label="Next canvas"
              title="Next canvas"
              data-name-transition
              disabled={w.navigation().index >= w.navigation().paths.length - 1}
              onClick={() => void w.rename().then((saved) => saved && w.navigate(1))}
            >
              <ArrowRight size={17} />
            </button>
          </div>
        </div>
        <div class="sidebar-search">
          <label class="search-field">
            <Search size={16} />
            <input
              ref={searchInput}
              type="text"
              inputmode="search"
              enterkeyhint="search"
              autocomplete="off"
              placeholder="Search canvases"
              aria-label="Search canvases"
              aria-keyshortcuts="Control+K Meta+K Control+Shift+F Meta+Shift+F"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.isComposing) return;
                if (event.key === 'Escape' && query()) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery('');
                } else if (event.key === 'ArrowDown' && rows().length) {
                  event.preventDefault();
                  tree?.focus(rows()[0]!.entry.path);
                } else if (event.key === 'Enter' && searching() && rows().length) {
                  event.preventDefault();
                  const first = rows()[0]!;
                  void commit(first.entry.path).then((path) => {
                    const target = rows().find((row) => row.entry.path === path);
                    if (target) activate(target);
                  });
                }
              }}
            />
            <Show when={!coarse() && !query()}>
              <kbd class="search-shortcut" aria-hidden="true">
                {/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ ⇧ F' : 'Ctrl ⇧ F'}
              </kbd>
            </Show>
            <Show when={query()}>
              <button
                type="button"
                class="icon-button search-clear"
                aria-label="Clear search"
                title="Clear search"
                onClick={() => {
                  setQuery('');
                  searchInput.focus();
                }}
              >
                <X size={14} />
              </button>
            </Show>
          </label>
        </div>
        <div class="explorer-actions">
          <button
            type="button"
            class="new-canvas"
            aria-label="New canvas"
            data-name-transition
            title="New canvas in Library"
            onClick={() => void createIn('file', '')}
          >
            <FilePlus2 size={16} />
            <span>New canvas</span>
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="New folder"
            title="New folder"
            data-name-transition
            onClick={() => void createIn('folder', '')}
          >
            <FolderPlus size={17} />
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="Import .excalidraw"
            title="Import .excalidraw"
            data-name-transition
            onClick={() => committed(() => w.importFiles())}
          >
            <ArrowUpFromLine size={17} />
          </button>
        </div>
        <div class="explorer-navigation">
          <div
            class="view-tabs"
            role="tablist"
            aria-label="Explorer views"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const tabs = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
              ];
              const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              tabs[next]?.focus();
              tabs[next]?.click();
            }}
          >
            <For each={views}>
              {(item) => (
                <button
                  type="button"
                  role="tab"
                  id={`view-tab-${item.id}`}
                  class="view-tab"
                  aria-label={item.label}
                  aria-selected={view() === item.id && !searching()}
                  aria-controls="explorer-panel"
                  tabIndex={view() === item.id ? 0 : -1}
                  title={item.label}
                  data-name-transition
                  onClick={() => committed(() => chooseView(item.id))}
                >
                  {item.icon()}
                </button>
              )}
            </For>
          </div>
          <div class="list-header">
            <span class="list-title">{listTitle()}</span>
            <span class="entry-count">{listCount()}</span>
            <Show when={!showTrashList()}>
              <button
                type="button"
                class="icon-button"
                aria-label="Select items"
                title="Select items"
                aria-pressed={selecting()}
                onClick={() => (selecting() ? clearSelection() : setSelectMode(true))}
              >
                <ListChecks size={16} />
              </button>
              <button
                type="button"
                class="icon-button"
                aria-label="Sort canvases"
                title={`Sort canvases · ${sortOptions.find((option) => option.value === sort())!.label}`}
                aria-haspopup="menu"
                aria-expanded={pop()?.kind === 'sort'}
                data-menu-trigger
                onClick={(event) => void openSort(event.currentTarget)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    void openSort(event.currentTarget);
                  }
                }}
              >
                <SlidersHorizontal size={15} />
              </button>
            </Show>
          </div>
        </div>
        <div
          id="explorer-panel"
          class="explorer-panel"
          role="tabpanel"
          aria-labelledby={searching() ? undefined : `view-tab-${view()}`}
          aria-label={searching() ? 'Search results' : undefined}
        >
          <Show
            when={showTrashList()}
            fallback={
              <CanvasTree
                rows={rows()}
                label={searching() ? 'Search results' : listTitle()}
                resetKey={`${view()}|${query()}`}
                rowHeight={rowHeight()}
                currentPath={activePath()}
                selected={selected()}
                selecting={selecting()}
                pending={w.pendingPaths()}
                menuPath={menuPath()}
                renamingPath={treeRenamingPath()}
                draft={w.renaming()}
                renameError={!!w.renaming()?.error && !!treeRenamingPath()}
                renderRename={renderRename}
                focusPath={focusPath()}
                onFocusPath={setFocusPath}
                canCreate={view() === 'library' && !searching() && !coarse()}
                favoriteBadges={view() !== 'favorites' || searching()}
                reorderable={sort() === 'custom' && view() === 'library' && !searching()}
                draggable={fine() && !coarse() && view() === 'library' && !searching()}
                empty={treeEmpty()}
                onRowClick={rowClick}
                onActivate={(row) =>
                  void commit(row.entry.path).then((path) => {
                    if (path === undefined) return;
                    const current = rows().find((item) => item.entry.path === path);
                    if (current) activate(current);
                  })
                }
                onToggle={toggleFolder}
                onSelectToggle={(path) => {
                  setSelectMode(true);
                  toggleSelected(path);
                }}
                onSelectRange={(from, to) => {
                  setSelectMode(true);
                  selectRange(from, to);
                }}
                onSelectAll={() => {
                  setSelectMode(true);
                  setSelected(new Set(rows().map((row) => row.entry.path)));
                }}
                onClearSelection={clearSelection}
                onMenu={(path, anchor, point) => void openRowMenu(path, anchor, point)}
                onCreateMenu={(path, anchor) => void openCreateMenu(path, anchor)}
                onRename={(path) => void startRename(path, 'sidebar')}
                onTrash={(path) =>
                  void commit(path).then((target) => {
                    if (target !== undefined) void trashItems(targetsFor(target));
                  })
                }
                onReorder={(path, delta) => void moveStep(path, delta)}
                dragPaths={(path) => (selected().has(path) ? topLevel(selected()) : [path])}
                onDrop={(paths, target) => void drop(paths, target)}
                ref={(api) => (tree = api)}
              />
            }
          >
            <Show when={w.trash()} fallback={<p class="list-empty">Loading trash…</p>}>
              {(items) => (
                <Show
                  when={items().length}
                  fallback={
                    <div class="list-empty">
                      <p>The trash is empty.</p>
                    </div>
                  }
                >
                  <ul class="trash-list" aria-label="Trash">
                    <For each={items()}>
                      {(item) => (
                        <li class="trash-row">
                          <span class="row-icon" aria-hidden="true">
                            <Show when={item.kind === 'folder'} fallback={<FileText size={15} />}>
                              <Folder size={15} />
                            </Show>
                          </span>
                          <span class="trash-text">
                            <span class="file-name" title={item.path}>
                              {displayName(item)}
                            </span>
                            <small>
                              {folderLabel(parentOf(item.path))} · Deleted {dateTime(item.deleted)}
                            </small>
                          </span>
                          <button
                            type="button"
                            class="text-button"
                            aria-label={`Restore ${displayName(item)}`}
                            title={`Restore ${item.path}`}
                            disabled={w.pendingPaths().has(item.id)}
                            onClick={(event) => void restoreTrashItem(item, event.currentTarget)}
                          >
                            <RotateCcw size={14} />
                            Restore
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              )}
            </Show>
          </Show>
        </div>
        <Show when={selecting()}>
          <div class="bulk-bar" role="group" aria-label="Selection actions">
            <span class="bulk-count">
              {selected().size ? `${selected().size} selected` : 'Select items'}
            </span>
            <button
              type="button"
              class="icon-button"
              aria-label="Move selected"
              title="Move selected"
              disabled={!selected().size}
              data-name-transition
              onClick={(event) => {
                const anchor = event.currentTarget;
                committed(() =>
                  openMove([...selected()], anchor, 'sidebar', elementRestore(anchor)),
                );
              }}
            >
              <FolderInput size={17} />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label={
                selectedItems().length && selectedItems().every((item) => item.favorite)
                  ? 'Remove selected from favorites'
                  : 'Add selected to favorites'
              }
              title={
                selectedItems().length && selectedItems().every((item) => item.favorite)
                  ? 'Remove selected from favorites'
                  : 'Add selected to favorites'
              }
              disabled={!selected().size}
              data-name-transition
              onClick={() =>
                committed(() =>
                  favoriteItems([...selected()], !selectedItems().every((item) => item.favorite)),
                )
              }
            >
              <Show
                when={selectedItems().length && selectedItems().every((item) => item.favorite)}
                fallback={<Star size={17} />}
              >
                <StarOff size={17} />
              </Show>
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label={
                selectedItems().length && selectedItems().every((item) => item.archived)
                  ? 'Unarchive selected'
                  : 'Archive selected'
              }
              title={
                selectedItems().length && selectedItems().every((item) => item.archived)
                  ? 'Unarchive selected'
                  : 'Archive selected'
              }
              disabled={!selected().size}
              data-name-transition
              onClick={() =>
                committed(() =>
                  archiveItems([...selected()], !selectedItems().every((item) => item.archived)),
                )
              }
            >
              <Show
                when={selectedItems().length && selectedItems().every((item) => item.archived)}
                fallback={<Archive size={17} />}
              >
                <ArchiveRestore size={17} />
              </Show>
            </button>
            <button
              type="button"
              class="icon-button danger"
              aria-label="Move selected to trash"
              title="Move selected to trash"
              disabled={!selected().size}
              data-name-transition
              onClick={() => committed(() => trashItems([...selected()]))}
            >
              <Trash2 size={17} />
            </button>
            <button type="button" class="text-button bulk-done" onClick={clearSelection}>
              Done
            </button>
          </div>
        </Show>
        <div class="sidebar-bottom">
          <Show when={sidebarVisible()}>
            <div class="explorer-messages">
              <Messages />
            </div>
          </Show>
          <div class="sidebar-footer">
            <button
              type="button"
              class="settings-button"
              aria-label="Settings"
              aria-haspopup="menu"
              aria-expanded={pop()?.kind === 'settings'}
              aria-controls={pop()?.kind === 'settings' ? 'settings-menu' : undefined}
              data-name-transition
              onClick={(event) => void openSettings(event.currentTarget)}
            >
              <Settings size={16} />
              <span>Settings</span>
            </button>
          </div>
        </div>
        <div class="popover-layer">{renderPop('sidebar')}</div>
      </aside>
      <main class="main-area" inert={drawerMode() && drawerOpen()}>
        <header class="topbar">
          <Show when={!sidebarVisible() || drawerMode()}>
            <button
              ref={toggleButton}
              type="button"
              class="icon-button explorer-toggle"
              aria-label="Open explorer"
              title="Open explorer"
              aria-expanded={sidebarVisible()}
              aria-controls="canvas-explorer"
              onClick={() => (sidebarVisible() ? closeExplorer() : openExplorer())}
            >
              <PanelLeft size={19} />
            </button>
          </Show>
          <div class="document-title">
            <Show when={w.session()} fallback={<span class="empty-title">Excalidraws</span>}>
              <Show when={parentOf(activePath())}>
                <button
                  type="button"
                  class="breadcrumb-parent"
                  aria-label={`Show ${parentOf(activePath())} in explorer`}
                  title="Show in explorer"
                  data-name-transition
                  onClick={showInExplorer}
                >
                  {parentOf(activePath())}
                </button>
                <ChevronRight class="breadcrumb-chevron" size={13} />
              </Show>
              <div class="canvas-name">
                <h1 title={activeName()} aria-label={activeName()}>
                  <Show
                    when={editingActiveIn('topbar')}
                    fallback={
                      <button
                        ref={titleButton}
                        type="button"
                        class="title-button"
                        aria-label={`Rename canvas ${activeName()}`}
                        title="Rename"
                        disabled={!activeEntry()}
                        onClick={() => void startRename(activePath(), 'topbar')}
                      >
                        <span class="title-text">{activeName()}</span>
                        <Pencil class="title-pencil" size={13} aria-hidden="true" />
                      </button>
                    }
                  >
                    {renderRename()}
                  </Show>
                </h1>
                <Show when={activeEntry()?.archived && activeEntry()}>
                  {(entry) => (
                    <span class="archived-state">
                      <span class="badge">Archived</span>
                      <button
                        type="button"
                        class="text-button compact"
                        title={
                          entry().archiveRoot && entry().archiveRoot !== entry().path
                            ? `Unarchive ${folderLabel(entry().archiveRoot!)}`
                            : 'Unarchive this canvas'
                        }
                        onClick={() =>
                          void archiveItems([entry().path], false).then(() => titleButton?.focus())
                        }
                      >
                        Unarchive
                      </button>
                    </span>
                  )}
                </Show>
              </div>
            </Show>
          </div>
          <Show when={w.session()}>
            <div class="document-tools">
              <span
                class="save-status"
                classList={{
                  problem: w.state().status === 'conflict' || w.state().status === 'offline',
                  saving: w.state().status === 'pending' || w.state().status === 'saving',
                }}
                role="status"
                aria-live="off"
                title={w.state().message || statusLabels[w.state().status]}
              >
                <span class="status-icon" aria-hidden="true">
                  <Show when={w.state().status !== 'saved'} fallback={<Check size={14} />}>
                    <Show
                      when={w.state().status === 'conflict' || w.state().status === 'offline'}
                      fallback={<span class="state-dot" />}
                    >
                      <CircleAlert size={14} />
                    </Show>
                  </Show>
                </span>
                <span class="status-label">{statusLabels[w.state().status]}</span>
              </span>
              <Show when={!drawerMode()}>
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Version history"
                  title="Version history"
                  aria-haspopup="dialog"
                  aria-expanded={pop()?.kind === 'history'}
                  data-menu-trigger
                  onClick={(event) => void openHistory(event.currentTarget)}
                >
                  <History size={17} />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Download canvas"
                  title="Download canvas"
                  onClick={() => void w.download()}
                >
                  <ArrowDownToLine size={17} />
                </button>
              </Show>
              <button
                type="button"
                class="icon-button"
                aria-label="More canvas actions"
                title="More canvas actions"
                aria-haspopup="menu"
                aria-expanded={
                  pop()?.kind === 'document' || (pop()?.kind === 'history' && drawerMode())
                }
                data-menu-trigger
                onClick={(event) => void openDocumentMenu(event.currentTarget)}
              >
                <Ellipsis size={18} />
              </button>
            </div>
          </Show>
          <div class="popover-layer">{renderPop('topbar')}</div>
        </header>
        <Show when={w.state().localError}>
          <div class="notice warning" role="alert">
            <span>
              Local draft unavailable. Keep this page open until the status shows “Saved”.
            </span>
          </div>
        </Show>
        <Show
          when={w.session() && (w.state().status === 'conflict' || w.state().status === 'offline')}
        >
          <div class="notice warning" role="alert">
            <Show
              when={w.reloadConfirm()}
              fallback={
                <>
                  <span>{w.state().message}</span>
                  <Show
                    when={w.state().status === 'offline'}
                    fallback={
                      <Show when={activeEntry()}>
                        <button
                          ref={loadButton}
                          type="button"
                          onClick={() => {
                            w.setReloadConfirm(true);
                            queueMicrotask(() =>
                              document
                                .querySelector<HTMLButtonElement>('[data-keep-local]')
                                ?.focus(),
                            );
                          }}
                        >
                          Load from server
                        </button>
                      </Show>
                    }
                  >
                    <button
                      type="button"
                      onClick={() =>
                        void w
                          .session()
                          ?.flush()
                          .then((saved) => saved && titleButton?.focus())
                      }
                    >
                      Retry saving
                    </button>
                  </Show>
                  <button
                    type="button"
                    onClick={() =>
                      void duplicateItem(activePath()).then(() => titleButton?.focus())
                    }
                  >
                    Save a copy
                  </button>
                  <button type="button" onClick={() => void w.download()}>
                    Download
                  </button>
                </>
              }
            >
              <span>
                Discard the local drawing and load the server version? Save a copy first to keep
                both.
              </span>
              <button
                type="button"
                class="danger-button"
                onClick={() => void w.reload().then(() => titleButton?.focus())}
              >
                Discard local changes
              </button>
              <button
                type="button"
                data-keep-local
                onClick={() => {
                  w.setReloadConfirm(false);
                  queueMicrotask(() => loadButton?.focus());
                }}
              >
                Keep local changes
              </button>
            </Show>
          </div>
        </Show>
        <div
          class="editor-area"
          classList={{ 'is-switching': !!w.switchTarget() }}
          aria-busy={!!w.switchTarget()}
          inert={!!w.switchTarget()}
        >
          <Show
            when={w.session()}
            keyed
            fallback={
              <div class="empty-workspace">
                <p>{w.loaded() ? 'Open a canvas or create one.' : 'Loading workspace…'}</p>
                <Show when={w.loaded()}>
                  <div class="empty-actions">
                    <button
                      type="button"
                      class="primary"
                      data-name-transition
                      onClick={() => void createIn('file', '')}
                    >
                      <FilePlus2 size={16} />
                      Create canvas
                    </button>
                    <button type="button" onClick={() => w.importFiles()}>
                      <ArrowUpFromLine size={16} />
                      Import
                    </button>
                  </div>
                </Show>
              </div>
            }
          >
            {(session) => (
              <EditorSurface
                session={session}
                theme={theme.resolved()}
                onImport={() => w.importFiles()}
                onReady={w.setEditor}
                onPending={w.setEditorPending}
                onError={(e) =>
                  w.setError(
                    e instanceof Error ? e.message : 'Could not load the editor. Reload to retry.',
                  )
                }
              />
            )}
          </Show>
          <Show when={w.switchTarget() || slowBusy()}>
            <div class="processing" aria-label="Processing">
              {w.switchTarget() ? `Opening ${pathTitle(w.switchTarget())}…` : 'Working…'}
            </div>
          </Show>
          <Show when={!sidebarVisible()}>
            <div class="floating-messages">
              <Messages />
            </div>
          </Show>
        </div>
      </main>
    </div>
  );
}
