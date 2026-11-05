import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { Document } from '../../shared/model';

const document = async (request: APIRequestContext, path: string): Promise<Document> =>
  (await request.get(`/api/document?path=${encodeURIComponent(path)}`)).json();
async function create(page: Page, name: string) {
  const newCanvas = page.locator('.explorer-actions .new-canvas');
  await expect(newCanvas).toBeEnabled();
  const root = page.getByRole('button', { name: 'Create in root', exact: true });
  if (await root.isVisible()) await root.click();
  const createdResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/entries' &&
      response.request().method() === 'POST' &&
      response.status() === 201,
  );
  await newCanvas.click();
  const created: Document = await (await createdResponse).json();
  await expect(page).toHaveURL((url) => url.searchParams.get('canvas') === created.path);
  await expect(page.locator('.title-button')).toHaveText(
    created.path
      .split('/')
      .at(-1)!
      .replace(/\.excalidraw$/, ''),
  );
  await expect(page.locator('.title-button')).toBeEnabled();
  await page.locator('.title-button').click();
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Canvas name', exact: true })).toHaveCount(0);
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
  await page.locator('.title-button').click();
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).fill('A plan');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A plan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More ways to create', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
  await page.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Projects');
  await page.getByRole('textbox', { name: 'Folder name', exact: true }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Folder name', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Actions for A plan', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
  await page.screenshot({ path: 'test-results/move-in-sidebar-desktop.png' });
  await page.getByRole('option', { name: /^Projects/ }).click();
  await expect(page.getByRole('dialog', { name: 'Move to folder' })).toHaveCount(0);
  await expect
    .poll(async () => (await document(request, 'Projects/A plan.excalidraw')).scene.elements.length)
    .toBe(1);
  await page.getByRole('button', { name: 'Actions for A plan', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move to trash', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await page.getByRole('button', { name: 'Restore A plan', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore A plan', exact: true })).toHaveCount(0);
  expect((await document(request, 'Projects/A plan.excalidraw')).scene.elements).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('dirty external edits conflict without overwriting either version; save a copy', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await create(page, 'Conflict');
  await expect(page.locator('.save-status')).toContainText('Saved');
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
  await expect(page.getByRole('heading', { name: 'Conflict (copy)', exact: true })).toBeVisible();
  await page.locator('.title-button').click();
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).fill('My copy');
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Canvas name', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'My copy', exact: true })).toBeVisible();
  expect((await document(request, 'My copy.excalidraw')).scene.elements).toHaveLength(1);
  expect((await document(request, base.path)).scene.appState.viewBackgroundColor).toBe('#fce7f3');
});

test('offline draft survives reload and is saved after reconnection', async ({ page, request }) => {
  await page.goto('/');
  await create(page, 'Draft');
  await expect(page.locator('.save-status')).toContainText('Saved');
  await page.route('**/api/document', async (route) => {
    if (route.request().method() === 'PUT') return route.abort('failed');
    await route.continue();
  });
  await draw(page);
  await expect(page.locator('.save-status')).toContainText('Not saved');
  expect((await document(request, 'Draft.excalidraw')).scene.elements).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Draft', exact: true })).toBeVisible();
  await expect(page.locator('.save-status')).toContainText('Not saved');
  await page.unroute('**/api/document');
  // A queued autosave may recover as soon as the route is restored, removing the
  // retry button before Playwright can click it on a busy machine.
  await Promise.any([
    page.getByRole('button', { name: 'Retry saving', exact: true }).click({ timeout: 2000 }),
    expect(page.locator('.save-status')).toContainText('Saved'),
  ]);
  await expect(page.locator('.save-status')).toContainText('Saved');
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
  const createInRoot = page.getByRole('button', { name: 'Create in root', exact: true });
  if (await createInRoot.isVisible()) await createInRoot.click();
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
  await expect(page.locator('.save-status')).toContainText('Saved');
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
  await expect(page.locator('.save-status')).toContainText('Saved');
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

test('global canvas search works from the editor and preserves its link shortcut', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'Search shortcut');
  const search = page.getByRole('textbox', { name: 'Search canvases', exact: true });
  const canvas = page.locator('.excalidraw canvas.interactive');
  const editor = page.locator('.excalidraw-container');
  await expect(page.locator('.search-shortcut')).toHaveText('Ctrl ⇧ F');
  await canvas.click();
  await page.keyboard.press('Control+k');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+Shift+F');
  await expect(search).toBeFocused();
  await search.fill('Search shortcut');
  await expect(page.getByRole('button', { name: 'Search shortcut', exact: true })).toBeVisible();
  await search.fill('');
  await canvas.click();
  await page.keyboard.press('Meta+Shift+F');
  await expect(search).toBeFocused();
  await page.getByRole('heading', { name: 'Search shortcut', exact: true }).click();
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await page.screenshot({ path: 'test-results/search-shortcut.png', fullPage: true });
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
  await expect(page.locator('.save-status')).toContainText('Saved');
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
  await expect(page.locator('.save-status')).toContainText('Saved');
  await request.post('/api/trash', { data: { path: 'Missing.excalidraw' } });
  await expect(page.locator('.save-status')).toContainText('Conflict');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Missing', exact: true })).toBeVisible();
  await expect(page.locator('.save-status')).toContainText('Conflict');
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Missing (copy)', exact: true })).toBeVisible();
  await page.locator('.title-button').click();
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).fill('Recovered');
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Canvas name', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Recovered', exact: true })).toBeVisible();
  expect((await document(request, 'Recovered.excalidraw')).scene.elements).toHaveLength(1);
});

test('creation has explicit destinations and concurrent name collisions are retried', async ({
  page,
  request,
}) => {
  await request.post('/api/entries', { data: { path: 'Naming workflow', kind: 'folder' } });
  await request.post('/api/entries', {
    data: { path: 'Naming workflow/Untitled canvas.excalidraw', kind: 'file' },
  });
  await page.goto('/');
  await expect(page.locator('.explorer-actions .new-canvas')).toBeEnabled();
  const createHere = async (label: string) => {
    await page.getByRole('textbox', { name: 'Search canvases' }).fill('Naming workflow');
    await page.getByRole('button', { name: 'Actions for Naming workflow', exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };
  let collided = false;
  await page.route('**/api/entries', async (route) => {
    if (route.request().method() === 'POST' && !collided) {
      collided = true;
      await request.post('/api/entries', { data: route.request().postDataJSON() });
    }
    await route.continue();
  });
  await createHere('New canvas here');
  await expect(
    page.getByRole('heading', { name: 'Untitled canvas (2)', exact: true }),
  ).toBeVisible();
  expect((await document(request, 'Naming workflow/Untitled canvas (2).excalidraw')).path).toBe(
    'Naming workflow/Untitled canvas (2).excalidraw',
  );
  await createHere('New canvas here');
  await expect(
    page.getByRole('heading', { name: 'Untitled canvas (3)', exact: true }),
  ).toBeVisible();
  await createHere('New folder here');
  const folderName = page.getByRole('textbox', { name: 'Folder name', exact: true });
  await expect(folderName).toBeFocused();
  await folderName.press('Escape');
  await expect(page.locator('[data-entry-path="Naming workflow/Untitled folder"]')).toBeVisible();
  await createHere('New folder here');
  await expect(folderName).toHaveValue('Untitled folder (1)');
  await folderName.fill('Ideas.excalidraw');
  await folderName.press('Enter');
  const tree = await (await request.get('/api/entries')).json();
  expect(tree.some((e: { path: string }) => e.path === 'Naming workflow/Ideas.excalidraw')).toBe(
    true,
  );
  expect(
    tree.some(
      (e: { path: string }) => e.path === 'Naming workflow/Untitled folder/Untitled folder',
    ),
  ).toBe(false);
  // Expanding a folder never changes the global create destination.
  await page.locator('[data-entry-path="Naming workflow"] .file-select').click();
  await page.locator('.explorer-actions .new-canvas').click();
  await expect(page.locator('.processing')).toHaveCount(0);
  const entries = await (await request.get('/api/entries')).json();
  const name = await page.locator('.document-title h1').getAttribute('aria-label');
  expect(entries.some((e: { path: string }) => e.path === `${name}.excalidraw`)).toBe(true);
  await expect(page.locator('dialog')).toHaveCount(0);
});

test('inline naming handles errors, cancellation, blur and creation without losing the clicked action', async ({
  page,
  request,
}) => {
  await request.post('/api/entries', {
    data: { path: 'Inline occupied.excalidraw', kind: 'file' },
  });
  await page.goto('/');
  await create(page, 'Inline original');
  await page.locator('.title-button').click();
  const name = page.getByRole('textbox', { name: 'Canvas name', exact: true });
  await expect(name).toBeFocused();
  await name.fill('');
  await name.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Enter a name.');
  await name.fill('Invalid/name');
  await name.press('Enter');
  await expect(page.getByRole('alert')).toContainText('slashe');
  await name.fill('Inline occupied');
  await name.press('Enter');
  await expect(page.getByRole('alert')).toContainText('already exists');
  await name.press('Escape');
  await expect(page.getByRole('heading', { name: 'Inline original', exact: true })).toBeVisible();
  await page.locator('.title-button').click();
  await name.fill('');
  await name.pressSequentially('Inline blur');
  await expect(name).toHaveValue('Inline blur');
  await page.getByRole('textbox', { name: 'Search canvases' }).click();
  await expect(page.getByRole('heading', { name: 'Inline blur', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search canvases' })).toBeFocused();
  await page.locator('.title-button').click();
  await name.fill('Inline before creation');
  await page.getByRole('button', { name: 'New canvas', exact: true }).click({ delay: 120 });
  await expect(page.getByRole('heading', { name: /^Untitled canvas/ })).toBeVisible();
  expect((await document(request, 'Inline before creation.excalidraw')).path).toBe(
    'Inline before creation.excalidraw',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('renaming an open parent folder retains the editor, saves to the new path and updates navigation', async ({
  page,
  request,
}) => {
  await request.post('/api/entries', { data: { path: 'Parent workflow', kind: 'folder' } });
  await request.post('/api/entries', {
    data: { path: 'Parent workflow/Child.excalidraw', kind: 'file' },
  });
  await page.goto('/');
  await create(page, 'Before folder rename');
  await page.getByRole('textbox', { name: 'Search canvases' }).fill('Parent workflow/Child');
  await page.getByRole('button', { name: 'Child', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Child', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search canvases' }).fill('');
  await draw(page);
  const canvas = await page.locator('.excalidraw canvas.interactive').elementHandle();
  await page.locator('[data-entry-path="Parent workflow"]').focus();
  await page.keyboard.press('F2');
  const name = page.getByRole('textbox', { name: 'Folder name', exact: true });
  await expect(name).toHaveValue('Parent workflow');
  await name.fill('Renamed parent');
  await page.screenshot({ path: 'test-results/inline-folder-desktop.png' });
  await name.press('Enter');
  await expect(page.locator('.breadcrumb-parent')).toContainText('Renamed parent');
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await document(request, 'Renamed parent/Child.excalidraw')).scene.elements.filter(
          (e) => !e.isDeleted,
        ).length,
    )
    .toBe(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Before folder rename', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Child', exact: true })).toBeVisible();
  await expect(page.locator('.breadcrumb-parent')).toContainText('Renamed parent');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Child', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.title-button').click();
  await page.getByRole('textbox', { name: 'Canvas name', exact: true }).fill('Mobile child');
  await page.screenshot({ path: 'test-results/inline-canvas-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mobile child', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('inline drafts synchronize between the current tree row and title without moving files per keystroke', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await create(page, 'Shared name');
  const row = page.locator('[data-entry-path="Shared name.excalidraw"]');
  await expect(row).toHaveAttribute('aria-current', 'page');
  const heading = await page.locator('.document-title h1').elementHandle();
  const canvas = await page.locator('.excalidraw canvas.interactive').elementHandle();
  const moves: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/move')
      moves.push(request.postData()!);
  });
  await page.locator('.title-button').click();
  const input = page.getByRole('textbox', { name: 'Canvas name', exact: true });
  await input.fill('');
  for (const letter of 'Live draft') {
    const previous = await input.inputValue();
    await input.pressSequentially(letter);
    await expect(row.locator('.file-name')).toHaveText(previous + letter);
  }
  expect(moves).toHaveLength(0);
  expect(await heading!.evaluate((node) => node.isConnected)).toBe(true);
  await input.press('Escape');
  await expect(row.locator('.file-name')).toHaveText('Shared name');
  await row.focus();
  await page.keyboard.press('F2');
  await input.fill('Committed name');
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: 'Committed name', exact: true })).toBeVisible();
  expect(moves).toHaveLength(1);
  expect(await canvas!.evaluate((node) => node.isConnected)).toBe(true);
  expect((await document(request, 'Committed name.excalidraw')).path).toBe(
    'Committed name.excalidraw',
  );
  await create(page, 'Another canvas');
  const inactive = page.locator('[data-entry-path="Committed name.excalidraw"]');
  await inactive.focus();
  await page.keyboard.press('F2');
  await input.fill('Inactive rename');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  const filtered = page.locator('[data-entry-path="Inactive rename.excalidraw"]');
  await expect(filtered).toBeVisible();
  await expect(filtered).not.toHaveClass(/pending/);
  await page.getByRole('textbox', { name: 'Search canvases' }).fill('Inactive');
  await expect(page.locator('.file-row')).toHaveCount(1);
  await filtered.focus();
  await page.keyboard.press('F2');
  await input.fill('Search draft');
  await expect(page.locator('.file-row')).toHaveCount(1);
  await input.press('Escape');
  await page.getByRole('textbox', { name: 'Search canvases' }).fill('');
  await expect(page.getByRole('heading', { name: 'Another canvas', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/shared-name-desktop.png' });
  await page.locator('.title-button').focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open explorer', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for Another canvas', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await input.fill('Mobile sidebar');
  await page.screenshot({ path: 'test-results/shared-name-mobile.png' });
  await input.press('Enter');
  await expect(page.locator('[data-entry-path="Mobile sidebar.excalidraw"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
