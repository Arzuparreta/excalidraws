import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { Document } from '../../shared/model';

const document = async (request: APIRequestContext, path: string): Promise<Document> =>
  (await request.get(`/api/document?path=${encodeURIComponent(path)}`)).json();
async function create(page: Page, name: string) {
  await page.getByRole('button', { name: 'New canvas', exact: false }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.locator('.excalidraw canvas').first()).toBeVisible();
}
async function draw(page: Page) {
  await expect(page.getByLabel('Processing', { exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Rectangle', exact: true }).locator('..').click();
  const canvas = page.locator('.excalidraw canvas.interactive');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('No editor canvas');
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.62, { steps: 10 });
  await page.mouse.up();
}

test('draw, immediately switch, reload, rename, move, trash and restore real documents', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await create(page, 'First');
  await draw(page);
  // No wait for the debounce: creating another canvas has to flush first.
  await create(page, 'Second');
  const first = await document(request, 'First.excalidraw');
  expect(first.scene.elements.filter((e) => !e.isDeleted)).toHaveLength(1);
  await page.getByRole('button', { name: 'First', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'First', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'First', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rename canvas', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('A plan');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A plan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Projects');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Actions for A plan', exact: true }).click();
  await page.getByRole('button', { name: 'Move to…', exact: true }).click();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).selectOption('Projects');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(async () => (await document(request, 'Projects/A plan.excalidraw')).scene.elements.length)
    .toBe(1);
  await page.getByRole('button', { name: 'Actions for A plan', exact: true }).click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await page.getByRole('button', { name: 'Restore A plan', exact: true }).click();
  await expect(page.getByText('The trash is empty.')).toBeVisible();
  expect((await document(request, 'Projects/A plan.excalidraw')).scene.elements).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('dirty external edits conflict without overwriting either version; save a copy', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await create(page, 'Conflict');
  await expect(page.getByRole('status')).toContainText('Saved');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/document', async (route) => {
    if (route.request().method() === 'PUT') await gate;
    await route.continue();
  });
  await draw(page);
  const base = await document(request, 'Conflict.excalidraw');
  const scene = {
    ...base.scene,
    appState: { ...base.scene.appState, viewBackgroundColor: '#fce7f3' },
  };
  expect(
    (
      await request.put('/api/document', {
        data: { path: base.path, revision: base.revision, scene },
      })
    ).ok(),
  ).toBe(true);
  release();
  await expect(
    page.getByRole('alert').filter({ hasText: /has changed|changed externally/ }),
  ).toBeVisible();
  expect((await document(request, base.path)).scene.elements).toHaveLength(0);
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('My copy');
  await page.getByRole('button', { name: 'Save copy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My copy', exact: true })).toBeVisible();
  expect((await document(request, 'My copy.excalidraw')).scene.elements).toHaveLength(1);
  expect((await document(request, base.path)).scene.appState.viewBackgroundColor).toBe('#fce7f3');
});

test('offline draft survives reload and is saved after reconnection', async ({ page, request }) => {
  await page.goto('/');
  await create(page, 'Draft');
  await expect(page.getByRole('status')).toContainText('Saved');
  await page.route('**/api/document', async (route) => {
    if (route.request().method() === 'PUT') return route.abort('failed');
    await route.continue();
  });
  await draw(page);
  await expect(page.getByRole('status')).toContainText('Not saved');
  expect((await document(request, 'Draft.excalidraw')).scene.elements).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Draft', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Not saved');
  await page.unroute('**/api/document');
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  expect((await document(request, 'Draft.excalidraw')).scene.elements).toHaveLength(1);
});

test('images and viewport survive import, switching and export; clean external changes reload', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New canvas', exact: false })).toBeEnabled();
  const now = Date.now();
  const scene = {
    type: 'excalidraw',
    version: 2,
    source: 'test',
    elements: [
      {
        id: 'image-element',
        type: 'image',
        x: 25,
        y: 35,
        width: 100,
        height: 100,
        angle: 0,
        strokeColor: 'transparent',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 100,
        groupIds: [],
        frameId: null,
        index: 'a0',
        roundness: null,
        seed: 123,
        version: 1,
        versionNonce: 123,
        isDeleted: false,
        boundElements: null,
        updated: now,
        link: null,
        locked: false,
        fileId: 'pixel',
        status: 'saved',
        scale: [1, 1],
        crop: null,
      },
    ],
    appState: { scrollX: 150, scrollY: -80, zoom: { value: 1.25 }, viewBackgroundColor: '#ffffff' },
    files: {
      pixel: {
        id: 'pixel',
        mimeType: 'image/png',
        created: now,
        dataURL:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      },
    },
  };
  // Import uses Excalidraw's public format loader, not a test-only editor hook.
  await page.getByLabel('Import files', { exact: true }).setInputFiles({
    name: 'Image.excalidraw',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene)),
  });
  await expect(page.getByRole('heading', { name: 'Image', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset zoom', exact: true })).toHaveText('125%');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const zoomLabel = await page
    .getByRole('button', { name: 'Reset zoom', exact: true })
    .textContent();
  await expect(page.getByRole('status')).toContainText('Saved');
  await create(page, 'Switch');
  await page.getByRole('button', { name: 'Image', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Image', exact: true })).toBeVisible();
  const before = await document(request, 'Image.excalidraw');
  expect(before.scene.files.pixel).toBeTruthy();
  expect(before.scene.elements[0].fileId).toBe('pixel');
  await expect(page.getByRole('button', { name: 'Reset zoom', exact: true })).toHaveText(
    zoomLabel!,
  );
  expect(before.scene.appState.scrollX).not.toBe(0);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download canvas', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('Image.excalidraw');
  const stream = await download.createReadStream();
  const buffers = [];
  for await (const chunk of stream!) buffers.push(chunk);
  const exported = JSON.parse(Buffer.concat(buffers).toString());
  expect(exported.files.pixel).toBeTruthy();
  await expect(page.getByRole('status')).toContainText('Saved');
  const current = await document(request, before.path);
  await request.put('/api/document', {
    data: {
      path: before.path,
      revision: current.revision,
      scene: {
        ...current.scene,
        appState: { ...current.scene.appState, viewBackgroundColor: '#f0fdf4' },
      },
    },
  });
  // Excalidraw paints the background into its canvas pixels rather than a CSS background.
  await expect
    .poll(
      async () =>
        page
          .locator('.excalidraw canvas.static')
          .evaluate((canvas: HTMLCanvasElement) =>
            Array.from(
              canvas.getContext('2d')!.getImageData(canvas.width - 10, canvas.height - 10, 1, 1)
                .data,
            ),
          ),
      { timeout: 10_000 },
    )
    .toEqual([240, 253, 244, 255]);
  await page.screenshot({ path: 'test-results/workspace-desktop.png', fullPage: true });
});

test('mobile explorer, search and dialogs fit the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open explorer', exact: true }).click();
  await create(page, 'Mobile');
  await page.getByRole('button', { name: 'Open explorer', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search canvases', exact: true }).fill('Mobile');
  await expect(page.getByRole('button', { name: 'Mobile', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mobile', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Canvas explorer', exact: true }),
  ).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Mobile', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/workspace-mobile.png', fullPage: true });
});

test('official text and arrow tools work with all editor assets served locally', async ({
  page,
  request,
}) => {
  const external: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol.startsWith('http') && url.hostname !== '127.0.0.1') {
      external.push(url.toString());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto('/');
  await create(page, 'Text and arrows');
  await page.getByRole('radio', { name: 'Text', exact: true }).locator('..').click();
  const box = (await page.locator('.excalidraw canvas.interactive').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.locator('.excalidraw textarea').fill('An idea worth keeping');
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Arrow', exact: true }).locator('..').click();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('status')).toContainText('Saved');
  const saved = await document(request, 'Text and arrows.excalidraw');
  expect(saved.scene.elements.map((e) => e.type).sort()).toEqual(['arrow', 'text']);
  expect(saved.scene.elements.find((e) => e.type === 'text')?.text).toBe('An idea worth keeping');
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('external deletion preserves the open scene across reload until saved as a copy', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await create(page, 'Missing');
  await draw(page);
  await expect(page.getByRole('status')).toContainText('Saved');
  await request.post('/api/trash', { data: { path: 'Missing.excalidraw' } });
  await expect(page.getByRole('status')).toContainText('Conflict');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Missing', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Conflict');
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Recovered');
  await page.getByRole('button', { name: 'Save copy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recovered', exact: true })).toBeVisible();
  expect((await document(request, 'Recovered.excalidraw')).scene.elements).toHaveLength(1);
});
