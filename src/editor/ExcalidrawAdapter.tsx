import { createElement as h, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Excalidraw,
  MainMenu,
  serializeAsJSON,
  loadFromBlob,
  getSceneVersion,
} from '@excalidraw/excalidraw';
import type { ExcalidrawProps, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import type { Scene } from '../../shared/model';
import '@excalidraw/excalidraw/index.css';

export interface EditorHandle {
  flush(): void;
  destroy(): void;
}
export interface EditorOptions {
  scene: Scene;
  onChange(scene: Scene): void;
  onImport(): void;
  onPending(pending: boolean): void;
}

// This React island is the only module coupled to Excalidraw. The workspace uses Solid.
// No JSX here: both runtimes retain their own rendering and lifecycle boundaries.
export function mountEditor(container: HTMLElement, options: EditorOptions): EditorHandle {
  const root = createRoot(container);
  let flush = () => {};
  let destroyed = false;
  function Editor() {
    const previous = useRef<{ signature: string; viewport: string; files: unknown }>();
    const pending = useRef<Parameters<NonNullable<ExcalidrawProps['onChange']>>>();
    const timer = useRef<ReturnType<typeof setTimeout>>();
    const viewportTimer = useRef<ReturnType<typeof setTimeout>>();
    flush = () => {
      clearTimeout(timer.current);
      timer.current = undefined;
      clearTimeout(viewportTimer.current);
      viewportTimer.current = undefined;
      const snapshot = pending.current;
      pending.current = undefined;
      if (!snapshot || destroyed) return;
      const [elements, state, files] = snapshot;
      const serialized = JSON.parse(serializeAsJSON(elements, state, files, 'local')) as Scene;
      serialized.appState = {
        ...serialized.appState,
        scrollX: state.scrollX,
        scrollY: state.scrollY,
        zoom: state.zoom,
      };
      options.onChange(serialized);
      options.onPending(false);
    };
    const change: ExcalidrawProps['onChange'] = (elements, state, files) => {
      // Pointer movement and selection do not serialize scenes. Drawing/zoom snapshots
      // are coalesced outside the input handler, with a bounded delay during long strokes.
      const signature = [
        getSceneVersion(elements),
        state.viewBackgroundColor,
        state.gridSize,
        state.gridStep,
        state.gridModeEnabled,
      ].join('|');
      const viewport = [state.scrollX, state.scrollY, state.zoom.value].join('|');
      const contentChanged =
        previous.current?.signature !== signature || previous.current.files !== files;
      if (!contentChanged && previous.current?.viewport === viewport) return;
      previous.current = { signature, viewport, files };
      pending.current = [elements, state, files];
      options.onPending(true);
      clearTimeout(viewportTimer.current);
      if (contentChanged) {
        if (!timer.current) timer.current = setTimeout(() => flush(), 160);
      } else if (!timer.current) {
        // Continuous pan/zoom keeps only the latest references. Serialize after the
        // gesture pauses, or synchronously when switching, exporting or hiding.
        viewportTimer.current = setTimeout(() => flush(), 500);
      }
    };
    useEffect(
      () => () => {
        clearTimeout(timer.current);
        clearTimeout(viewportTimer.current);
      },
      [],
    );
    return h(
      Excalidraw,
      {
        initialData: options.scene as unknown as ExcalidrawInitialDataState,
        onChange: change,
        onPointerUp: () => flush(),
        langCode: 'en',
        UIOptions: { canvasActions: { loadScene: false } },
      },
      h(
        MainMenu,
        null,
        h(MainMenu.Item, { onSelect: options.onImport, children: 'Import as a new canvas…' }),
        h(MainMenu.DefaultItems.SaveToActiveFile),
        h(MainMenu.DefaultItems.Export),
        h(MainMenu.DefaultItems.SaveAsImage),
        h(MainMenu.DefaultItems.ClearCanvas),
        h(MainMenu.Separator),
        h(MainMenu.DefaultItems.ChangeCanvasBackground),
      ),
    );
  }
  root.render(h(Editor));
  return {
    flush: () => flush(),
    destroy: () => {
      destroyed = true;
      root.unmount();
    },
  };
}

export async function importScene(file: File): Promise<Scene> {
  const restored = await loadFromBlob(file, null, null);
  const scene = JSON.parse(
    serializeAsJSON(restored.elements, restored.appState, restored.files ?? {}, 'local'),
  ) as Scene;
  scene.appState = {
    ...scene.appState,
    scrollX: restored.appState.scrollX,
    scrollY: restored.appState.scrollY,
    zoom: restored.appState.zoom,
  };
  // The public blob loader resets viewport. Workspace files preserve it explicitly.
  const imported = JSON.parse(await file.text()) as Scene;
  for (const key of ['scrollX', 'scrollY'] as const) {
    const value = imported.appState?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) scene.appState[key] = value;
  }
  const zoom = imported.appState?.zoom as { value?: unknown } | undefined;
  if (typeof zoom?.value === 'number' && Number.isFinite(zoom.value))
    scene.appState.zoom = { value: Math.min(30, Math.max(0.1, zoom.value)) };
  return scene;
}
