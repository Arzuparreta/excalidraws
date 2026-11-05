import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, renamedPath, topLevel, type LibraryEntry } from '../src/workspace/tree';
import {
  canvasLink,
  canvasPath,
  linkedCanvas,
  parentCanvas,
  relocated,
  relocatedLink,
  sceneLinks,
} from '../shared/canvas';

const entry = (path: string, flags: Partial<LibraryEntry> = {}): LibraryEntry => ({
  path,
  modified: '2026-11-04T12:00:00Z',
  children: 0,
  ...flags,
});

test('the library keeps hierarchy, hides archived canvases, and exposes their search results', () => {
  const entries = [
    entry('Projects.excalidraw', { children: 2 }),
    entry('Projects/Current.excalidraw', { favorite: true }),
    entry('Projects/Old.excalidraw', {
      archived: true,
      archiveRoot: 'Projects/Old.excalidraw',
      children: 1,
    }),
    entry('Projects/Old/Plan.excalidraw', {
      archived: true,
      archiveRoot: 'Projects/Old.excalidraw',
      favorite: true,
    }),
  ];
  const rows = (view: 'library' | 'favorites' | 'archive', query = '') =>
    buildRows({ entries, view, query, sort: 'name', collapsed: new Set() });
  assert.deepEqual(
    rows('library').map((row) => [row.entry.path, row.depth, row.inside]),
    [
      ['Projects.excalidraw', 0, 1],
      ['Projects/Current.excalidraw', 1, 0],
    ],
  );
  assert.deepEqual(
    rows('favorites').map((row) => row.entry.path),
    ['Projects/Current.excalidraw'],
  );
  assert.deepEqual(
    rows('archive').map((row) => [row.entry.path, row.depth, row.expandable]),
    [
      ['Projects/Old.excalidraw', 0, true],
      ['Projects/Old/Plan.excalidraw', 1, false],
    ],
  );
  const match = rows('library', 'old/plan');
  assert.equal(match.length, 1);
  assert.equal(match[0].entry.archived, true);
  assert.equal(match[0].flat, true);
});

test('only canvases with visible canvases inside expand; collapse and custom order apply', () => {
  const entries = [
    entry('A.excalidraw', { order: 1, children: 1 }),
    entry('A/Child.excalidraw'),
    entry('Empty.excalidraw', { order: 2 }),
    entry('Z.excalidraw', { order: 0 }),
  ];
  const rows = (collapsed: string[]) =>
    buildRows({
      entries,
      view: 'library',
      query: '',
      sort: 'custom',
      collapsed: new Set(collapsed),
    });
  assert.deepEqual(
    rows(['A.excalidraw']).map((row) => [
      row.entry.path,
      row.posinset,
      row.setsize,
      row.expanded,
      row.expandable,
    ]),
    [
      ['Z.excalidraw', 1, 3, false, false],
      ['A.excalidraw', 2, 3, false, true],
      ['Empty.excalidraw', 3, 3, false, false],
    ],
  );
  assert.deepEqual(
    rows([]).map((row) => row.entry.path),
    ['Z.excalidraw', 'A.excalidraw', 'A/Child.excalidraw', 'Empty.excalidraw'],
  );
});

test('bulk actions include each canvas once without confusing similar names', () => {
  assert.deepEqual(
    topLevel([
      'A/one.excalidraw',
      'AB/two.excalidraw',
      'A.excalidraw',
      'A/Inner/three.excalidraw',
      'A.excalidraw',
      'AB.excalidraw',
    ]),
    ['A.excalidraw', 'AB.excalidraw'],
  );
});

test('search ranks visible names and paths without matching the file format extension', () => {
  const entries = [
    entry('Unrelated.excalidraw'),
    entry('Drawing ideas.excalidraw'),
    entry('Drawing.excalidraw', { children: 1 }),
    entry('Drawing/Notes.excalidraw'),
    entry('A drawing.excalidraw'),
  ];
  const rows = (query: string) =>
    buildRows({ entries, view: 'library', query, sort: 'recent', collapsed: new Set() });
  assert.deepEqual(
    rows('drawing').map((row) => row.entry.path),
    [
      'Drawing.excalidraw',
      'Drawing ideas.excalidraw',
      'A drawing.excalidraw',
      'Drawing/Notes.excalidraw',
    ],
  );
  assert.equal(
    rows('raw').some((row) => row.entry.path === 'Unrelated.excalidraw'),
    false,
  );
  assert.equal(rows('excalidraw').length, 0);
});

test('canvas paths, moves and links follow the canvas that contains them', () => {
  assert.equal(canvasPath('', 'Ideas'), 'Ideas.excalidraw');
  assert.equal(canvasPath('Ideas.excalidraw', 'Idea A'), 'Ideas/Idea A.excalidraw');
  assert.equal(parentCanvas('Ideas/Idea A/Detail.excalidraw'), 'Ideas/Idea A.excalidraw');
  assert.equal(parentCanvas('Ideas.excalidraw'), '');
  assert.equal(renamedPath({ path: 'Ideas/Idea A.excalidraw' }, ' B '), 'Ideas/B.excalidraw');
  assert.equal(
    relocated('Ideas/Idea A.excalidraw', 'Ideas.excalidraw', 'Notes.excalidraw'),
    'Notes/Idea A.excalidraw',
  );
  assert.equal(
    relocated('Ideas 2.excalidraw', 'Ideas.excalidraw', 'Notes.excalidraw'),
    'Ideas 2.excalidraw',
  );

  const link = canvasLink('Ideas/Idea A.excalidraw');
  assert.equal(link, '/?canvas=Ideas/Idea%20A.excalidraw');
  assert.equal(linkedCanvas(link), 'Ideas/Idea A.excalidraw');
  assert.equal(linkedCanvas('/?canvas=Ideas%2FIdea%20A.excalidraw'), 'Ideas/Idea A.excalidraw');
  assert.equal(linkedCanvas('https://example.com/?canvas=A.excalidraw'), undefined);
  assert.equal(
    linkedCanvas('https://example.com/?canvas=A.excalidraw', 'https://example.com'),
    'A.excalidraw',
  );
  assert.equal(linkedCanvas('//example.com/?canvas=A.excalidraw'), undefined);
  assert.equal(linkedCanvas('/?canvas=notes.txt'), undefined);
  assert.equal(linkedCanvas('/?element=abc'), undefined);
  assert.equal(
    relocatedLink(link, 'Ideas.excalidraw', 'Archive/Ideas.excalidraw'),
    '/?canvas=Archive/Ideas/Idea%20A.excalidraw',
  );
  assert.equal(relocatedLink(link, 'Other.excalidraw', 'Moved.excalidraw'), undefined);
  assert.deepEqual(sceneLinks([{ link }, { link: null }, { link: 'x', isDeleted: true }, null]), [
    link,
  ]);
});
