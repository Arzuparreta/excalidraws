import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { Document, Entry } from '../../shared/model';

const read = async (request: APIRequestContext, path: string): Promise<Document> =>
  (await request.get(`/api/document?path=${encodeURIComponent(path)}`)).json();
const entries = async (request: APIRequestContext): Promise<Entry[]> =>
  (await request.get('/api/entries')).json();
async function seed(request: APIRequestContext, path: string, kind: 'file' | 'folder' = 'file') {
  expect((await request.post('/api/entries', { data: { path, kind } })).ok()).toBe(true);
}
const row = (page: Page, path: string) => page.locator(`[data-entry-path="${path}"]`);
async function action(page: Page, path: string, label: string) {
  const item = row(page, path);
  await item.hover();
  await item.locator('.row-menu').click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}
async function ready(page: Page) {
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  await expect(page.getByLabel('Processing', { exact: true })).toHaveCount(0);
  await expect(page.locator('.save-status')).toContainText('Saved');
}

test('favorites and archive synchronize across clients without changing the drawing or editor', async ({
  page,
  request,
  context,
}) => {
  const path = 'Library continuity.excalidraw';
  await seed(request, path);
  await page.goto(`/?canvas=${encodeURIComponent(path)}`);
  await ready(page);
  const canvas = await page.locator('.excalidraw canvas.interactive').elementHandle();
  const before = await read(request, path);
  const other = await context.newPage();
  await other.goto(`/?canvas=${encodeURIComponent(path)}`);
  await ready(other);
  await action(page, path, 'Add to favorites');
  await other.getByRole('tab', { name: 'Favorites', exact: true }).click();
  await expect(row(other, path)).toBeVisible();
  await action(page, path, 'Archive');
  await expect(row(page, path)).toHaveCount(0);
  await expect(row(other, path)).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Library continuity', exact: true }),
  ).toBeVisible();
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  expect((await read(request, path)).revision).toBe(before.revision);
  await page.getByRole('tab', { name: 'Archive', exact: true }).click();
  await expect(row(page, path)).toHaveAttribute('aria-current', 'page');
  await action(page, path, 'Unarchive');
  await expect(row(other, path)).toBeVisible();
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await expect(row(page, path)).toHaveAttribute('aria-current', 'page');
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  await page.screenshot({ path: 'test-results/ux-desktop.png' });
  await other.close();
});

test('bulk move, undo, custom order and duplicate retain the active drawing', async ({
  page,
  request,
}) => {
  for (const path of ['Batch A.excalidraw', 'Batch B.excalidraw', 'Batch C.excalidraw'])
    await seed(request, path);
  await seed(request, 'Batch destination', 'folder');
  await page.goto('/?canvas=Batch%20A.excalidraw');
  await ready(page);
  const canvas = await page.locator('.excalidraw canvas.interactive').elementHandle();
  await page.getByRole('textbox', { name: 'Search canvases' }).fill('Batch');
  await page.getByRole('button', { name: 'Select items', exact: true }).click();
  await row(page, 'Batch B.excalidraw').click();
  await row(page, 'Batch C.excalidraw').click();
  await expect(page.getByRole('group', { name: 'Selection actions' })).toContainText('2');
  await page.getByRole('button', { name: 'Move selected', exact: true }).click();
  await page.getByRole('option', { name: /^Batch destination/ }).click();
  await expect
    .poll(
      async () =>
        (await entries(request)).filter((e) => e.path.startsWith('Batch destination/')).length,
    )
    .toBe(2);
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  await page
    .locator('.message.notice:visible')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await entries(request)).filter((e) =>
          ['Batch B.excalidraw', 'Batch C.excalidraw'].includes(e.path),
        ).length,
    )
    .toBe(2);
  const done = page.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible()) await done.click();
  await page.getByRole('textbox', { name: 'Search canvases' }).fill('');
  await page.getByRole('button', { name: 'Sort canvases', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Custom order', exact: true }).click();
  await row(page, 'Batch C.excalidraw').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect
    .poll(async () => {
      const all = await entries(request);
      return (
        all.find((e) => e.path === 'Batch C.excalidraw')!.order! <
        all.find((e) => e.path === 'Batch B.excalidraw')!.order!
      );
    })
    .toBe(true);
  await action(page, 'Batch B.excalidraw', 'Duplicate');
  await expect
    .poll(async () => (await entries(request)).some((e) => e.path === 'Batch B (copy).excalidraw'))
    .toBe(true);
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Batch A', exact: true })).toBeVisible();
  await expect(page.locator('dialog')).toHaveCount(0);
});

test('pointer drag moves into a folder and inserts in custom order; undo restores the prior order', async ({
  page,
  request,
}) => {
  await seed(request, 'Drag destination', 'folder');
  await seed(request, 'Drag destination/Anchor.excalidraw');
  for (const path of ['Drag A.excalidraw', 'Drag B.excalidraw']) await seed(request, path);
  await page.goto('/?canvas=Drag%20A.excalidraw');
  await ready(page);
  await page.getByRole('button', { name: 'Sort canvases', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Custom order', exact: true }).click();
  const initial = (await entries(request))
    .filter((e) => !e.path.includes('/'))
    .sort((a, b) => a.order! - b.order!)
    .map((e) => e.path);
  const drag = async (from: string, to: string, ratio: number) => {
    const a = (await row(page, from).boundingBox())!;
    const b = (await row(page, to).boundingBox())!;
    await page.mouse.move(a.x + 85, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 85, b.y + b.height * ratio, { steps: 15 });
    await page.mouse.up();
  };
  await drag('Drag B.excalidraw', 'Drag A.excalidraw', 0.1);
  await expect
    .poll(async () => {
      const all = await entries(request);
      return (
        all.find((e) => e.path === 'Drag B.excalidraw')!.order! <
        all.find((e) => e.path === 'Drag A.excalidraw')!.order!
      );
    })
    .toBe(true);
  await page
    .locator('.message.notice:visible')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect
    .poll(async () =>
      (await entries(request))
        .filter((e) => !e.path.includes('/'))
        .sort((a, b) => a.order! - b.order!)
        .map((e) => e.path),
    )
    .toEqual(initial);
  await drag('Drag A.excalidraw', 'Drag destination', 0.5);
  await expect
    .poll(async () =>
      (await entries(request)).some((e) => e.path === 'Drag destination/Drag A.excalidraw'),
    )
    .toBe(true);
  await page
    .locator('.message.notice:visible')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect
    .poll(async () =>
      (await entries(request))
        .filter((e) => !e.path.includes('/'))
        .sort((a, b) => a.order! - b.order!)
        .map((e) => e.path),
    )
    .toEqual(initial);
  // Cross-folder insertion is also one gesture and one Undo, including the source order.
  await drag('Drag B.excalidraw', 'Drag destination/Anchor.excalidraw', 0.1);
  await expect
    .poll(async () => {
      const all = await entries(request);
      const moved = all.find((e) => e.path === 'Drag destination/Drag B.excalidraw');
      return (
        !!moved &&
        moved.order! < all.find((e) => e.path === 'Drag destination/Anchor.excalidraw')!.order!
      );
    })
    .toBe(true);
  await page
    .locator('.message.notice:visible')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect
    .poll(async () =>
      (await entries(request))
        .filter((e) => !e.path.includes('/'))
        .sort((a, b) => a.order! - b.order!)
        .map((e) => e.path),
    )
    .toEqual(initial);
  await expect(page.getByRole('heading', { name: 'Drag A', exact: true })).toBeVisible();
});

test('a slow unrelated rename leaves drawing available and queued canvas selection is honored', async ({
  page,
  request,
}) => {
  await seed(request, 'Queue drawing.excalidraw');
  await seed(request, 'Queue next.excalidraw');
  await seed(request, 'Queue folder', 'folder');
  await page.goto('/?canvas=Queue%20drawing.excalidraw');
  await ready(page);
  const canvas = await page.locator('.excalidraw canvas.interactive').elementHandle();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/move', async (route) => {
    started();
    await gate;
    await route.continue();
  });
  await row(page, 'Queue folder').focus();
  await page.keyboard.press('F2');
  const name = page.getByRole('textbox', { name: 'Folder name', exact: true });
  await name.fill('Queue renamed');
  await name.press('Enter');
  await began;
  try {
    await expect(page.locator('.editor-area')).not.toHaveAttribute('inert');
    expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
    await row(page, 'Queue next.excalidraw').locator('.file-select').click();
  } finally {
    release();
  }
  await expect(page.getByRole('heading', { name: 'Queue next', exact: true })).toBeVisible();
  await expect(row(page, 'Queue renamed')).toBeVisible();
});

test('touch drawer retains context through rotation and external updates, with accessible local menus', async ({
  browser,
  request,
}) => {
  await seed(request, 'Touch continuity.excalidraw');
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:4317/?canvas=Touch%20continuity.excalidraw');
  await ready(page);
  await page.getByRole('button', { name: 'Open explorer', exact: true }).tap();
  const explorer = page.getByRole('complementary', { name: 'Canvas explorer' });
  await expect(explorer).toBeVisible();
  const current = row(page, 'Touch continuity.excalidraw');
  expect((await current.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await current.locator('.row-menu').tap();
  const menu = page.getByRole('menu', { name: 'Item actions' });
  await expect(menu).toBeVisible();
  const option = menu.getByRole('menuitem', { name: 'Rename', exact: true });
  const optionBox = (await option.boundingBox())!;
  expect(optionBox.height).toBeGreaterThanOrEqual(44);
  await option.tap();
  const input = page.getByRole('textbox', { name: 'Canvas name', exact: true });
  expect(
    await input.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await input.fill('Touch renamed');
  await page.getByRole('button', { name: 'Save name', exact: true }).tap();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(explorer).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('inert');
  const source = await read(request, 'Touch renamed.excalidraw');
  await request.put('/api/document', {
    data: {
      path: source.path,
      revision: source.revision,
      scene: {
        ...source.scene,
        appState: { ...source.scene.appState, viewBackgroundColor: '#f7f7f8' },
      },
    },
  });
  await expect
    .poll(async () => (await read(request, source.path)).scene.appState.viewBackgroundColor)
    .toBe('#f7f7f8');
  await expect(explorer).toBeVisible();
  expect((await page.locator('.file-list').boundingBox())!.height).toBeGreaterThanOrEqual(4 * 44);
  await page.screenshot({ path: 'test-results/ux-touch-landscape.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/ux-touch-drawer.png' });
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).tap();
  await expect(explorer).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open explorer', exact: true })).toBeFocused();
  await page.screenshot({ path: 'test-results/ux-touch-canvas.png' });
  expect(errors).toEqual([]);
  await context.close();
});

test('crossing the drawer breakpoint preserves a move picker and browser Back skips trashed visits', async ({
  page,
  request,
}) => {
  for (const path of [
    'Navigation A.excalidraw',
    'Navigation B.excalidraw',
    'Navigation C.excalidraw',
  ])
    await seed(request, path);
  await seed(request, 'Navigation folder', 'folder');
  await page.goto('/?canvas=Navigation%20A.excalidraw');
  await ready(page);
  await action(page, 'Navigation A.excalidraw', 'Move to…');
  const picker = page.getByRole('dialog', { name: 'Move to folder' });
  await expect(picker).toBeVisible();
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(picker).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('inert');
  await page.setViewportSize({ width: 1366, height: 800 });
  await expect(picker).toBeVisible();
  await page.keyboard.press('Escape');
  await row(page, 'Navigation B.excalidraw').locator('.file-select').click();
  await expect(page.getByRole('heading', { name: 'Navigation B', exact: true })).toBeVisible();
  await row(page, 'Navigation C.excalidraw').locator('.file-select').click();
  await expect(page.getByRole('heading', { name: 'Navigation C', exact: true })).toBeVisible();
  await action(page, 'Navigation B.excalidraw', 'Move to trash');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Navigation A', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/canvas=Navigation\+A.excalidraw/);
  await expect(page.locator('dialog')).toHaveCount(0);
});

test('folder arrow expands and collapses when clicking the chevron itself', async ({
  page,
  request,
}) => {
  await seed(request, 'Arrow folder', 'folder');
  await seed(request, 'Arrow folder/Child.excalidraw');
  await page.goto('/');
  const folder = row(page, 'Arrow folder');
  const child = row(page, 'Arrow folder/Child.excalidraw');
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await folder.locator('.row-twisty svg').click();
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  await expect(child).toHaveCount(0);
  await folder.locator('.row-twisty svg').click();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await expect(child).toBeVisible();
  await folder.locator('.row-twisty').click({ position: { x: 1, y: 1 } });
  await expect(child).toHaveCount(0);
  await folder.locator('.row-twisty svg').click();
  await expect(child).toBeVisible();
  await page.screenshot({ path: 'test-results/folder-arrow-expanded.png' });
});
