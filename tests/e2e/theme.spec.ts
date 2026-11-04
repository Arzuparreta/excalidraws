import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { Document } from '../../shared/model';

const settings = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'Settings', exact: true });
const option = (page: Page, name: string) => page.getByRole('menuitemradio', { name, exact: true });
async function choose(page: Page, name: string) {
  await settings(page).click();
  await option(page, name).click();
  await expect(menu(page)).toHaveCount(0);
  await expect(settings(page)).toBeFocused();
}
async function themed(page: Page, theme: 'light' | 'dark') {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('.excalidraw')).toBeVisible();
  if (theme === 'dark') await expect(page.locator('.excalidraw')).toHaveClass(/theme--dark/);
  else await expect(page.locator('.excalidraw')).not.toHaveClass(/theme--dark/);
  await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
}
async function open(page: Page, request: APIRequestContext, path: string) {
  expect((await request.post('/api/entries', { data: { path, kind: 'file' } })).ok()).toBe(true);
  await page.goto(`/?canvas=${encodeURIComponent(path)}`);
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  await expect(page.locator('.save-status')).toContainText('Saved');
}
const read = async (request: APIRequestContext, path: string): Promise<Document> =>
  (await request.get(`/api/document?path=${encodeURIComponent(path)}`)).json();

test('system appearance is the default; manual themes persist and override live system changes', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page, request, 'Theme preferences.excalidraw');
  await themed(page, 'dark');
  await settings(page).click();
  await expect(option(page, 'System')).toHaveAttribute('aria-checked', 'true');
  await expect(option(page, 'System')).toBeFocused();
  const trigger = (await settings(page).boundingBox())!;
  const popup = (await menu(page).boundingBox())!;
  expect(trigger.x).toBeLessThan(30);
  expect(trigger.y).toBeGreaterThan(page.viewportSize()!.height - 60);
  expect(popup.y + popup.height).toBeLessThanOrEqual(trigger.y);
  await page.screenshot({ path: 'test-results/theme-dark-desktop.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeFocused();
  await page.emulateMedia({ colorScheme: 'light' });
  await themed(page, 'light');
  await settings(page).click();
  await page.keyboard.press('End');
  await expect(option(page, 'Dark')).toBeFocused();
  await page.keyboard.press('Enter');
  await themed(page, 'dark');
  await page.reload();
  await themed(page, 'dark');
  await settings(page).click();
  await expect(option(page, 'Dark')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await choose(page, 'Light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await themed(page, 'light');
  await page.reload();
  await themed(page, 'light');
  await settings(page).click();
  await expect(option(page, 'Light')).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: 'test-results/theme-light-desktop.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await choose(page, 'System');
  await themed(page, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await themed(page, 'light');
  expect(errors).toEqual([]);
});

test('theme changes preserve the editor, document bytes, viewport and drawing undo history', async ({
  page,
  request,
}) => {
  const path = 'Theme drawing continuity.excalidraw';
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page, request, path);
  const canvas = page.locator('.excalidraw canvas.interactive');
  const element = await canvas.elementHandle();
  await page.getByRole('radio', { name: 'Rectangle', exact: true }).locator('..').click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await read(request, path)).scene.elements.length).toBe(1);
  await expect(page.locator('.save-status')).toContainText('Saved');
  const before = await read(request, path);
  await choose(page, 'Dark');
  await themed(page, 'dark');
  await choose(page, 'Light');
  await themed(page, 'light');
  expect(await element!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(page.locator('.editor-mount .excalidraw')).toHaveCount(1);
  expect((await read(request, path)).revision).toBe(before.revision);
  await page.locator('.excalidraw').focus();
  await page.keyboard.press('Control+z');
  await expect
    .poll(
      async () =>
        (await read(request, path)).scene.elements.filter((item) => !item.isDeleted).length,
    )
    .toBe(0);
});

test('settings fit touch drawers and remain usable when browser storage is disabled', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage disabled', 'SecurityError');
      },
    });
  });
  try {
    await open(page, request, 'Theme mobile.excalidraw');
    await themed(page, 'dark');
    await page.getByRole('button', { name: 'Open explorer', exact: true }).click();
    await settings(page).click();
    const popup = (await menu(page).boundingBox())!;
    expect(popup.x).toBeGreaterThanOrEqual(0);
    expect(popup.x + popup.width).toBeLessThanOrEqual(390);
    expect(popup.y + popup.height).toBeLessThanOrEqual((await settings(page).boundingBox())!.y);
    expect((await settings(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: 'test-results/theme-dark-mobile.png', animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(settings(page)).toBeFocused();
    await expect(page.getByRole('complementary', { name: 'Canvas explorer' })).toBeVisible();
    await choose(page, 'Light');
    await themed(page, 'light');
    await choose(page, 'System');
    await themed(page, 'dark');
    await page.setViewportSize({ width: 844, height: 390 });
    await settings(page).click();
    await expect(menu(page)).toBeVisible();
    const landscape = (await menu(page).boundingBox())!;
    expect(landscape.y).toBeGreaterThanOrEqual(0);
    expect(landscape.y + landscape.height).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: 'test-results/theme-dark-landscape.png',
      animations: 'disabled',
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
