import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { Document, Entry } from '../../shared/model';
import { canvasLink } from '../../shared/canvas';

const read = async (request: APIRequestContext, path: string): Promise<Document> =>
  (await request.get(`/api/document?path=${encodeURIComponent(path)}`)).json();
const entries = async (request: APIRequestContext): Promise<Entry[]> =>
  (await request.get('/api/entries')).json();
async function seed(request: APIRequestContext, path: string, scene?: unknown) {
  expect((await request.post('/api/entries', { data: { path, scene } })).ok()).toBe(true);
}
const row = (page: Page, path: string) => page.locator(`[data-entry-path="${path}"]`);
const links = async (request: APIRequestContext, path: string) =>
  (await read(request, path)).scene.elements
    .filter((element) => !element.isDeleted && element.link)
    .map((element) => element.link);
const label = (id: string, text: string, y: number, link: string | null = null) => ({
  id,
  type: 'text',
  x: 120,
  y,
  width: 160,
  height: 25,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link,
  locked: false,
  text,
  originalText: text,
  fontSize: 20,
  fontFamily: 5,
  textAlign: 'left',
  verticalAlign: 'top',
  containerId: null,
  autoResize: true,
  lineHeight: 1.25,
});
const scene = (...elements: unknown[]) => ({
  type: 'excalidraw',
  version: 2,
  source: 'excalidraws',
  elements,
  appState: { viewBackgroundColor: '#ffffff', scrollX: 0, scrollY: 0, zoom: { value: 1 } },
  files: {},
});
async function ready(page: Page) {
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  await expect(page.getByLabel('Processing', { exact: true })).toHaveCount(0);
  await expect(page.locator('.save-status')).toContainText('Saved');
}
async function selectAll(page: Page) {
  const box = (await page.locator('.excalidraw canvas.interactive').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await page.keyboard.press('Control+A');
}

test('a selected label becomes a canvas inside, linked to it, and links open canvases', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await seed(request, 'Link hub.excalidraw', scene(label('idea', 'Idea one', 120)));
  await page.goto(`/?canvas=${encodeURIComponent('Link hub.excalidraw')}`);
  await ready(page);
  await expect(page.locator('.unlinked-button')).toHaveCount(0);

  await selectAll(page);
  await page.getByRole('button', { name: 'Link to canvas', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Link to canvas', exact: true });
  await expect(panel.getByText('Link the selection')).toBeVisible();
  await page.screenshot({ path: 'test-results/nested-link-panel.png' });
  await panel.getByRole('button', { name: /New canvas “Idea one” inside Link hub/ }).click();
  await expect(panel).toHaveCount(0);
  await expect
    .poll(() => links(request, 'Link hub.excalidraw'))
    .toEqual([canvasLink('Link hub/Idea one.excalidraw')]);
  // The canvas being drawn stays open; the new one appears inside it.
  await expect(page.getByRole('heading', { name: 'Link hub', exact: true })).toBeVisible();
  await expect(row(page, 'Link hub.excalidraw').locator('.row-count')).toHaveText('1');
  await expect(row(page, 'Link hub/Idea one.excalidraw')).toBeVisible();
  await expect(page.locator('.unlinked-button')).toHaveCount(0);

  // A canvas added inside from elsewhere is reported until the drawing links to it.
  await seed(request, 'Link hub/Second idea.excalidraw');
  const unlinked = page.locator('.unlinked-button');
  await expect(unlinked).toHaveText('1 not linked');
  await unlinked.click();
  const report = page.getByRole('dialog', { name: 'Canvases not linked here', exact: true });
  await expect(report.getByText('Second idea', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/nested-unlinked.png' });
  await report.getByRole('button', { name: 'Add a link to Second idea', exact: true }).click();
  await expect(report.getByText('Every canvas inside is linked.')).toBeVisible();
  await expect(unlinked).toHaveCount(0);
  await expect
    .poll(async () => (await links(request, 'Link hub.excalidraw')).sort())
    .toEqual(
      [
        canvasLink('Link hub/Idea one.excalidraw'),
        canvasLink('Link hub/Second idea.excalidraw'),
      ].sort(),
    );

  // Renaming a canvas updates the open drawing's links without a conflict.
  const child = row(page, 'Link hub/Idea one.excalidraw');
  await child.focus();
  await page.keyboard.press('F2');
  const name = page.getByRole('textbox', { name: 'Canvas name', exact: true });
  await name.fill('Idea renamed');
  await name.press('Enter');
  await expect(row(page, 'Link hub/Idea renamed.excalidraw')).toBeVisible();
  await expect
    .poll(async () => (await links(request, 'Link hub.excalidraw')).sort())
    .toEqual(
      [
        canvasLink('Link hub/Idea renamed.excalidraw'),
        canvasLink('Link hub/Second idea.excalidraw'),
      ].sort(),
    );
  await expect(page.locator('.save-status')).toContainText('Saved');
  await expect(page.locator('.unlinked-button')).toHaveCount(0);

  // Following a link opens the canvas inside the workspace; the breadcrumb leads back.
  const box = (await page.locator('.excalidraw canvas.interactive').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await page.mouse.click(box.x + 130, box.y + 132);
  const hyperlink = page.locator('.excalidraw-hyperlinkContainer-link');
  await expect(hyperlink).toBeVisible();
  await hyperlink.click();
  await expect(page.getByRole('heading', { name: 'Idea renamed', exact: true })).toBeVisible();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('canvas') === 'Link hub/Idea renamed.excalidraw',
  );
  expect(page.context().pages()).toHaveLength(1);
  await page.getByRole('button', { name: 'Open Link hub', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Link hub', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('dragging canvases from the sidebar onto the drawing adds links; broken links explain', async ({
  page,
  request,
}) => {
  await seed(request, 'Drop board.excalidraw');
  await seed(request, 'Drop target.excalidraw');
  await seed(
    request,
    'Broken links.excalidraw',
    scene(label('gone', 'Gone', 120, canvasLink('Nowhere.excalidraw'))),
  );
  await page.goto(`/?canvas=${encodeURIComponent('Drop board.excalidraw')}`);
  await ready(page);
  const source = (await row(page, 'Drop target.excalidraw').boundingBox())!;
  const canvas = (await page.locator('.excalidraw canvas.interactive').boundingBox())!;
  await page.mouse.move(source.x + 85, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, { steps: 15 });
  await expect(page.locator('.drag-ghost')).toContainText('Link in this canvas');
  await page.mouse.up();
  await expect
    .poll(() => links(request, 'Drop board.excalidraw'))
    .toEqual([canvasLink('Drop target.excalidraw')]);
  const added = (await read(request, 'Drop board.excalidraw')).scene.elements[0]!;
  expect(added.text).toBe('Drop target');
  // Dropping on the drawing never moves the canvas.
  expect((await entries(request)).some((e) => e.path === 'Drop target.excalidraw')).toBe(true);

  await row(page, 'Broken links.excalidraw').locator('.file-select').click();
  await ready(page);
  const box = (await page.locator('.excalidraw canvas.interactive').boundingBox())!;
  await page.mouse.click(box.x + 130, box.y + 132);
  await page.locator('.excalidraw-hyperlinkContainer-link').click();
  await expect(page.getByRole('alert')).toContainText('"Nowhere", which is no longer');
  await expect(page.getByRole('heading', { name: 'Broken links', exact: true })).toBeVisible();
});

test('moving a canvas moves the canvases inside it and keeps links from other canvases', async ({
  page,
  request,
}) => {
  await seed(request, 'Move source.excalidraw');
  await seed(request, 'Move source/Inner.excalidraw');
  await seed(request, 'Move destination.excalidraw');
  await seed(
    request,
    'Move index.excalidraw',
    scene(label('inner', 'Inner', 120, canvasLink('Move source/Inner.excalidraw'))),
  );
  await page.goto(`/?canvas=${encodeURIComponent('Move index.excalidraw')}`);
  await ready(page);
  const item = row(page, 'Move source.excalidraw');
  await item.hover();
  await item.locator('.row-menu').click();
  await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Move to canvas', exact: true });
  await expect(picker.getByRole('option', { name: /^Move source/ })).toHaveCount(0);
  await expect(picker.getByRole('option', { name: /^Inner/ })).toHaveCount(0);
  await picker.getByRole('option', { name: /^Move destination/ }).click();
  await expect(row(page, 'Move destination/Move source/Inner.excalidraw')).toBeVisible();
  await expect(row(page, 'Move destination.excalidraw').locator('.row-count')).toHaveText('1');
  await expect
    .poll(() => links(request, 'Move index.excalidraw'))
    .toEqual([canvasLink('Move destination/Move source/Inner.excalidraw')]);
  await expect(page.locator('.save-status')).toContainText('Saved');
  await page
    .locator('.message.notice:visible')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(row(page, 'Move source/Inner.excalidraw')).toBeVisible();
  await expect
    .poll(() => links(request, 'Move index.excalidraw'))
    .toEqual([canvasLink('Move source/Inner.excalidraw')]);

  // Trash takes the canvases inside along, and says so.
  await item.hover();
  await item.locator('.row-menu').click();
  await page.getByRole('menuitem', { name: 'Move to trash', exact: true }).click();
  await expect(page.locator('.message.notice:visible')).toContainText(
    'Moved "Move source" and the canvas inside it to Trash.',
  );
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(page.locator('.trash-list')).toContainText('1 canvas inside');
});
