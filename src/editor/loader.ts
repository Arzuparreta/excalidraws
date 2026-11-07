import type { EditorModule } from './contract';
import type { EditorLocation, EditorStatus } from '../../shared/editor';

let loaded: Promise<EditorModule> | undefined;
const listeners = new Set<(message: string) => void>();
const report = (message: string) => listeners.forEach((listener) => listener(message));

async function location(exclude?: string): Promise<EditorLocation> {
  const response = await fetch(
    `/api/editor${exclude ? `?exclude=${encodeURIComponent(exclude)}` : ''}`,
    { signal: AbortSignal.timeout(150_000) },
  );
  if (!response.ok)
    throw new Error(
      'Excalidraw could not be downloaded. Check the server connection and try again.',
    );
  const result = (await response.json()) as EditorLocation;
  const prefix = `/editor/${result.id}/`;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(result.id) ||
    !result.entry?.startsWith(prefix) ||
    !Array.isArray(result.css) ||
    !result.css.length ||
    result.css.some((file) => !file.startsWith(prefix))
  )
    throw new Error('The server returned an incompatible editor.');
  return result;
}

async function activate(editor: EditorLocation): Promise<EditorModule> {
  report(`Loading Excalidraw ${editor.packageVersion}…`);
  const styles: HTMLLinkElement[] = [];
  try {
    await Promise.all(
      editor.css.map(
        (href) =>
          new Promise<void>((resolve, reject) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            styles.push(link);
            const timer = setTimeout(() => {
              link.remove();
              reject(new Error('Editor styles could not be loaded.'));
            }, 20_000);
            link.onload = () => {
              clearTimeout(timer);
              resolve();
            };
            link.onerror = () => {
              clearTimeout(timer);
              reject(new Error('Editor styles could not be loaded.'));
            };
            document.head.append(link);
          }),
      ),
    );
    const module = (await import(/* @vite-ignore */ editor.entry)) as EditorModule;
    if (
      module.contract !== 1 ||
      typeof module.mountEditor !== 'function' ||
      typeof module.importScene !== 'function'
    )
      throw new Error('The downloaded editor is incompatible with this shell.');
    return module;
  } catch (error) {
    styles.forEach((link) => link.remove());
    throw error;
  }
}

/** Pin one editor per page so downloads never interrupt an open drawing. */
export async function loadEditor(onProgress?: (message: string) => void): Promise<EditorModule> {
  if (onProgress) listeners.add(onProgress);
  try {
    if (!loaded)
      loaded = (async () => {
        report('Preparing Excalidraw…');
        let polling = false;
        const timer = setInterval(async () => {
          if (polling) return;
          polling = true;
          try {
            const response = await fetch('/api/editor/status', {
              signal: AbortSignal.timeout(3000),
            });
            if (!response.ok) return;
            const status = (await response.json()) as EditorStatus;
            if (status.state === 'checking') report('Checking for Excalidraw…');
            if (status.state === 'downloading')
              report(
                `Downloading Excalidraw… ${status.total ? Math.min(100, Math.round((status.received / status.total) * 100)) + '%' : ''}`,
              );
          } catch {
            /* The main request reports actionable errors. */
          } finally {
            polling = false;
          }
        }, 400);
        try {
          const editor = await location();
          clearInterval(timer);
          try {
            return await activate(editor);
          } catch {
            return await activate(await location(editor.id));
          }
        } finally {
          clearInterval(timer);
        }
      })().catch((error: unknown) => {
        loaded = undefined;
        throw error;
      });
    return await loaded;
  } finally {
    if (onProgress) listeners.delete(onProgress);
  }
}
