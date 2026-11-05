import type { Entry } from '../../shared/model';
import {
  EXTENSION,
  ancestorCanvases,
  canvasName,
  childFolder,
  folderCanvas,
  folderOf,
  inCanvas,
  outermost,
  parentCanvas,
} from '../../shared/canvas';

export { ancestorCanvases, childFolder, folderCanvas, inCanvas, parentCanvas };

// Library metadata fields are optional so the UI also renders entries from older servers.
export type LibraryEntry = Entry & {
  favorite?: boolean;
  archived?: boolean;
  archiveRoot?: string;
  order?: number;
};
export type SortMode = 'recent' | 'name' | 'custom';
export type View = 'library' | 'favorites' | 'archive' | 'trash';
export interface Row {
  entry: LibraryEntry;
  depth: number;
  /** The canvas has canvases inside it in this view, and they are shown. */
  expanded: boolean;
  /** The canvas has canvases inside it in this view, shown or not. */
  expandable: boolean;
  /** Number of canvases directly inside it that this view can show. */
  inside: number;
  posinset: number;
  setsize: number;
  /** Flat rows (search, favorites) show their location instead of an indented position. */
  flat: boolean;
}

export const basename = (path: string) => path.split('/').at(-1) ?? path;
/** The content folder that contains a canvas: siblings share it. '' is the top level. */
export const parentOf = folderOf;
export const displayName = (entry: Pick<Entry, 'path'>) => canvasName(entry.path);
export const pathTitle = canvasName;
/** Name of the canvas that owns a content folder; the top level is the Library. */
export const folderLabel = (folder: string) => (folder ? basename(folder) : 'Library');
/** Names of the canvases that contain `path`, outermost first, such as `Ideas / Idea B`. */
export const locationLabel = (path: string) =>
  ancestorCanvases(path)
    .reverse()
    .map((canvas) => canvasName(canvas))
    .join(' / ');
export const ancestors = ancestorCanvases;
export const renamedPath = (entry: Pick<Entry, 'path'>, name: string) => {
  const trimmed = name.trim();
  const leaf = trimmed.endsWith(EXTENSION) ? trimmed : `${trimmed}${EXTENSION}`;
  const folder = folderOf(entry.path);
  return folder ? `${folder}/${leaf}` : leaf;
};
/** Keeps only outermost canvases: moving or trashing a canvas includes its contents. */
export const topLevel = (paths: Iterable<string>) => outermost(paths);

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byName = (a: LibraryEntry, b: LibraryEntry) =>
  collator.compare(displayName(a), displayName(b)) || (a.path < b.path ? -1 : 1);
export const compareEntries =
  (sort: SortMode) =>
  (a: LibraryEntry, b: LibraryEntry): number => {
    if (sort === 'custom') {
      const ao = a.order ?? Number.POSITIVE_INFINITY;
      const bo = b.order ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao < bo ? -1 : 1;
      return byName(a, b);
    }
    if (sort === 'recent' && a.modified !== b.modified) return a.modified < b.modified ? 1 : -1;
    return byName(a, b);
  };

const childrenOf = (entries: LibraryEntry[]) => {
  const children = new Map<string, LibraryEntry[]>();
  for (const entry of entries) {
    const key = folderOf(entry.path);
    const group = children.get(key);
    if (group) group.push(entry);
    else children.set(key, [entry]);
  }
  return children;
};

/** Every canvas directly inside a content folder in custom order, archived ones included. */
export const siblingOrder = (entries: LibraryEntry[], folder: string) =>
  entries
    .filter((entry) => folderOf(entry.path) === folder)
    .sort(compareEntries('custom'))
    .map((entry) => entry.path);

/** Moves `moving` before or after `target`; undefined when nothing would change. */
export const insertRelative = (
  siblings: string[],
  moving: string[],
  target: string,
  where: 'before' | 'after',
) => {
  if (moving.includes(target)) return undefined;
  const rest = siblings.filter((path) => !moving.includes(path));
  const index = rest.indexOf(target);
  if (index < 0) return undefined;
  rest.splice(where === 'before' ? index : index + 1, 0, ...moving);
  return rest.join('\n') === siblings.join('\n') ? undefined : rest;
};

export function buildRows(options: {
  entries: LibraryEntry[];
  view: View;
  sort: SortMode;
  collapsed: ReadonlySet<string>;
  query: string;
}): Row[] {
  const { entries, view, sort, collapsed } = options;
  const compare = compareEntries(sort);
  const query = options.query.trim().toLocaleLowerCase();
  const flat = (list: LibraryEntry[], comparator = compare) =>
    list.sort(comparator).map((entry, index, all) => ({
      entry,
      depth: 0,
      expanded: false,
      expandable: false,
      inside: entry.children,
      posinset: index + 1,
      setsize: all.length,
      flat: true,
    }));
  // Search spans the whole library, archived items included, but never the trash.
  if (query) {
    const rank = (entry: LibraryEntry) => {
      const name = displayName(entry).toLocaleLowerCase();
      if (name === query) return 0;
      if (name.startsWith(query)) return 1;
      if (name.includes(query)) return 2;
      return 3;
    };
    return flat(
      entries.filter((entry) => childFolder(entry.path).toLocaleLowerCase().includes(query)),
      (a, b) => rank(a) - rank(b) || compare(a, b),
    );
  }
  if (view === 'trash') return [];
  // Archived items leave the library views; they stay reachable from Archive and search.
  if (view === 'favorites')
    return flat(entries.filter((entry) => entry.favorite && !entry.archived));

  const children = childrenOf(entries);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  let roots: LibraryEntry[];
  let include: (entry: LibraryEntry) => boolean;
  if (view === 'archive') {
    // Explicitly archived canvases whose parent is not itself archived, with their contents.
    roots = entries.filter(
      (entry) =>
        entry.archived &&
        (entry.archiveRoot ?? entry.path) === entry.path &&
        !byPath.get(parentCanvas(entry.path))?.archived,
    );
    include = () => true;
  } else {
    include = (entry) => !entry.archived;
    roots = (children.get('') ?? []).filter(include);
  }
  const rows: Row[] = [];
  const visit = (list: LibraryEntry[], depth: number) => {
    const sorted = list.sort(compare);
    sorted.forEach((entry, index) => {
      const inside = (children.get(childFolder(entry.path)) ?? []).filter(include);
      const expandable = inside.length > 0;
      const expanded = expandable && !collapsed.has(entry.path);
      rows.push({
        entry,
        depth,
        expanded,
        expandable,
        inside: inside.length,
        posinset: index + 1,
        setsize: sorted.length,
        flat: false,
      });
      if (expanded) visit(inside, depth + 1);
    });
  };
  visit(roots, 0);
  return rows;
}

/** True when the canvas `path` is `root` or inside it. */
export const isInside = (path: string, root: string) => inCanvas(path, root);

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
