import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, topLevel, type LibraryEntry } from '../src/workspace/tree';

const entry = (
  path: string,
  kind: 'file' | 'folder' = 'file',
  flags: Partial<LibraryEntry> = {},
): LibraryEntry => ({ path, kind, modified: '2026-11-04T12:00:00Z', ...flags });

test('the library keeps hierarchy, hides archived subtrees, and exposes their search results', () => {
  const entries = [
    entry('Projects', 'folder'),
    entry('Projects/Current.excalidraw', 'file', { favorite: true }),
    entry('Projects/Old', 'folder', { archived: true, archiveRoot: 'Projects/Old' }),
    entry('Projects/Old/Plan.excalidraw', 'file', {
      archived: true,
      archiveRoot: 'Projects/Old',
      favorite: true,
    }),
  ];
  const rows = (view: 'library' | 'favorites' | 'archive', query = '') =>
    buildRows({ entries, view, query, sort: 'name', collapsed: new Set() });
  assert.deepEqual(
    rows('library').map((row) => [row.entry.path, row.depth]),
    [
      ['Projects', 0],
      ['Projects/Current.excalidraw', 1],
    ],
  );
  assert.deepEqual(
    rows('favorites').map((row) => row.entry.path),
    ['Projects/Current.excalidraw'],
  );
  assert.deepEqual(
    rows('archive').map((row) => [row.entry.path, row.depth]),
    [
      ['Projects/Old', 0],
      ['Projects/Old/Plan.excalidraw', 1],
    ],
  );
  const match = rows('library', 'old/plan');
  assert.equal(match.length, 1);
  assert.equal(match[0].entry.archived, true);
  assert.equal(match[0].flat, true);
});

test('collapse and explicit custom order preserve correct virtual-tree sibling semantics', () => {
  const entries = [
    entry('A', 'folder', { order: 1 }),
    entry('A/Child.excalidraw'),
    entry('Z.excalidraw', 'file', { order: 0 }),
  ];
  const rows = buildRows({
    entries,
    view: 'library',
    query: '',
    sort: 'custom',
    collapsed: new Set(['A']),
  });
  assert.deepEqual(
    rows.map((row) => [row.entry.path, row.posinset, row.setsize, row.expanded]),
    [
      ['Z.excalidraw', 1, 2, false],
      ['A', 2, 2, false],
    ],
  );
});

test('bulk actions include each subtree once without confusing similarly named folders', () => {
  assert.deepEqual(
    topLevel(['A/one.excalidraw', 'AB/two.excalidraw', 'A', 'A/Inner/three.excalidraw', 'A']),
    ['A', 'AB/two.excalidraw'],
  );
});

test('search ranks visible names and paths without matching the file format extension', () => {
  const entries = [
    entry('Unrelated.excalidraw'),
    entry('Drawing ideas.excalidraw'),
    entry('Drawing', 'folder'),
    entry('Drawing/Notes.excalidraw'),
    entry('A drawing.excalidraw'),
  ];
  const rows = (query: string) =>
    buildRows({ entries, view: 'library', query, sort: 'recent', collapsed: new Set() });
  assert.deepEqual(
    rows('drawing').map((row) => row.entry.path),
    ['Drawing', 'Drawing ideas.excalidraw', 'A drawing.excalidraw', 'Drawing/Notes.excalidraw'],
  );
  assert.equal(
    rows('raw').some((row) => row.entry.path === 'Unrelated.excalidraw'),
    false,
  );
  assert.equal(rows('excalidraw').length, 0);
});
