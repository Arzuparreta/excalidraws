import { test, expect } from '@playwright/test';

test('editor preparation displays progress and a failed first download can be retried', async ({
  page,
  request,
}) => {
  await request.post('/api/entries', { data: { path: 'Editor download.excalidraw' } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route('**/api/editor', async (route) => {
    if (first) {
      first = false;
      await gate;
      return route.fulfill({ status: 503, json: { error: 'Publisher unavailable' } });
    }
    return route.continue();
  });
  await page.route('**/api/editor/status', (route) =>
    route.fulfill({ json: { state: 'downloading', received: 5, total: 10 } }),
  );
  await page.goto('/?canvas=Editor%20download.excalidraw');
  try {
    await expect(page.locator('.editor-loading')).toContainText('Downloading Excalidraw… 50%');
    await page.screenshot({ path: 'test-results/editor-download-progress.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    const drawer = page.getByRole('complementary', { name: 'Canvas explorer', exact: true });
    if (await drawer.isVisible()) await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page.locator('.editor-loading')).toBeVisible();
    await page.screenshot({ path: 'test-results/editor-download-progress-mobile.png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    release();
  }
  await expect(page.getByRole('alert')).toContainText('Check the server connection');
  await page.screenshot({ path: 'test-results/editor-download-retry-mobile.png' });
  await page.getByRole('button', { name: 'Retry editor download', exact: true }).click();
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  await expect(page.locator('.editor-loading')).toHaveCount(0);
  await expect(page.locator('.save-status')).toContainText('Saved');
});

test('an incompatible module falls back to the previous editor without loading duplicate styles', async ({
  page,
  request,
}) => {
  await request.post('/api/entries', { data: { path: 'Editor fallback.excalidraw' } });
  const installed = await (await request.get('/api/editor')).json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests: string[] = [];
  await page.route('**/api/editor?*', (route) => {
    requests.push(route.request().url());
    return route.fulfill({ json: installed });
  });
  await page.route('**/api/editor', (route) =>
    route.fulfill({ json: { ...installed, entry: installed.entry + '?incompatible' } }),
  );
  await page.route('**/editor.js?incompatible', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'export const contract = 999;' }),
  );
  await page.goto('/?canvas=Editor%20fallback.excalidraw');
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]).searchParams.get('exclude')).toBe(installed.id);
  expect(await page.locator('link[rel="stylesheet"][href^="/editor/"]').count()).toBe(
    installed.css.length,
  );
  expect(errors).toEqual([]);
});

test('downloaded editor assets have immutable cache headers and unknown paths stay unavailable', async ({
  request,
}) => {
  const response = await request.get('/api/editor');
  expect(response.ok()).toBe(true);
  const installed = await response.json();
  const script = await request.get(installed.entry);
  expect(script.headers()['cache-control']).toContain('immutable');
  expect(script.headers()['content-type']).toContain('javascript');
  expect((await request.get(`/editor/${installed.id}/manifest.json`)).status()).toBe(404);
  expect((await request.get(`/editor/${installed.id}/missing.js`)).status()).toBe(404);
  expect((await request.get(`/editor/${installed.id}/fonts/missing.woff2`)).status()).toBe(404);
});
