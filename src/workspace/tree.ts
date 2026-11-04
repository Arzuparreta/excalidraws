import type { Entry } from '../../shared/model';

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
  expanded: boolean;
  posinset: number;
  setsize: number;
  /** Flat rows (search, favorites) show their folder instead of an indented position. */
  flat: boolean;
}

export const basename = (path: string) => path.split('/').at(-1) ?? path;
export const parentOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const displayName = (entry: Pick<Entry, 'path' | 'kind'>) =>
  entry.kind === 'folder'
    ? basename(entry.path)
    : basename(entry.path).replace(/\.excalidraw$/, '');
export const pathTitle = (path: string) => basename(path).replace(/\.excalidraw$/, '');
export const folderLabel = (folder: string) => (folder ? basename(folder) : 'Library');
export const isInside = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`);
export const ancestors = (path: string) => {
  const result: string[] = [];
  for (let current = parentOf(path); current; current = parentOf(current)) result.push(current);
  return result;
};
export const renamedPath = (entry: Pick<Entry, 'path' | 'kind'>, name: string) => {
  const trimmed = name.trim();
  const leaf =
    entry.kind === 'file' && !trimmed.endsWith('.excalidraw') ? `${trimmed}.excalidraw` : trimmed;
  const folder = parentOf(entry.path);
  return folder ? `${folder}/${leaf}` : leaf;
};
/** Keeps only top-level paths: moving or trashing a folder already includes its contents. */
export const topLevel = (paths: Iterable<string>) => {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const result: string[] = [];
  for (const path of sorted)
    if (!result.some((kept) => path.startsWith(`${kept}/`))) result.push(path);
  return result;
};

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
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    if (sort === 'recent' && a.kind === 'file' && a.modified !== b.modified)
      return a.modified < b.modified ? 1 : -1;
    return byName(a, b);
  };

const childrenOf = (entries: LibraryEntry[]) => {
  const children = new Map<string, LibraryEntry[]>();
  for (const entry of entries) {
    const key = parentOf(entry.path);
    const group = children.get(key);
    if (group) group.push(entry);
    else children.set(key, [entry]);
  }
  return children;
};

/** Every sibling in custom order, including archived ones, as the order endpoint expects. */
export const siblingOrder = (entries: LibraryEntry[], folder: string) =>
  entries
    .filter((entry) => parentOf(entry.path) === folder)
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
      entries.filter((entry) =>
        (entry.kind === 'file' ? entry.path.replace(/\.excalidraw$/, '') : entry.path)
          .toLocaleLowerCase()
          .includes(query),
      ),
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
    // Explicitly archived items whose parent is not itself archived; folders keep their subtree.
    roots = entries.filter(
      (entry) =>
        entry.archived &&
        (entry.archiveRoot ?? entry.path) === entry.path &&
        !byPath.get(parentOf(entry.path))?.archived,
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
      const expanded = entry.kind === 'folder' && !collapsed.has(entry.path);
      rows.push({
        entry,
        depth,
        expanded,
        posinset: index + 1,
        setsize: sorted.length,
        flat: false,
      });
      if (expanded) visit((children.get(entry.path) ?? []).filter(include), depth + 1);
    });
  };
  visit(roots, 0);
  return rows;
}

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
