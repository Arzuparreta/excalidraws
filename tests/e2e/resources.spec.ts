import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

async function seed(request: APIRequestContext, name: string) {
  const result = await request.post('/api/entries', {
    data: { path: `${name}.excalidraw` },
  });
  expect(result.ok()).toBe(true);
}
async function ready(page: Page) {
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  await expect(page.getByLabel('Processing', { exact: true })).toHaveCount(0);
  await expect(page.locator('.save-status')).toContainText('Saved');
}

test('the empty Solid workspace loads without downloading the editor runtime', async ({ page }) => {
  const editorRequests: string[] = [];
  page.on('request', (request) => {
    if (/ExcalidrawAdapter.*\.(js|css)/.test(request.url())) editorRequests.push(request.url());
  });
  await page.route('**/api/entries', (route) => route.fulfill({ json: [] }));
  await page.goto('/');
  await expect(page.getByText('Open a canvas or create one.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create canvas', exact: true })).toBeEnabled();
  expect(editorRequests).toEqual([]);
  await expect(page.locator('.excalidraw')).toHaveCount(0);
});

test('an idle workspace performs no document polling and sidebar interactions keep the editor mounted', async ({
  page,
  request,
}) => {
  await seed(request, 'Resource idle');
  await page.goto('/');
  await ready(page);
  const canvas = await page.locator('.excalidraw canvas.interactive').elementHandle();
  await page.getByRole('textbox', { name: 'Search canvases' }).fill('Resource');
  await page.getByRole('textbox', { name: 'Search canvases' }).fill('');
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('textbox', { name: 'Search canvases' })).toBeFocused();
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  // Let initial normalization and the last file notification settle before observing idle.
  await page.waitForTimeout(1200);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/(entries|revision|document)(\?|$)/.test(request.url()))
      requests.push(request.url());
  });
  const bounds = (await page.locator('.excalidraw canvas.interactive').boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5, {
    steps: 12,
  });
  await page.waitForTimeout(3200);
  expect(requests).toEqual([]);
  await expect(page.locator('.editor-mount .excalidraw')).toHaveCount(1);
});

test('rapid selection cancels stale loads, commits only the last board and preserves the previous editor on failure', async ({
  page,
  request,
}) => {
  for (const name of ['Switch source', 'Switch slow', 'Switch final', 'Switch unavailable'])
    await seed(request, name);
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Switch source', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Switch source', exact: true })).toBeVisible();
  await ready(page);
  let release!: () => void;
  let intercepted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  await page.route('**/api/document?*', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path === 'Switch slow.excalidraw') {
      intercepted();
      await gate;
    }
    if (path === 'Switch unavailable.excalidraw') return route.abort('failed');
    await route.continue().catch(() => {});
  });
  const visited: string[] = [];
  await page.exposeFunction('recordHeading', (value: string) => visited.push(value));
  await page.evaluate(() => {
    const heading = document.querySelector('.document-title')!;
    new MutationObserver(() =>
      (window as unknown as { recordHeading(value: string): void }).recordHeading(
        heading.textContent ?? '',
      ),
    ).observe(heading, { subtree: true, childList: true, characterData: true });
  });
  try {
    await page.getByRole('button', { name: 'Switch slow', exact: true }).click();
    await started;
    await page.getByRole('button', { name: 'Switch final', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Switch final', exact: true })).toBeVisible({
      timeout: 3000,
    });
  } finally {
    release();
  }
  await ready(page);
  expect(visited.some((value) => value.includes('Switch slow'))).toBe(false);
  await expect(page.locator('.editor-mount .excalidraw')).toHaveCount(1);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Switch source', exact: true })).toBeVisible();
  await ready(page);
  const canvas = await page.locator('.excalidraw canvas.interactive').elementHandle();
  await page.getByRole('button', { name: 'Switch unavailable', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Switch source', exact: true })).toBeVisible();
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.getByLabel('Processing', { exact: true })).toHaveCount(0);
});

test('large libraries render a bounded list, retain selection through search and fit phone through desktop sizes', async ({
  page,
  request,
}) => {
  for (let offset = 0; offset < 300; offset += 15) {
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        seed(request, `ZZZ Library ${String(offset + i).padStart(3, '0')}`),
      ),
    );
  }
  await page.goto('/');
  await ready(page);
  const sortButton = page.getByRole('button', { name: /^Sort canvases/ });
  await sortButton.click();
  await expect(
    page.getByRole('menuitemradio', { name: 'Recent changes', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: 'test-results/canvas-sort-menu-desktop.png' });
  await page.getByRole('menuitemradio', { name: 'Name (A–Z)', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Sort canvases', exact: true })).toHaveCount(0);
  await sortButton.click();
  await expect(
    page.getByRole('menuitemradio', { name: 'Name (A–Z)', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(sortButton).toBeFocused();
  expect(await page.locator('.file-row').count()).toBeLessThan(60);
  await page.locator('.file-list').evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await expect(page.getByRole('button', { name: 'ZZZ Library 299', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ZZZ Library 299', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ZZZ Library 299', exact: true })).toBeVisible();
  await ready(page);
  await page.getByRole('textbox', { name: 'Search canvases' }).fill('missing search');
  await expect(page.getByRole('heading', { name: 'ZZZ Library 299', exact: true })).toBeVisible();
  await expect(page.getByText('No matching canvases.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search canvases' }).fill('');
  await page.locator('.title-button').focus();
  for (const width of [320, 390, 760, 844, 900, 1024, 1366]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect
      .poll(async () => (await page.locator('.editor-surface').boundingBox())!.width)
      .toBeGreaterThan(250);
    const editor = (await page.locator('.editor-surface').boundingBox())!;
    expect(editor.width).toBeGreaterThan(250);
    expect(editor.x + editor.width).toBeLessThanOrEqual(width);
    if (width < 1024) {
      await expect(page.getByRole('complementary', { name: 'Canvas explorer' })).toBeHidden();
      await page.getByRole('button', { name: 'Open explorer', exact: true }).click();
      await expect(page.getByRole('complementary', { name: 'Canvas explorer' })).toBeVisible();
      await expect(page.locator('main')).toHaveAttribute('inert', '');
      if (width === 390) {
        await sortButton.click();
        await expect(page.getByRole('menu', { name: 'Sort canvases', exact: true })).toBeVisible();
        await page.screenshot({ path: 'test-results/canvas-sort-menu-mobile.png' });
        await page.keyboard.press('Escape');
        await expect(page.getByRole('menu', { name: 'Sort canvases', exact: true })).toHaveCount(0);
        await expect(page.getByRole('complementary', { name: 'Canvas explorer' })).toBeVisible();
        await page.locator('[data-entry-path="ZZZ Library 299.excalidraw"]').focus();
        await page.keyboard.press('F2');
        const draft = page.getByRole('textbox', { name: 'Canvas name', exact: true });
        await expect(draft).toBeFocused();
        await draft.fill('ZZZ Library draft');
        // A filesystem notification must not silently commit the inline name draft.
        const count = Number(await page.locator('.list-header .entry-count').textContent());
        await seed(request, 'ZZZ Watch refresh');
        await expect(page.locator('.list-header .entry-count')).toHaveText(String(count + 1));
        await expect(draft).toBeFocused();
        await expect(draft).toHaveValue('ZZZ Library draft');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page.getByRole('complementary', { name: 'Canvas explorer' })).toBeVisible();
      }
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Open explorer', exact: true })).toBeFocused();
    }
  }
  await expect(page.locator('.editor-mount .excalidraw')).toHaveCount(1);
});
