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
const explorer = (page: Page) => page.getByRole('complementary', { name: 'Canvas explorer' });
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
  await explorer(other).getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(row(other, path)).toBeVisible();
  await action(page, path, 'Archive');
  await expect(row(page, path)).toHaveCount(0);
  await expect(row(other, path)).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Library continuity', exact: true }),
  ).toBeVisible();
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  expect((await read(request, path)).revision).toBe(before.revision);
  await explorer(page).getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(row(page, path)).toHaveAttribute('aria-current', 'page');
  await action(page, path, 'Unarchive');
  await expect(row(other, path)).toBeVisible();
  await explorer(page).getByRole('button', { name: 'Library', exact: true }).click();
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
  await page.getByRole('button', { name: /^Sort canvases/ }).click();
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
  await page.getByRole('button', { name: /^Sort canvases/ }).click();
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

test('canvas navigation skips trashed visits and disables directions with no available canvas', async ({
  page,
  request,
}) => {
  for (const path of ['History A.excalidraw', 'History B.excalidraw', 'History C.excalidraw'])
    await seed(request, path);
  const previous = page.getByRole('button', { name: 'Back', exact: true });
  const next = page.getByRole('button', { name: 'Forward', exact: true });
  await page.goto('/?canvas=History%20A.excalidraw');
  await ready(page);
  await expect(previous).toBeDisabled();
  await expect(next).toBeDisabled();
  for (const name of ['History B', 'History C']) {
    await row(page, `${name}.excalidraw`).locator('.file-select').click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  await action(page, 'History B.excalidraw', 'Move to trash');
  await expect(row(page, 'History B.excalidraw')).toHaveCount(0);
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect(page.getByRole('heading', { name: 'History A', exact: true })).toBeVisible();
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByRole('heading', { name: 'History C', exact: true })).toBeVisible();
  await expect(next).toBeDisabled();
  await action(page, 'History A.excalidraw', 'Move to trash');
  await expect(row(page, 'History A.excalidraw')).toHaveCount(0);
  await expect(previous).toBeDisabled();
  await expect(next).toBeDisabled();
  await page.screenshot({ path: 'test-results/navigation-no-available-history.png' });

  await page
    .locator('.message.notice:visible')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect(page.getByRole('heading', { name: 'History A', exact: true })).toBeVisible();
  await expect(next).toBeEnabled();
  expect((await request.post('/api/trash', { data: { path: 'History C.excalidraw' } })).ok()).toBe(
    true,
  );
  await expect(row(page, 'History C.excalidraw')).toHaveCount(0);
  await expect(next).toBeDisabled();
  await expect(previous).toBeDisabled();
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

test('sidebar controls: one creation control, footer views with a way back, selection in place', async ({
  page,
  request,
}) => {
  await seed(request, 'Controls A.excalidraw');
  await seed(request, 'Controls B.excalidraw');
  await page.goto('/?canvas=Controls%20A.excalidraw');
  await ready(page);
  const side = explorer(page);

  const more = side.getByRole('button', { name: 'More ways to create', exact: true });
  await more.click();
  const create = page.getByRole('menu', { name: 'More ways to create', exact: true });
  await expect(create.getByRole('menuitem')).toHaveText([
    'New folder',
    'Import .excalidraw files…',
  ]);
  await page.keyboard.press('Escape');
  await expect(create).toHaveCount(0);
  await expect(more).toBeFocused();

  const sort = side.getByRole('button', { name: 'Sort canvases: Recent changes', exact: true });
  await expect(sort).toHaveText('Recent');

  // Selecting swaps the row icon for a checkbox, so names keep their position.
  const name = row(page, 'Controls B.excalidraw').locator('.file-name');
  const before = (await name.boundingBox())!.x;
  await side.getByRole('button', { name: 'Select items', exact: true }).click();
  const actions = page.getByRole('group', { name: 'Selection actions' });
  await expect(actions).toContainText('Nothing selected');
  await expect(actions.getByRole('button', { name: 'Move selected', exact: true })).toHaveCount(0);
  expect((await name.boundingBox())!.x).toBe(before);
  await row(page, 'Controls B.excalidraw').click();
  await expect(actions).toContainText('1 selected');
  await expect(actions.getByRole('button', { name: 'Move selected', exact: true })).toBeVisible();
  await actions.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(actions).toHaveCount(0);

  const library = side.getByRole('button', { name: 'Library', exact: true });
  const archive = side.getByRole('button', { name: 'Archive', exact: true });
  await expect(library).toHaveAttribute('aria-current', 'true');
  await archive.click();
  await expect(archive).toHaveAttribute('aria-current', 'true');
  await expect(library).not.toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('Nothing is archived.')).toBeVisible();
  await side.getByRole('button', { name: 'Back to Library', exact: true }).click();
  await expect(library).toHaveAttribute('aria-current', 'true');
  await expect(row(page, 'Controls A.excalidraw')).toBeVisible();
  await page.screenshot({ path: 'test-results/sidebar-controls-desktop.png' });
});
