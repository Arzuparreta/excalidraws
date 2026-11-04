import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { Document } from '../../shared/model';

const document = async (request: APIRequestContext, path: string): Promise<Document> =>
  (await request.get(`/api/document?path=${encodeURIComponent(path)}`)).json();
async function create(page: Page, name: string) {
  await page.getByRole('button', { name: 'Nuevo lienzo', exact: false }).click();
  await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Crear', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.locator('.excalidraw canvas').first()).toBeVisible();
}
async function draw(page: Page) {
  await expect(page.getByLabel('Procesando', { exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Rectángulo', exact: true }).locator('..').click();
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
  await create(page, 'Primero');
  await draw(page);
  // No wait for the debounce: creating another canvas has to flush first.
  await create(page, 'Segundo');
  const first = await document(request, 'Primero.excalidraw');
  expect(first.scene.elements.filter((e) => !e.isDeleted)).toHaveLength(1);
  await page.getByRole('button', { name: 'Primero', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Primero', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Primero', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Renombrar lienzo', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill('Un plan');
  await page.getByRole('button', { name: 'Renombrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Un plan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nueva carpeta', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill('Proyectos');
  await page.getByRole('button', { name: 'Crear', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Acciones de Un plan', exact: true }).click();
  await page.getByRole('button', { name: 'Mover a…', exact: true }).click();
  await page.getByRole('combobox', { name: 'Carpeta', exact: true }).selectOption('Proyectos');
  await page.getByRole('button', { name: 'Mover', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(
      async () => (await document(request, 'Proyectos/Un plan.excalidraw')).scene.elements.length,
    )
    .toBe(1);
  await page.getByRole('button', { name: 'Acciones de Un plan', exact: true }).click();
  await page.getByRole('button', { name: 'A la papelera', exact: true }).click();
  await page.getByRole('button', { name: 'Mover a la papelera', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Papelera', exact: true }).click();
  await page.getByRole('button', { name: 'Restaurar Un plan', exact: true }).click();
  await expect(page.getByText('La papelera está vacía.')).toBeVisible();
  expect((await document(request, 'Proyectos/Un plan.excalidraw')).scene.elements).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('dirty external edits conflict without overwriting either version; save a copy', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await create(page, 'Conflicto');
  await expect(page.getByRole('status')).toContainText('Guardado');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/document', async (route) => {
    if (route.request().method() === 'PUT') await gate;
    await route.continue();
  });
  await draw(page);
  const base = await document(request, 'Conflicto.excalidraw');
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
    page.getByRole('alert').filter({ hasText: /ha cambiado|modificación externa/ }),
  ).toBeVisible();
  expect((await document(request, base.path)).scene.elements).toHaveLength(0);
  await page.getByRole('button', { name: 'Guardar una copia', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill('Mi copia');
  await page.getByRole('button', { name: 'Guardar copia', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mi copia', exact: true })).toBeVisible();
  expect((await document(request, 'Mi copia.excalidraw')).scene.elements).toHaveLength(1);
  expect((await document(request, base.path)).scene.appState.viewBackgroundColor).toBe('#fce7f3');
});

test('offline draft survives reload and is saved after reconnection', async ({ page, request }) => {
  await page.goto('/');
  await create(page, 'Borrador');
  await expect(page.getByRole('status')).toContainText('Guardado');
  await page.route('**/api/document', async (route) => {
    if (route.request().method() === 'PUT') return route.abort('failed');
    await route.continue();
  });
  await draw(page);
  await expect(page.getByRole('status')).toContainText('Sin guardar');
  expect((await document(request, 'Borrador.excalidraw')).scene.elements).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Borrador', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Sin guardar');
  await page.unroute('**/api/document');
  await page.getByRole('button', { name: 'Reintentar guardado', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Guardado');
  expect((await document(request, 'Borrador.excalidraw')).scene.elements).toHaveLength(1);
});

test('images and viewport survive import, switching and export; clean external changes reload', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Nuevo lienzo', exact: false })).toBeEnabled();
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
  await page.getByLabel('Importar archivos', { exact: true }).setInputFiles({
    name: 'Imagen.excalidraw',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scene)),
  });
  await expect(page.getByRole('heading', { name: 'Imagen', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restablecer zoom', exact: true })).toHaveText(
    '125%',
  );
  await page.getByRole('button', { name: 'Acercarse', exact: true }).click();
  const zoomLabel = await page
    .getByRole('button', { name: 'Restablecer zoom', exact: true })
    .textContent();
  await expect(page.getByRole('status')).toContainText('Guardado');
  await create(page, 'Cambio');
  await page.getByRole('button', { name: 'Imagen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Imagen', exact: true })).toBeVisible();
  const before = await document(request, 'Imagen.excalidraw');
  expect(before.scene.files.pixel).toBeTruthy();
  expect(before.scene.elements[0].fileId).toBe('pixel');
  await expect(page.getByRole('button', { name: 'Restablecer zoom', exact: true })).toHaveText(
    zoomLabel!,
  );
  expect(before.scene.appState.scrollX).not.toBe(0);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar lienzo', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('Imagen.excalidraw');
  const stream = await download.createReadStream();
  const buffers = [];
  for await (const chunk of stream!) buffers.push(chunk);
  const exported = JSON.parse(Buffer.concat(buffers).toString());
  expect(exported.files.pixel).toBeTruthy();
  await expect(page.getByRole('status')).toContainText('Guardado');
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
  await page.getByRole('button', { name: 'Abrir explorador', exact: true }).click();
  await create(page, 'Móvil');
  await page.getByRole('button', { name: 'Abrir explorador', exact: true }).click();
  await page.getByRole('textbox', { name: 'Buscar lienzos', exact: true }).fill('Móvil');
  await expect(page.getByRole('button', { name: 'Móvil', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Móvil', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Explorador de lienzos', exact: true }),
  ).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Móvil', exact: true })).toBeVisible();
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
  await create(page, 'Texto y flechas');
  await page.getByRole('radio', { name: 'Texto', exact: true }).locator('..').click();
  const box = (await page.locator('.excalidraw canvas.interactive').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.locator('.excalidraw textarea').fill('Una idea que se conserva');
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Flecha', exact: true }).locator('..').click();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('status')).toContainText('Guardado');
  const saved = await document(request, 'Texto y flechas.excalidraw');
  expect(saved.scene.elements.map((e) => e.type).sort()).toEqual(['arrow', 'text']);
  expect(saved.scene.elements.find((e) => e.type === 'text')?.text).toBe(
    'Una idea que se conserva',
  );
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('external deletion preserves the open scene across reload until saved as a copy', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await create(page, 'Desaparecido');
  await draw(page);
  await expect(page.getByRole('status')).toContainText('Guardado');
  await request.post('/api/trash', { data: { path: 'Desaparecido.excalidraw' } });
  await expect(page.getByRole('status')).toContainText('Conflicto');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Desaparecido', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Conflicto');
  await page.getByRole('button', { name: 'Guardar una copia', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill('Rescatado');
  await page.getByRole('button', { name: 'Guardar copia', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Rescatado', exact: true })).toBeVisible();
  expect((await document(request, 'Rescatado.excalidraw')).scene.elements).toHaveLength(1);
});
