import {
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
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileText,
  Link2,
  LoaderCircle,
  Plus,
  Star,
} from 'lucide-solid';
import {
  childFolder,
  displayName,
  folderCanvas,
  folderLabel,
  isInside,
  locationLabel,
  parentOf,
  type Row,
} from './tree';

/**
 * `into` moves into the canvas that owns `folder` ('' is the top level). `before` and
 * `after` place beside a canvas. `link` adds links to the open canvas at a viewport point.
 */
export type DropTarget =
  | { kind: 'into'; folder: string }
  | { kind: 'before' | 'after'; path: string }
  | { kind: 'link'; x: number; y: number };
export interface TreeApi {
  /** Scrolls a row into view and focuses it, rendering it first if it is offscreen. */
  focus(path?: string, scroll?: boolean): void;
  reveal(path: string): void;
}
type Point = { x: number; y: number };

const EDGE = 40;
const HOVER_EXPAND_MS = 650;

/**
 * Virtualized tree. Rows are absolutely positioned so the focused, renamed and dragged rows
 * stay rendered when they scroll out of the window; keyboard access never depends on what
 * happens to be painted. Inner buttons are pointer affordances; the treeitem owns focus.
 */
export function CanvasTree(props: {
  rows: Row[];
  label: string;
  /** Scroll returns to the top whenever this changes (view or search). */
  resetKey: string;
  rowHeight: number;
  currentPath: string;
  selected: ReadonlySet<string>;
  selecting: boolean;
  pending: ReadonlySet<string>;
  menuPath?: string;
  renamingPath?: string;
  draft?: { path: string; name: string };
  renameError: boolean;
  renderRename(): JSX.Element;
  focusPath?: string;
  onFocusPath(path: string): void;
  canCreate: boolean;
  favoriteBadges: boolean;
  reorderable: boolean;
  draggable: boolean;
  empty: JSX.Element;
  onRowClick(row: Row, event: MouseEvent): void;
  onActivate(row: Row): void;
  onToggle(path: string, expanded: boolean): void;
  onSelectToggle(path: string): void;
  onSelectRange(from: string, to: string): void;
  onSelectAll(): void;
  onClearSelection(): boolean;
  onMenu(path: string, anchor: HTMLElement, point?: Point): void;
  onCreateMenu(path: string, anchor: HTMLElement): void;
  onRename(path: string): void;
  onTrash(path: string): void;
  onReorder(path: string, delta: -1 | 1): void;
  dragPaths(path: string): string[];
  onDrop(paths: string[], target: DropTarget): void;
  /** Whether dropping these canvases at a viewport point outside the list links them. */
  canLink?(paths: string[], point: Point): boolean;
  ref?(api: TreeApi): void;
}) {
  let scroller!: HTMLDivElement;
  const [scroll, setScroll] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const [drag, setDrag] = createSignal<{ paths: string[]; label: string }>();
  const [dragPoint, setDragPoint] = createSignal<Point>({ x: 0, y: 0 });
  const [dropTarget, setDropTarget] = createSignal<DropTarget>();
  const index = createMemo(() => new Map(props.rows.map((row, i) => [row.entry.path, i])));
  const byPath = createMemo(() => new Map(props.rows.map((row) => [row.entry.path, row])));
  const tabStop = createMemo(() => {
    const map = index();
    for (const path of [props.focusPath, props.currentPath]) if (path && map.has(path)) return path;
    return props.rows[0]?.entry.path;
  });
  const visible = createMemo(() => {
    const h = props.rowHeight;
    const count = props.rows.length;
    const start = Math.max(0, Math.floor(scroll() / h) - 8);
    const end = Math.min(count, Math.ceil((scroll() + height()) / h) + 8);
    const keep = new Set<number>();
    for (let i = start; i < end; i++) keep.add(i);
    for (const path of [tabStop(), props.renamingPath, ...(drag()?.paths ?? [])]) {
      const i = path === undefined ? undefined : index().get(path);
      if (i !== undefined) keep.add(i);
    }
    return [...keep].sort((a, b) => a - b).map((i) => props.rows[i]!.entry.path);
  });
  const rowElement = (path: string) =>
    scroller.querySelector<HTMLElement>(`[data-entry-path="${CSS.escape(path)}"]`);
  const reveal = (path: string) => {
    const i = index().get(path);
    if (i === undefined || !scroller) return;
    const top = i * props.rowHeight;
    const bottom =
      top + props.rowHeight + (props.renamingPath === path && props.renameError ? 70 : 0);
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight)
      scroller.scrollTop = bottom - scroller.clientHeight;
    setScroll(scroller.scrollTop);
  };
  const focusRow = (path: string, scroll = true) => {
    props.onFocusPath(path);
    if (scroll) reveal(path);
    queueMicrotask(() => rowElement(path)?.focus({ preventScroll: true }));
  };

  let typed = '';
  let typedTimer: ReturnType<typeof setTimeout> | undefined;
  const typeahead = (key: string, from: number) => {
    typed += key.toLocaleLowerCase();
    clearTimeout(typedTimer);
    typedTimer = setTimeout(() => (typed = ''), 600);
    const rows = props.rows;
    const offset = typed.length === 1 ? 1 : 0;
    for (let k = 0; k < rows.length; k++) {
      const row = rows[(from + offset + k) % rows.length]!;
      if (displayName(row.entry).toLocaleLowerCase().startsWith(typed)) {
        focusRow(row.entry.path);
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const element = event.target as HTMLElement;
    if (element.closest('.inline-name')) return;
    const rowEl = element.closest<HTMLElement>('[data-entry-path]');
    const path = rowEl?.dataset.entryPath;
    const row = path === undefined ? undefined : byPath().get(path);
    if (!rowEl || !row || path === undefined) return;
    const rows = props.rows;
    const i = index().get(path) ?? 0;
    const go = (j: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (!next) return;
      focusRow(next.entry.path);
      if (event.shiftKey) props.onSelectRange(path, next.entry.path);
    };
    const key = event.key;
    if (event.altKey) {
      if ((key === 'ArrowUp' || key === 'ArrowDown') && props.reorderable && !row.flat) {
        event.preventDefault();
        props.onReorder(path, key === 'ArrowUp' ? -1 : 1);
      }
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      if (key.toLowerCase() === 'a') {
        event.preventDefault();
        props.onSelectAll();
      }
      return;
    }
    const page = Math.max(1, Math.floor(height() / props.rowHeight) - 1);
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (key) {
      case 'ArrowDown':
        handled();
        return go(i + 1);
      case 'ArrowUp':
        handled();
        return go(i - 1);
      case 'PageDown':
        handled();
        return go(i + page);
      case 'PageUp':
        handled();
        return go(i - page);
      case 'Home':
        handled();
        return go(0);
      case 'End':
        handled();
        return go(rows.length - 1);
      case 'ArrowRight':
        handled();
        if (!row.expandable || row.flat) return;
        if (!row.expanded) props.onToggle(path, true);
        else if ((rows[i + 1]?.depth ?? -1) > row.depth) focusRow(rows[i + 1]!.entry.path);
        return;
      case 'ArrowLeft': {
        handled();
        if (row.expandable && row.expanded && !row.flat) return props.onToggle(path, false);
        for (let j = i - 1; j >= 0; j--)
          if (rows[j]!.depth < row.depth) return focusRow(rows[j]!.entry.path);
        return;
      }
      case 'Enter':
        handled();
        return props.onActivate(row);
      case ' ':
        handled();
        return props.onSelectToggle(path);
      case 'F2':
        handled();
        return props.onRename(path);
      case 'ContextMenu':
        handled();
        return props.onMenu(path, rowEl);
      case 'F10':
        if (event.shiftKey) {
          handled();
          props.onMenu(path, rowEl);
        }
        return;
      case 'Delete':
        handled();
        return props.onTrash(path);
      case 'Escape':
        if (props.onClearSelection()) handled();
        return;
      default:
        if (key.length === 1 && key !== ' ' && !event.shiftKey) {
          handled();
          typeahead(key, i);
        } else if (key.length === 1 && event.shiftKey && /\p{L}|\p{N}/u.test(key)) {
          handled();
          typeahead(key, i);
        }
    }
  };

  // Desktop pointer drag. Touch and pen use the picker and explicit buttons instead.
  let pressed: { path: string; x: number; y: number; id: number } | undefined;
  let suppressClick = false;
  let point: Point = { x: 0, y: 0 };
  let scrollFrame = 0;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverFolder: string | undefined;
  const validTarget = (paths: string[], target: DropTarget): DropTarget | undefined => {
    if (target.kind === 'link') return target;
    if (target.kind === 'into') {
      if (paths.some((path) => isInside(folderCanvas(target.folder), path))) return undefined;
      if (paths.every((path) => parentOf(path) === target.folder)) return undefined;
      return target;
    }
    if (paths.some((path) => isInside(target.path, path))) return undefined;
    return target;
  };
  const hoverExpand = (target: DropTarget | undefined) => {
    const folder = target?.kind === 'into' ? target.folder : undefined;
    if (folder === hoverFolder) return;
    clearTimeout(hoverTimer);
    hoverFolder = folder;
    const canvas = folder ? folderCanvas(folder) : '';
    const row = canvas ? byPath().get(canvas) : undefined;
    if (!folder || !row || !row.expandable || row.expanded || row.flat) return;
    hoverTimer = setTimeout(() => {
      if (drag() && hoverFolder === folder) props.onToggle(canvas, true);
    }, HOVER_EXPAND_MS);
  };
  const updateTarget = () => {
    const current = drag();
    if (!current) return;
    const bounds = scroller.getBoundingClientRect();
    let target: DropTarget | undefined;
    if (
      point.x >= bounds.left &&
      point.x <= bounds.right &&
      point.y >= bounds.top &&
      point.y <= bounds.bottom
    ) {
      const rowEl = document
        .elementFromPoint(point.x, point.y)
        ?.closest<HTMLElement>('[data-entry-path]');
      const row =
        rowEl && scroller.contains(rowEl) ? byPath().get(rowEl.dataset.entryPath!) : undefined;
      if (!row || !rowEl) target = { kind: 'into', folder: '' };
      else {
        const rect = rowEl.getBoundingClientRect();
        const ratio = (point.y - rect.top) / rect.height;
        const path = row.entry.path;
        // The middle of a row moves into that canvas; its edges place beside it.
        if (props.reorderable && !(ratio > 0.28 && (ratio < 0.72 || row.expanded)))
          target = { kind: ratio < 0.5 ? 'before' : 'after', path };
        else target = { kind: 'into', folder: childFolder(path) };
      }
    } else if (props.canLink?.(current.paths, point))
      target = { kind: 'link', x: point.x, y: point.y };
    target = target && validTarget(current.paths, target);
    setDropTarget(target);
    hoverExpand(target);
  };
  const autoScroll = () => {
    if (!drag()) return;
    const bounds = scroller.getBoundingClientRect();
    let delta = 0;
    if (point.y < bounds.top + EDGE)
      delta = -Math.min(20, Math.ceil((bounds.top + EDGE - point.y) / 3));
    else if (point.y > bounds.bottom - EDGE)
      delta = Math.min(20, Math.ceil((point.y - (bounds.bottom - EDGE)) / 3));
    if (delta) {
      scroller.scrollTop += delta;
      setScroll(scroller.scrollTop);
      updateTarget();
    }
    scrollFrame = requestAnimationFrame(autoScroll);
  };
  const endDrag = () => {
    cancelAnimationFrame(scrollFrame);
    clearTimeout(hoverTimer);
    hoverFolder = undefined;
    setDrag(undefined);
    setDropTarget(undefined);
    document.removeEventListener('keydown', dragKey, true);
  };
  const dragKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    pressed = undefined;
    endDrag();
  };
  const pointerDown = (event: PointerEvent) => {
    if (!props.draggable || event.button !== 0 || event.pointerType !== 'mouse') return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    const element = event.target as Element;
    if (element.closest('.row-action, .inline-name, input')) return;
    const path = element.closest<HTMLElement>('[data-entry-path]')?.dataset.entryPath;
    if (path === undefined || path === props.renamingPath) return;
    pressed = { path, x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const pointerMove = (event: PointerEvent) => {
    if (!pressed || event.pointerId !== pressed.id) return;
    point = { x: event.clientX, y: event.clientY };
    if (!drag()) {
      if (Math.hypot(point.x - pressed.x, point.y - pressed.y) < 6) return;
      const paths = props.dragPaths(pressed.path);
      const first = byPath().get(paths[0] ?? '');
      setDrag({
        paths,
        label: paths.length === 1 && first ? displayName(first.entry) : `${paths.length} items`,
      });
      try {
        scroller.setPointerCapture(pressed.id);
      } catch {
        /* The pointer may already be released. */
      }
      document.addEventListener('keydown', dragKey, true);
      scrollFrame = requestAnimationFrame(autoScroll);
    }
    setDragPoint(point);
    updateTarget();
  };
  const pointerUp = (event: PointerEvent) => {
    if (!pressed || event.pointerId !== pressed.id) return;
    pressed = undefined;
    const current = drag();
    if (!current) return;
    const target = dropTarget();
    endDrag();
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    if (target) props.onDrop(current.paths, target);
  };
  const pointerCancel = () => {
    pressed = undefined;
    if (drag()) endDrag();
  };
  const isTarget = (path: string, kind: DropTarget['kind']) => {
    const target = dropTarget();
    if (!target || target.kind !== kind) return false;
    if (target.kind === 'link') return false;
    return target.kind === 'into' ? target.folder === childFolder(path) : target.path === path;
  };

  createEffect(
    on(
      () => props.resetKey,
      () => {
        scroller.scrollTop = 0;
        setScroll(0);
      },
      { defer: true },
    ),
  );
  onMount(() => {
    const resize = new ResizeObserver(() => setHeight(scroller.clientHeight));
    resize.observe(scroller);
    const click = (event: MouseEvent) => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
    };
    scroller.addEventListener('click', click, true);
    props.ref?.({
      focus: (path, scroll = true) =>
        queueMicrotask(() => {
          const target = path && index().has(path) ? path : tabStop();
          if (target !== undefined) focusRow(target, scroll);
        }),
      reveal: (path) => queueMicrotask(() => reveal(path)),
    });
    onCleanup(() => {
      resize.disconnect();
      scroller.removeEventListener('click', click, true);
      endDrag();
      clearTimeout(typedTimer);
    });
  });

  const TreeRow = (rowProps: { path: string }) => {
    const row = () => byPath().get(rowProps.path);
    return (
      <Show when={row()}>
        {(current) => {
          const path = rowProps.path;
          const entry = () => current().entry;
          const name = () => (props.draft?.path === path ? props.draft.name : displayName(entry()));
          const expandable = () => current().expandable && !current().flat;
          const selected = () => props.selected.has(path);
          const count = () => current().inside;
          const label = () =>
            [
              name(),
              count() ? `${count()} ${count() === 1 ? 'canvas' : 'canvases'} inside` : '',
              current().flat && entry().archived ? 'archived' : '',
              current().flat ? `in ${folderLabel(parentOf(path))}` : '',
            ]
              .filter(Boolean)
              .join(', ');
          return (
            <div
              class="file-row"
              role="treeitem"
              data-entry-path={path}
              tabIndex={tabStop() === path ? 0 : -1}
              aria-label={label()}
              aria-level={current().depth + 1}
              aria-posinset={current().posinset}
              aria-setsize={current().setsize}
              aria-expanded={expandable() ? current().expanded : undefined}
              aria-selected={selected()}
              aria-current={props.currentPath === path ? 'page' : undefined}
              aria-busy={props.pending.has(path) || undefined}
              classList={{
                'has-inside': count() > 0,
                'is-current': props.currentPath === path,
                'is-selected': selected(),
                'is-pending': props.pending.has(path),
                'is-renaming': props.renamingPath === path,
                'is-dragging': !!drag()?.paths.includes(path),
                'drop-into': isTarget(path, 'into'),
                'drop-before': isTarget(path, 'before'),
                'drop-after': isTarget(path, 'after'),
              }}
              style={{
                top: `${(index().get(path) ?? 0) * props.rowHeight}px`,
                height: `${props.rowHeight}px`,
                '--depth': String(Math.min(current().depth, 8)),
              }}
              onClick={(event) => {
                if ((event.target as Element).closest('.row-action, .inline-name')) return;
                props.onRowClick(current(), event);
              }}
              onContextMenu={(event) => {
                if ((event.target as Element).closest('.inline-name')) return;
                event.preventDefault();
                props.onMenu(path, event.currentTarget, { x: event.clientX, y: event.clientY });
              }}
            >
              <span
                class="row-twisty"
                classList={{ 'row-action': expandable() }}
                aria-hidden="true"
                onClick={(event) => {
                  if (!expandable()) return;
                  // Toggling replaces the SVG target before the delegated row handler runs.
                  event.stopPropagation();
                  props.onToggle(path, !current().expanded);
                }}
              >
                <Show when={expandable()}>
                  <Show when={current().expanded} fallback={<ChevronRight size={14} />}>
                    <ChevronDown size={14} />
                  </Show>
                </Show>
              </span>
              {/* While selecting, the checkbox takes the icon's place so names do not shift. */}
              <span class="row-icon" aria-hidden="true">
                <Show
                  when={!props.selecting}
                  fallback={
                    <span class="row-check" classList={{ checked: selected() }}>
                      <Show when={selected()}>
                        <Check size={12} stroke-width={3} />
                      </Show>
                    </span>
                  }
                >
                  <FileText size={15} />
                </Show>
              </span>
              <div class="file-name-slot">
                <Show
                  when={props.renamingPath === path}
                  fallback={
                    <button class="file-select" type="button" tabIndex={-1} title={path}>
                      <span class="file-name">{name()}</span>
                    </button>
                  }
                >
                  {props.renderRename()}
                </Show>
              </div>
              <Show when={current().flat && parentOf(path)}>
                <span class="file-parent" aria-hidden="true">
                  {locationLabel(path)}
                </span>
              </Show>
              <Show when={current().flat && entry().archived}>
                <span class="badge" aria-hidden="true">
                  Archived
                </span>
              </Show>
              <Show when={props.favoriteBadges && entry().favorite}>
                <span class="row-star" aria-hidden="true" title="Favorite">
                  <Star size={12} />
                </span>
              </Show>
              <Show when={props.pending.has(path)}>
                <span class="row-pending" aria-hidden="true">
                  <LoaderCircle size={14} />
                </span>
              </Show>
              <Show when={count() > 0}>
                <span class="row-count" aria-hidden="true">
                  {count()}
                </span>
              </Show>
              <Show when={props.canCreate && !current().flat && !entry().archived}>
                <button
                  class="icon-button row-action row-create"
                  type="button"
                  tabIndex={-1}
                  data-menu-trigger
                  aria-label={`New inside ${name()}`}
                  title="New canvas inside"
                  aria-haspopup="menu"
                  onClick={(event) => props.onCreateMenu(path, event.currentTarget)}
                >
                  <Plus size={15} />
                </button>
              </Show>
              <button
                class="icon-button row-action row-menu"
                type="button"
                tabIndex={-1}
                data-menu-trigger
                aria-label={`Actions for ${name()}`}
                title="Actions"
                aria-haspopup="menu"
                aria-expanded={props.menuPath === path}
                onClick={(event) => props.onMenu(path, event.currentTarget)}
              >
                <Ellipsis size={16} />
              </button>
            </div>
          );
        }}
      </Show>
    );
  };

  return (
    <div
      ref={scroller}
      class="file-list"
      classList={{
        'is-dragging': !!drag(),
        'is-linking': dropTarget()?.kind === 'link',
        'is-selecting': props.selecting,
        'drop-root':
          dropTarget()?.kind === 'into' && (dropTarget() as { folder: string }).folder === '',
      }}
      data-popover-clip
      onScroll={() => setScroll(scroller.scrollTop)}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerCancel}
      onLostPointerCapture={pointerCancel}
    >
      <Show when={props.rows.length} fallback={props.empty}>
        <div
          class="tree"
          role="tree"
          aria-label={props.label}
          aria-multiselectable="true"
          style={{
            height: `${props.rows.length * props.rowHeight + (props.renameError ? 70 : 0)}px`,
          }}
          onKeyDown={onKeyDown}
          onFocusIn={(event) => {
            const path = (event.target as Element).closest<HTMLElement>('[data-entry-path]')
              ?.dataset.entryPath;
            if (path !== undefined && path !== props.focusPath) props.onFocusPath(path);
          }}
        >
          <For each={visible()}>{(path) => <TreeRow path={path} />}</For>
        </div>
      </Show>
      <Show when={drag()}>
        {(current) => (
          <div
            class="drag-ghost"
            aria-hidden="true"
            style={{ left: `${dragPoint().x + 14}px`, top: `${dragPoint().y + 12}px` }}
          >
            {current().label}
            <Show when={dropTarget()?.kind === 'into'}>
              <small>to {folderLabel((dropTarget() as { folder: string }).folder)}</small>
            </Show>
            <Show when={dropTarget()?.kind === 'link'}>
              <small class="drag-link">
                <Link2 size={12} aria-hidden="true" />
                Link in this canvas
              </small>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
