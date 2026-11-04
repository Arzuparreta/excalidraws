import { useMemo, useRef } from 'react';
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

// This is the only module coupled to the editor. Use public package exports only.
export function ExcalidrawAdapter({
  scene,
  onChange,
  onImport,
  disabled,
}: {
  scene: Scene;
  onChange(scene: Scene): void;
  onImport(): void;
  disabled?: boolean;
}) {
  const initial = useMemo(() => scene as unknown as ExcalidrawInitialDataState, []);
  const previous = useRef<{ signature: string; files: unknown }>();
  const change: ExcalidrawProps['onChange'] = (elements, state, files) => {
    // Selection and pointer updates must not repeatedly serialize every embedded image.
    const signature = JSON.stringify([
      getSceneVersion(elements),
      state.scrollX,
      state.scrollY,
      state.zoom.value,
      state.viewBackgroundColor,
      state.gridSize,
      state.gridStep,
      state.gridModeEnabled,
    ]);
    if (previous.current?.signature === signature && previous.current.files === files) return;
    previous.current = { signature, files };
    const serialized = JSON.parse(serializeAsJSON(elements, state, files, 'local')) as Scene;
    // Native export strips viewport information; retain it explicitly for document switching.
    serialized.appState = {
      ...serialized.appState,
      scrollX: state.scrollX,
      scrollY: state.scrollY,
      zoom: state.zoom,
    };
    onChange(serialized);
  };
  return (
    <Excalidraw
      initialData={initial}
      onChange={change}
      viewModeEnabled={disabled}
      langCode="en"
      UIOptions={{ canvasActions: { loadScene: false } }}
    >
      <MainMenu>
        <MainMenu.Item onSelect={onImport}>Import as a new canvas…</MainMenu.Item>
        <MainMenu.DefaultItems.SaveToActiveFile />
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  );
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
  // The public blob loader intentionally resets viewport. Native files from this workspace
  // retain it as additional appState, so validate and restore those optional fields.
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
