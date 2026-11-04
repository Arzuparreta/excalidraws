import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
  type JSX,
} from 'solid-js';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-solid';
import type { Entry } from '../../shared/model';
import { EditorSurface } from '../editor/EditorSurface';
import {
  basename,
  createWorkspace,
  parent,
  pathWithName,
  readSetting,
  saveSetting,
  title,
} from './controller';

const displayDate = (value: string) =>
  new Date(value).toLocaleString('en', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
const shortDate = (value: string) =>
  new Date(value).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const statusLabels = {
  saved: 'Saved',
  pending: 'Pending changes',
  saving: 'Saving…',
  offline: 'Not saved',
  conflict: 'Conflict',
};

function Modal(props: { title: string; children: JSX.Element; onClose(): void }) {
  let dialog!: HTMLDialogElement;
  let previous: HTMLElement | null;
  onMount(() => {
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[autofocus]')?.focus();
  });
  onCleanup(() => {
    dialog.close();
    previous?.isConnected && previous.focus();
  });
  return (
    <dialog
      class="dialog"
      ref={dialog}
      aria-label={props.title}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
      onClick={(e) => {
        if (e.target === dialog) {
          const box = dialog.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            props.onClose();
        }
      }}
    >
      <div class="dialog-heading">
        <h2>{props.title}</h2>
        <button class="icon-button" aria-label="Close dialog" onClick={props.onClose}>
          <X size={18} />
        </button>
      </div>
      {props.children}
    </dialog>
  );
}

type Row = { entry: Entry; depth: number; expanded: boolean };
type RenameState = { path: string; name: string; error: string };

function InlineName(props: {
  value: RenameState;
  label: string;
  busy: boolean;
  onInput(name: string): void;
  onSave(restoreFocus: boolean): Promise<boolean>;
  onCancel(): void;
}) {
  let container!: HTMLSpanElement;
  let input!: HTMLInputElement;
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  const save = async (restoreFocus: boolean) => {
    const saved = await props.onSave(restoreFocus);
    if (!saved && input.isConnected) input.focus();
  };
  onMount(() => {
    input.focus();
    input.select();
  });
  onCleanup(() => clearTimeout(blurTimer));
  return (
    <span
      class="inline-name"
      ref={container}
      onFocusOut={(event) => {
        const next = event.relatedTarget;
        if (
          next instanceof Element &&
          next.closest(
            '.file-select, .active-select, .title-button, [data-name-transition], [data-menu-trigger]',
          )
        )
          return;
        // Let a clicked workspace action finish the edit before its own operation.
        blurTimer = setTimeout(() => {
          if (container.isConnected && !container.contains(document.activeElement) && !props.busy)
            void save(false);
        }, 0);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          void save(true);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          props.onCancel();
        }
      }}
    >
      <input
        ref={input}
        aria-label={props.label}
        aria-invalid={!!props.value.error}
        aria-describedby={props.value.error ? 'rename-error' : undefined}
        title="Enter to save · Escape to cancel"
        maxLength={160}
        size={Math.max(1, props.value.name.length)}
        value={props.value.name}
        readOnly={props.busy}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
      <button
        class="icon-button"
        type="button"
        onClick={() => void save(true)}
        aria-label="Save name"
        title="Save name · Enter"
        disabled={props.busy}
      >
        <Check size={15} />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Cancel rename"
        title="Cancel · Escape"
        disabled={props.busy}
        onClick={props.onCancel}
      >
        <X size={15} />
      </button>
      <Show when={props.value.error}>
        <span id="rename-error" class="rename-error" role="alert">
          {props.value.error}
        </span>
      </Show>
    </span>
  );
}

function FileList(props: {
  rows: Row[];
  active?: string;
  search: string;
  menuPath?: string;
  selectedFolder: string;
  renaming?: RenameState;
  renderRename(): JSX.Element;
  onRename(path: string): void;
  onOpen(row: Row): void;
  onMenu(entry: Entry, button: HTMLButtonElement): void;
  loaded: boolean;
}) {
  const renamePath = createMemo(() => props.renaming?.path);
  const renameError = createMemo(() => !!props.renaming?.error);
  let list!: HTMLElement;
  const [scroll, setScroll] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const rowHeight = 40;
  const start = createMemo(() =>
    Math.max(0, Math.min(Math.floor(scroll() / rowHeight) - 6, Math.max(0, props.rows.length - 1))),
  );
  const end = createMemo(() =>
    Math.min(props.rows.length, start() + Math.ceil(height() / rowHeight) + 12),
  );
  const visible = createMemo(() => props.rows.slice(start(), end()));
  createEffect(() => {
    const path = renamePath();
    const index = path ? props.rows.findIndex((row) => row.entry.path === path) : -1;
    if (list && index >= 0) {
      const top = index * rowHeight;
      if (
        top < list.scrollTop ||
        top + rowHeight + (renameError() ? 65 : 0) > list.scrollTop + height()
      ) {
        list.scrollTop = Math.max(0, top - height() / 2);
        setScroll(list.scrollTop);
      }
    }
  });
  createEffect(() => {
    props.search;
    if (list) {
      list.scrollTop = 0;
      setScroll(0);
    }
  });
  onMount(() => {
    const resize = new ResizeObserver(() => setHeight(list.clientHeight));
    resize.observe(list);
    onCleanup(() => resize.disconnect());
  });
  return (
    <nav
      class="file-list"
      aria-label="Files"
      ref={list}
      onScroll={() => setScroll(list.scrollTop)}
      style={{ 'padding-bottom': renameError() ? '70px' : undefined }}
    >
      <Show
        when={props.rows.length}
        fallback={
          <p class="list-empty">
            {!props.loaded
              ? 'Loading canvases…'
              : props.search
                ? 'No matching canvases.'
                : props.active
                  ? 'No other canvases.'
                  : 'No canvases yet.'}
          </p>
        }
      >
        <div style={{ height: `${start() * rowHeight}px` }} aria-hidden="true" />
        <For each={visible()}>
          {(row) => (
            <div
              class="file-row"
              classList={{
                'folder-selected':
                  row.entry.kind === 'folder' && props.selectedFolder === row.entry.path,
                'is-renaming': renamePath() === row.entry.path,
              }}
              data-entry-path={row.entry.path}
              onClick={(event) => {
                if (
                  event.target instanceof Element &&
                  !event.target.closest('button, .inline-name')
                )
                  props.onOpen(row);
              }}
              style={{ 'padding-left': `${8 + Math.min(row.depth, 7) * 14}px` }}
            >
              <button
                class="file-icon"
                aria-label={
                  row.entry.kind === 'folder'
                    ? `Toggle folder ${basename(row.entry.path)}`
                    : `Open canvas ${title(row.entry.path)}`
                }
                aria-expanded={row.entry.kind === 'folder' ? row.expanded : undefined}
                tabIndex={-1}
                onClick={() => props.onOpen(row)}
              >
                <Show when={row.entry.kind === 'folder'} fallback={<FileText size={16} />}>
                  <Show when={row.expanded} fallback={<ChevronRight size={14} />}>
                    <ChevronDown size={14} />
                  </Show>
                  <Show when={row.expanded} fallback={<Folder size={16} />}>
                    <FolderOpen size={16} />
                  </Show>
                </Show>
              </button>
              <div class="file-name-slot">
                <Show
                  when={renamePath() === row.entry.path}
                  fallback={
                    <button
                      class="file-select"
                      title={row.entry.path}
                      aria-label={
                        row.entry.kind === 'folder'
                          ? basename(row.entry.path)
                          : title(row.entry.path)
                      }
                      aria-expanded={row.entry.kind === 'folder' ? row.expanded : undefined}
                      onClick={() => props.onOpen(row)}
                      onKeyDown={(e) => {
                        if (e.key === 'F2') {
                          e.preventDefault();
                          props.onRename(row.entry.path);
                        }
                      }}
                    >
                      <span class="file-name">
                        {row.entry.kind === 'folder'
                          ? basename(row.entry.path)
                          : title(row.entry.path)}
                      </span>
                    </button>
                  }
                >
                  {props.renderRename()}
                </Show>
              </div>
              <Show when={props.search && parent(row.entry.path)}>
                <span class="file-parent">{parent(row.entry.path)}</span>
              </Show>
              <Show when={row.entry.kind === 'file' && !props.search}>
                <time class="file-date" dateTime={row.entry.modified}>
                  {shortDate(row.entry.modified)}
                </time>
              </Show>
              <Show when={renamePath() !== row.entry.path}>
                <button
                  class="icon-button row-rename"
                  data-name-transition
                  aria-label={`Rename ${row.entry.kind === 'folder' ? basename(row.entry.path) : title(row.entry.path)}`}
                  title="Rename"
                  onClick={() => props.onRename(row.entry.path)}
                >
                  <Pencil size={14} />
                </button>
              </Show>
              <button
                class="icon-button row-menu"
                data-menu-trigger
                aria-label={`Actions for ${row.entry.kind === 'folder' ? basename(row.entry.path) : title(row.entry.path)}`}
                aria-expanded={props.menuPath === row.entry.path}
                onClick={(e) => props.onMenu(row.entry, e.currentTarget)}
              >
                <Ellipsis size={17} />
              </button>
            </div>
          )}
        </For>
        <div
          style={{ height: `${Math.max(0, props.rows.length - end()) * rowHeight}px` }}
          aria-hidden="true"
        />
      </Show>
    </nav>
  );
}

export function Workspace() {
  const w = createWorkspace();
  const [search, setSearch] = createSignal('');
  const [mobile, setMobile] = createSignal(window.matchMedia('(max-width: 760px)').matches);
  const [mobileOpen, setMobileOpen] = createSignal(false);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(
    readSetting('sidebar-collapsed') === 'true',
  );
  const [collapsed, setCollapsed] = createSignal(new Set<string>());
  const [listCollapsed, setListCollapsed] = createSignal(false);
  const [sort, setSort] = createSignal(readSetting('sort') === 'name' ? 'name' : 'recent');
  const [sortOpen, setSortOpen] = createSignal(false);
  let sortButton!: HTMLButtonElement;
  const [menu, setMenu] = createSignal<{
    entry: Entry;
    left: number;
    top: number;
    trigger: HTMLButtonElement;
  }>();
  let sidebar!: HTMLElement;
  let searchInput!: HTMLInputElement;
  let toggleButton!: HTMLButtonElement;
  let titleButton: HTMLButtonElement | undefined;
  const sidebarVisible = createMemo(() => (mobile() ? mobileOpen() : !sidebarCollapsed()));
  const activePath = w.documentPath;
  const [renameLocation, setRenameLocation] = createSignal<'sidebar' | 'topbar'>('topbar');
  const activeName = () =>
    w.renaming()?.path === activePath() ? w.renaming()!.name : title(activePath());
  const editingActiveIn = (location: 'sidebar' | 'topbar') =>
    w.renaming()?.path === activePath() && renameLocation() === location;
  const activeEntry = createMemo(() => w.entries().find((e) => e.path === activePath()));
  let rowCache = new Map<string, Row>();
  const retainRows = (rows: Row[]) => {
    const stable = rows.map((row) => {
      const old = rowCache.get(row.entry.path);
      return old?.entry === row.entry && old.depth === row.depth && old.expanded === row.expanded
        ? old
        : row;
    });
    rowCache = new Map(stable.map((row) => [row.entry.path, row]));
    return stable;
  };
  const filteredRows = createMemo(() => {
    const query = search().trim().toLocaleLowerCase();
    const active = activePath();
    const entries = w.entries();
    const compare = (a: Entry, b: Entry) =>
      a.kind !== b.kind
        ? a.kind === 'folder'
          ? -1
          : 1
        : sort() === 'recent' && a.kind === 'file'
          ? b.modified.localeCompare(a.modified) || a.path.localeCompare(b.path)
          : a.path.localeCompare(b.path, 'en', { numeric: true });
    if (query)
      return retainRows(
        entries
          .filter((e) => e.path !== active && e.path.toLocaleLowerCase().includes(query))
          .sort(compare)
          .map((entry) => ({ entry, depth: 0, expanded: false })),
      );
    const children = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = parent(entry.path);
      const group = children.get(key) ?? [];
      group.push(entry);
      children.set(key, group);
    }
    const rows: Row[] = [];
    const visit = (path: string, depth: number) => {
      for (const entry of (children.get(path) ?? []).sort(compare)) {
        if (entry.path === active) continue;
        const expanded = !collapsed().has(entry.path);
        rows.push({ entry, depth, expanded });
        if (entry.kind === 'folder' && expanded) visit(entry.path, depth + 1);
      }
    };
    visit('', 0);
    return retainRows(rows);
  });
  createEffect(() => {
    saveSetting('sidebar-collapsed', String(sidebarCollapsed()));
  });
  createEffect(() => {
    saveSetting('sort', sort());
  });
  createEffect(() => {
    if (w.session()) untrack(() => setMobileOpen(false));
  });
  createEffect(() => {
    const path = activePath();
    document.title = path ? `${title(path)} · Excalidraws` : 'Excalidraws';
  });
  // Reveal newly created/moved folders without expanding unrelated branches.
  createEffect(() => {
    const selected = w.selectedFolder();
    if (selected)
      setCollapsed(
        (previous) =>
          new Set([...previous].filter((p) => p !== selected && !selected.startsWith(`${p}/`))),
      );
  });
  const closeSidebar = () => {
    setMobileOpen(false);
    if (mobile()) toggleButton?.focus();
  };
  const toggleSidebar = () =>
    mobile() ? setMobileOpen(!mobileOpen()) : setSidebarCollapsed(!sidebarCollapsed());
  const focusSearch = () => {
    if (mobile()) setMobileOpen(true);
    else setSidebarCollapsed(false);
    queueMicrotask(() => searchInput.focus());
  };
  const openBoard = (path: string) => {
    void (async () => {
      const target = await w.finishRename(path);
      if (!target) return;
      closeSidebar();
      w.open(target);
    })();
  };
  const closeMenu = (focus = false) => {
    const current = menu();
    setMenu(undefined);
    if (focus) current?.trigger.focus();
  };
  const openMenu = async (entry: Entry, trigger: HTMLButtonElement) => {
    const target = await w.finishRename(entry.path);
    if (!target) return;
    entry = w.entries().find((item) => item.path === target) ?? entry;
    setSortOpen(false);
    if (menu()?.entry.path === entry.path) {
      closeMenu();
      return;
    }
    const bounds = trigger.getBoundingClientRect();
    setMenu({
      entry,
      trigger,
      left: Math.max(8, Math.min(innerWidth - 212, bounds.right - 200)),
      top: Math.max(8, Math.min(innerHeight - 190, bounds.bottom + 4)),
    });
  };
  const ask = (mode: Parameters<typeof w.ask>[0], path?: string) => {
    void (async () => {
      if (!(await w.rename())) return;
      closeMenu();
      w.ask(mode, path);
      if (mode === 'move') {
        if (mobile()) setMobileOpen(true);
        else setSidebarCollapsed(false);
      }
    })();
  };
  const startRename = (path: string, location: 'sidebar' | 'topbar' = 'sidebar') => {
    if (w.busy()) return;
    if (w.renaming()?.path === path) {
      setRenameLocation(location);
      return;
    }
    void (async () => {
      const target = await w.finishRename(path);
      if (!target) return;
      closeMenu();
      w.setPrompt(undefined);
      setRenameLocation(location);
      if (target === activePath() && location === 'topbar') closeSidebar();
      else {
        setListCollapsed(false);
        setCollapsed(
          (previous) => new Set([...previous].filter((p) => !target.startsWith(`${p}/`))),
        );
      }
      w.startRename(target);
    })();
  };
  const create = (kind: Entry['kind']) => {
    void (async () => {
      if (!(await w.rename())) return;
      closeMenu();
      w.setPrompt(undefined);
      setSearch('');
      setListCollapsed(false);
      const destination = w.selectedFolder();
      setCollapsed(
        (previous) =>
          new Set(
            [...previous].filter(
              (path) => path !== destination && !destination.startsWith(`${path}/`),
            ),
          ),
      );
      w.create(kind);
    })();
  };
  const focusActiveName = () => {
    if (renameLocation() === 'sidebar')
      sidebar.querySelector<HTMLButtonElement>('.active-rename')?.focus();
    else titleButton?.focus();
  };
  const renderRename = () => (
    <InlineName
      value={w.renaming()!}
      label={
        w.entries().find((entry) => entry.path === w.renaming()?.path)?.kind === 'folder'
          ? 'Folder name'
          : 'Canvas name'
      }
      busy={w.busy()}
      onInput={(name) => w.setRenaming((value) => value && { ...value, name, error: '' })}
      onSave={async (restoreFocus) => {
        const value = w.renaming();
        const active = value?.path === activePath();
        const entry = w.entries().find((entry) => entry.path === value?.path);
        const saved = await w.rename();
        if (saved && restoreFocus) {
          if (active) focusActiveName();
          else if (value && entry) {
            const target = pathWithName(entry, value.name);
            sidebar
              .querySelector<HTMLButtonElement>(
                `[data-entry-path="${CSS.escape(target)}"] .file-select`,
              )
              ?.focus();
          }
        }
        return saved;
      }}
      onCancel={() => {
        const active = w.renaming()?.path === activePath();
        const path = w.renaming()?.path;
        w.cancelRename();
        if (active) focusActiveName();
        else if (path)
          sidebar
            .querySelector<HTMLButtonElement>(
              `[data-entry-path="${CSS.escape(path)}"] .file-select`,
            )
            ?.focus();
      }}
    />
  );
  const closeSort = (focus = false) => {
    setSortOpen(false);
    if (focus) sortButton.focus();
  };
  const openSort = () => {
    closeMenu();
    setSortOpen(true);
  };
  onMount(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const resize = () => {
      setMobile(media.matches);
      setMobileOpen(false);
      closeMenu();
      closeSort();
    };
    const pointer = (e: PointerEvent) => {
      if (sortOpen() && e.target instanceof Element && !e.target.closest('.canvas-sort'))
        closeSort();
      if (
        menu() &&
        e.target instanceof Element &&
        !e.target.closest('.entry-menu, [data-menu-trigger]')
      )
        closeMenu();
    };
    const keydown = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (
        e.key === 'Escape' &&
        e.target instanceof Element &&
        e.target.closest('.inline-name, .organize-panel form')
      )
        return;
      if (e.key === 'Escape') {
        if (sortOpen()) {
          e.preventDefault();
          closeSort(true);
        } else if (menu()) {
          e.preventDefault();
          closeMenu(true);
        } else if (mobileOpen()) {
          e.preventDefault();
          closeSidebar();
        }
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'k' &&
        !document.querySelector('dialog[open]')
      ) {
        e.preventDefault();
        focusSearch();
      }
      if (mobile() && mobileOpen() && e.key === 'Tab') {
        const focusable = [
          ...sidebar.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
        ].filter((el) => el.getClientRects().length);
        const first = focusable[0],
          last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    media.addEventListener('change', resize);
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', keydown);
    onCleanup(() => {
      media.removeEventListener('change', resize);
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', keydown);
    });
  });
  createEffect(() => {
    if (mobile() && mobileOpen())
      queueMicrotask(() => sidebar.querySelector<HTMLButtonElement>('button')?.focus());
  });
  const modalClose = (close: () => void) => {
    if (!w.busy()) close();
  };

  return (
    <div
      class="workspace"
      classList={{
        'sidebar-closed': !sidebarVisible(),
        'mobile-sidebar-open': mobile() && mobileOpen(),
      }}
    >
      <span class="sr-only" aria-live="polite">
        {w.announcement()}
      </span>
      <input
        type="file"
        accept=".excalidraw,.json"
        multiple
        hidden
        aria-label="Import files"
        ref={w.setImportInput}
        onChange={(e) => w.onImport(e.currentTarget.files)}
      />
      <Show when={mobile() && mobileOpen()}>
        <button class="sidebar-scrim" aria-label="Close explorer" onClick={closeSidebar} />
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
            class="icon-button"
            aria-label="Close sidebar"
            title="Hide sidebar"
            onClick={() => (mobile() ? closeSidebar() : setSidebarCollapsed(true))}
          >
            <PanelLeftClose size={18} />
          </button>
          <span class="brand">Excalidraws</span>
          <div class="navigation-buttons">
            <button
              class="icon-button"
              aria-label="Previous canvas"
              data-name-transition
              title="Previous canvas"
              disabled={w.navigation().index <= 0 || w.busy()}
              onClick={() => void w.rename().then((saved) => saved && w.navigate(-1))}
            >
              <ArrowLeft size={17} />
            </button>
            <button
              class="icon-button"
              aria-label="Next canvas"
              data-name-transition
              title="Next canvas"
              disabled={w.navigation().index >= w.navigation().paths.length - 1 || w.busy()}
              onClick={() => void w.rename().then((saved) => saved && w.navigate(1))}
            >
              <ArrowRight size={17} />
            </button>
          </div>
        </div>
        <div class="sidebar-search">
          <label class="search-field">
            <Search size={17} />
            <input
              ref={searchInput}
              type="text"
              inputmode="search"
              placeholder="Search canvases…"
              aria-label="Search canvases"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
          </label>
          <button
            class="icon-button"
            title="New folder"
            aria-label="New folder"
            data-name-transition
            disabled={w.busy()}
            onClick={() => create('folder')}
          >
            <FolderPlus size={18} />
          </button>
          <button
            class="icon-button"
            title="New canvas"
            aria-label="New canvas"
            data-name-transition
            disabled={w.busy()}
            onClick={() => create('file')}
          >
            <FilePlus2 size={18} />
          </button>
        </div>
        <Show when={w.session()}>
          {(session) => (
            <div
              class="active-card"
              onClick={(event) => {
                if (
                  event.target instanceof Element &&
                  !event.target.closest('button, .inline-name')
                )
                  openBoard(activePath());
              }}
            >
              <span class="active-context">
                <FileText size={15} />
                <span>{parent(activePath()) || 'My canvases'}</span>
                <Show when={activeEntry()}>
                  {(entry) => (
                    <time dateTime={entry().modified}>{shortDate(entry().modified)}</time>
                  )}
                </Show>
              </span>
              <div class="active-name-line">
                <Show
                  when={editingActiveIn('sidebar')}
                  fallback={
                    <button
                      class="active-select active-title"
                      aria-label={activeName()}
                      aria-current="page"
                      title={activePath()}
                      onClick={() => openBoard(activePath())}
                      onKeyDown={(e) => {
                        if (e.key === 'F2') {
                          e.preventDefault();
                          startRename(activePath());
                        }
                      }}
                    >
                      {activeName()}
                    </button>
                  }
                >
                  {renderRename()}
                </Show>
                <Show when={!editingActiveIn('sidebar')}>
                  <button
                    class="icon-button active-rename"
                    data-name-transition
                    aria-label={`Rename ${activeName()} in sidebar`}
                    title="Rename"
                    disabled={w.busy()}
                    onClick={() => startRename(activePath())}
                  >
                    <Pencil size={14} />
                  </button>
                </Show>
              </div>
              <span class="active-state">
                <span
                  class="state-dot"
                  classList={{
                    dirty: w.state().dirty,
                    problem: w.state().status === 'offline' || w.state().status === 'conflict',
                  }}
                />
                {statusLabels[w.state().status]}
              </span>
              <button
                class="icon-button active-menu"
                data-menu-trigger
                aria-label={`Actions for ${title(activePath())}`}
                aria-expanded={menu()?.entry.path === activePath()}
                onClick={(e) =>
                  openMenu(
                    activeEntry() ?? { path: activePath(), kind: 'file', modified: '' },
                    e.currentTarget,
                  )
                }
              >
                <Ellipsis size={17} />
              </button>
            </div>
          )}
        </Show>
        <div class="section-heading">
          <button
            class="section-toggle"
            aria-expanded={!listCollapsed() || !!search()}
            onClick={() => setListCollapsed(!listCollapsed())}
          >
            <span>Canvases</span>
            <span class="entry-count">{w.entries().filter((e) => e.kind === 'file').length}</span>
            <Show when={listCollapsed() && !search()} fallback={<ChevronDown size={14} />}>
              <ChevronRight size={14} />
            </Show>
          </button>
          <div class="canvas-sort">
            <button
              ref={sortButton}
              class="icon-button"
              aria-label="Sort canvases"
              aria-haspopup="menu"
              aria-expanded={sortOpen()}
              aria-controls="canvas-sort-menu"
              title={`Sort canvases · ${sort() === 'recent' ? 'Recent' : 'Name (A–Z)'}`}
              onClick={() => (sortOpen() ? closeSort() : openSort())}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  openSort();
                }
              }}
            >
              <SlidersHorizontal size={15} />
            </button>
            <Show when={sortOpen()}>
              <div
                id="canvas-sort-menu"
                class="entry-menu sort-menu"
                role="menu"
                aria-label="Sort canvases"
                ref={(element) =>
                  queueMicrotask(() =>
                    element.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(),
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === 'Tab') {
                    closeSort(true);
                    return;
                  }
                  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const buttons = [...event.currentTarget.querySelectorAll('button')];
                  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  const target =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? buttons.length - 1
                        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                          buttons.length;
                  buttons[target]?.focus();
                }}
              >
                <span class="menu-title">Sort by</span>
                <For
                  each={[
                    { value: 'recent', label: 'Recent changes' },
                    { value: 'name', label: 'Name (A–Z)' },
                  ]}
                >
                  {(option) => (
                    <button
                      role="menuitemradio"
                      aria-checked={sort() === option.value}
                      onClick={() => {
                        setSort(option.value);
                        closeSort(true);
                      }}
                    >
                      <span class="sort-check">
                        <Show when={sort() === option.value}>
                          <Check size={15} />
                        </Show>
                      </span>
                      {option.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
        <Show when={!listCollapsed() || search()} fallback={<div class="sidebar-fill" />}>
          <FileList
            rows={filteredRows()}
            active={activePath()}
            search={search()}
            menuPath={menu()?.entry.path}
            loaded={w.loaded()}
            selectedFolder={w.selectedFolder()}
            renaming={w.renaming()}
            renderRename={renderRename}
            onRename={(path) => startRename(path)}
            onMenu={openMenu}
            onOpen={(row) => {
              if (row.entry.kind === 'file') openBoard(row.entry.path);
              else
                void (async () => {
                  const target = await w.finishRename(row.entry.path);
                  if (!target) return;
                  w.setSelectedFolder(target);
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(target)) next.delete(target);
                    else next.add(target);
                    return next;
                  });
                })();
            }}
          />
        </Show>
        <Show when={w.prompt()?.mode === 'move' && w.prompt()}>
          {(prompt) => (
            <section class="organize-panel" aria-label="Move item">
              <div class="organize-heading">
                <span>
                  Move <strong title={prompt().path}>{title(prompt().path!)}</strong>
                </span>
                <button
                  class="icon-button"
                  aria-label="Cancel move"
                  disabled={w.busy()}
                  onClick={() => w.setPrompt(undefined)}
                >
                  <X size={15} />
                </button>
              </div>
              <form
                onSubmit={w.submitPrompt}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    modalClose(() => w.setPrompt(undefined));
                  }
                }}
              >
                <label>
                  Folder
                  <select
                    value={prompt().folder}
                    ref={(element) => queueMicrotask(() => element.focus())}
                    onChange={(e) => w.setPrompt({ ...prompt(), folder: e.currentTarget.value })}
                  >
                    <option value="">My canvases /</option>
                    <For
                      each={w
                        .folders()
                        .filter(
                          (e) =>
                            e.path !== prompt().path && !e.path.startsWith(`${prompt().path}/`),
                        )}
                    >
                      {(entry) => <option value={entry.path}>{entry.path}</option>}
                    </For>
                  </select>
                </label>
                <Show when={w.error()}>
                  <p class="form-error" role="alert">
                    {w.error()}
                  </p>
                </Show>
                <button
                  class="primary"
                  disabled={w.busy() || prompt().folder === parent(prompt().path!)}
                >
                  Move
                </button>
              </form>
            </section>
          )}
        </Show>
        <div class="destination">
          <Folder size={14} />
          <span title={w.selectedFolder() || 'My canvases'}>
            <small>Creating in</small>
            {w.selectedFolder() || 'My canvases'}
          </span>
          <Show when={w.selectedFolder()}>
            <button
              class="icon-button"
              aria-label="Create in root"
              title="Create in root"
              onClick={() => w.setSelectedFolder('')}
            >
              <X size={14} />
            </button>
          </Show>
        </div>
        <div class="sidebar-footer">
          <button
            class="footer-button"
            aria-label="Trash"
            title="Trash"
            onClick={w.showTrash}
            disabled={w.busy()}
          >
            <Trash2 size={17} />
            <span>Trash</span>
          </button>
          <button
            class="icon-button"
            aria-label="Import canvases"
            title="Import .excalidraw files"
            onClick={w.importFiles}
            disabled={w.busy()}
          >
            <ArrowUpFromLine size={17} />
          </button>
        </div>
      </aside>
      <main class="main-area" inert={mobile() && mobileOpen()}>
        <header class="topbar">
          <Show when={!sidebarVisible() || mobile()}>
            <button
              ref={toggleButton}
              class="icon-button explorer-toggle"
              aria-label="Open explorer"
              title="Show sidebar"
              aria-expanded={sidebarVisible()}
              aria-controls="canvas-explorer"
              onClick={toggleSidebar}
            >
              <PanelLeft size={19} />
            </button>
          </Show>
          <div class="document-title">
            <Show when={w.session()} fallback={<span class="empty-title">Excalidraws</span>}>
              {(session) => (
                <>
                  <Show when={parent(activePath())}>
                    <button
                      class="breadcrumb-parent"
                      aria-label={`Show folder ${parent(activePath())}`}
                      title={`Show ${parent(activePath())}`}
                      onClick={() => {
                        w.setSelectedFolder(parent(activePath()));
                        setSearch('');
                        setListCollapsed(false);
                        if (mobile()) setMobileOpen(true);
                        else setSidebarCollapsed(false);
                      }}
                    >
                      {parent(activePath())}
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
                            class="title-button"
                            aria-label={`Rename ${activeName()}`}
                            title="Click to rename"
                            onClick={() => startRename(activePath(), 'topbar')}
                            disabled={w.busy()}
                          >
                            {activeName()}
                          </button>
                        }
                      >
                        {renderRename()}
                      </Show>
                    </h1>
                    <Show when={!editingActiveIn('topbar')}>
                      <button
                        class="icon-button"
                        aria-label="Rename canvas"
                        data-name-transition
                        title="Rename canvas"
                        onClick={() => startRename(activePath(), 'topbar')}
                        disabled={w.busy()}
                      >
                        <Pencil size={14} />
                      </button>
                    </Show>
                  </div>
                </>
              )}
            </Show>
          </div>
          <Show when={w.session()}>
            {(session) => (
              <div class="document-tools">
                <span
                  class="save-status"
                  classList={{
                    problem: w.state().status === 'conflict' || w.state().status === 'offline',
                  }}
                  role="status"
                  title={w.state().message || statusLabels[w.state().status]}
                >
                  <Show
                    when={w.state().status === 'saved'}
                    fallback={<span class="state-dot dirty" />}
                  >
                    <Check size={14} />
                  </Show>
                  <span>{statusLabels[w.state().status]}</span>
                </span>
                <button
                  class="icon-button"
                  aria-label="Version history"
                  title="Version history"
                  onClick={w.showHistory}
                  disabled={w.busy()}
                >
                  <History size={17} />
                </button>
                <button
                  class="icon-button"
                  aria-label="Download canvas"
                  title="Download .excalidraw"
                  onClick={w.download}
                >
                  <ArrowDownToLine size={17} />
                </button>
              </div>
            )}
          </Show>
        </header>
        <Show when={w.error() && !w.prompt()}>
          <div class="notice error" role="alert">
            <span>{w.error()}</span>
            <button
              onClick={() => {
                w.setError('');
                w.refresh();
              }}
            >
              Retry
            </button>
            <button class="icon-button" aria-label="Dismiss error" onClick={() => w.setError('')}>
              <X size={16} />
            </button>
          </div>
        </Show>
        <Show when={w.state().localError}>
          <div class="notice warning" role="alert">
            Local draft unavailable. Keep this page open until the status shows “Saved”.
          </div>
        </Show>
        <Show
          when={w.session() && (w.state().status === 'conflict' || w.state().status === 'offline')}
        >
          <div class="notice warning" role="alert">
            <span>{w.state().message}</span>
            <Show
              when={w.state().status === 'offline'}
              fallback={<button onClick={() => w.setReloadConfirm(true)}>Load from server</button>}
            >
              <button onClick={() => void w.session()?.flush()}>Retry saving</button>
            </Show>
            <button onClick={() => ask('copy')}>Save a copy</button>
            <button onClick={w.download}>Download</button>
          </div>
        </Show>
        <div
          class="editor-area"
          classList={{ 'is-busy': w.busy() }}
          aria-busy={w.busy()}
          inert={w.busy()}
        >
          <Show
            when={w.session()}
            keyed
            fallback={
              <div class="empty-workspace">
                <p>{w.loaded() ? 'Open a canvas or create one.' : 'Loading workspace…'}</p>
                <Show when={w.loaded()}>
                  <button
                    class="primary"
                    data-name-transition
                    onClick={() => create('file')}
                    disabled={w.busy()}
                  >
                    <FilePlus2 size={16} />
                    Create canvas
                  </button>
                </Show>
              </div>
            }
          >
            {(session) => (
              <EditorSurface
                session={session}
                onImport={w.importFiles}
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
          <Show when={w.busy()}>
            <div class="processing" aria-label="Processing">
              {w.switchTarget() ? `Opening ${title(w.switchTarget())}…` : 'Working…'}
            </div>
          </Show>
        </div>
      </main>
      <Show when={menu()}>
        {(value) => (
          <div
            class="entry-menu"
            style={{ left: `${value().left}px`, top: `${value().top}px` }}
            role="group"
            aria-label="Canvas actions"
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
              e.preventDefault();
              const buttons = [...e.currentTarget.querySelectorAll('button')];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[
                (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
              ]?.focus();
            }}
            ref={(element) => queueMicrotask(() => element.querySelector('button')?.focus())}
          >
            <span class="menu-title">{title(value().entry.path)}</span>
            <button onClick={() => startRename(value().entry.path)}>
              <Pencil size={15} />
              Rename
            </button>
            <button onClick={() => ask('move', value().entry.path)}>
              <ArrowRight size={15} />
              Move to…
            </button>
            <Show when={value().entry.path === activePath()}>
              <button onClick={() => ask('copy')}>
                <FilePlus2 size={15} />
                Save a copy
              </button>
            </Show>
            <button
              class="danger-text"
              onClick={() => {
                w.setDeleting(value().entry);
                closeMenu();
              }}
            >
              <Trash2 size={15} />
              Move to trash
            </button>
          </div>
        )}
      </Show>
      <Show when={w.prompt()?.mode === 'copy' && w.prompt()}>
        {(prompt) => (
          <Modal
            title={
              {
                move: 'Move to another folder',
                copy: 'Save a copy',
              }[prompt().mode]
            }
            onClose={() => modalClose(() => w.setPrompt(undefined))}
          >
            <form onSubmit={w.submitPrompt}>
              <Show when={prompt().mode !== 'move'}>
                <label>
                  Name
                  <input
                    autofocus
                    required
                    maxLength={160}
                    value={prompt().name}
                    onInput={(e) => w.setPrompt({ ...prompt(), name: e.currentTarget.value })}
                  />
                </label>
              </Show>
              <label>
                Folder
                <select
                  autofocus={prompt().mode === 'move'}
                  value={prompt().folder}
                  onChange={(e) => w.setPrompt({ ...prompt(), folder: e.currentTarget.value })}
                >
                  <option value="">My canvases /</option>
                  <For
                    each={w
                      .folders()
                      .filter(
                        (e) =>
                          prompt().mode !== 'move' ||
                          (e.path !== prompt().path && !e.path.startsWith(`${prompt().path}/`)),
                      )}
                  >
                    {(entry) => <option value={entry.path}>{entry.path}</option>}
                  </For>
                </select>
              </label>
              <Show when={prompt().mode === 'copy'}>
                <p class="dialog-help">
                  Saves the current drawing as a new file and keeps the server version intact.
                </p>
              </Show>
              <Show when={w.error()}>
                <p class="form-error" role="alert">
                  {w.error()}
                </p>
              </Show>
              <div class="dialog-actions">
                <button type="button" disabled={w.busy()} onClick={() => w.setPrompt(undefined)}>
                  Cancel
                </button>
                <button
                  class="primary"
                  disabled={w.busy() || (prompt().mode !== 'move' && !prompt().name.trim())}
                >
                  {prompt().mode === 'move' ? 'Move' : 'Save copy'}
                </button>
              </div>
            </form>
          </Modal>
        )}
      </Show>
      <Show when={w.deleting()}>
        {(entry) => (
          <Modal title="Move to trash" onClose={() => modalClose(() => w.setDeleting(undefined))}>
            <p>
              Move “{title(entry().path)}”{entry().kind === 'folder' ? ' and its contents' : ''} to
              the trash? You can restore it later.
            </p>
            <div class="dialog-actions">
              <button disabled={w.busy()} onClick={() => w.setDeleting(undefined)}>
                Cancel
              </button>
              <button class="danger-button" disabled={w.busy()} onClick={w.deleteEntry}>
                Move to trash
              </button>
            </div>
          </Modal>
        )}
      </Show>
      <Show when={w.trash()}>
        {(items) => (
          <Modal title="Trash" onClose={() => modalClose(() => w.setTrash(undefined))}>
            <div class="version-list">
              <Show when={items().length} fallback={<p>The trash is empty.</p>}>
                <For each={items()}>
                  {(item) => (
                    <div class="version-row">
                      <div>
                        <strong>{item.path}</strong>
                        <small>{displayDate(item.deleted)}</small>
                      </div>
                      <button
                        disabled={w.busy()}
                        aria-label={`Restore ${title(item.path)}`}
                        onClick={() => w.restoreTrash(item.id)}
                      >
                        Restore
                      </button>
                    </div>
                  )}
                </For>
              </Show>
            </div>
            <Show when={w.error()}>
              <p class="form-error">{w.error()}</p>
            </Show>
          </Modal>
        )}
      </Show>
      <Show when={w.history()}>
        {(items) => (
          <Modal title="Version history" onClose={() => modalClose(() => w.setHistory(undefined))}>
            <p class="dialog-help">Up to 20 previous versions. Restoring creates a new canvas.</p>
            <div class="version-list">
              <Show when={items().length} fallback={<p>There are no previous versions yet.</p>}>
                <For each={items()}>
                  {(item) => (
                    <div class="version-row">
                      <div>
                        <strong>{displayDate(item.modified)}</strong>
                        <small>{item.revision.slice(0, 10)}</small>
                      </div>
                      <button disabled={w.busy()} onClick={() => w.restoreHistory(item.revision)}>
                        Restore a copy
                      </button>
                    </div>
                  )}
                </For>
              </Show>
            </div>
            <Show when={w.error()}>
              <p class="form-error">{w.error()}</p>
            </Show>
          </Modal>
        )}
      </Show>
      <Show when={w.reloadConfirm()}>
        <Modal
          title="Load the server version"
          onClose={() => modalClose(() => w.setReloadConfirm(false))}
        >
          <p>
            This replaces the open drawing. Save a copy or download it first to keep your local
            changes.
          </p>
          <div class="dialog-actions">
            <button
              disabled={w.busy()}
              onClick={() => {
                w.setReloadConfirm(false);
                ask('copy');
              }}
            >
              Save a copy first
            </button>
            <button class="danger-button" disabled={w.busy()} onClick={w.reload}>
              Load from server
            </button>
          </div>
          <Show when={w.error()}>
            <p class="form-error">{w.error()}</p>
          </Show>
        </Modal>
      </Show>
    </div>
  );
}
