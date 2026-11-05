import { createElement as h, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  getSceneVersion,
  loadFromBlob,
  newElementWith,
  serializeAsJSON,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { sceneLinks } from '../../shared/canvas';
import type { Scene } from '../../shared/model';
import type { ColorTheme } from '../workspace/theme';
import '@excalidraw/excalidraw/index.css';

export interface EditorHandle {
  flush(): void;
  setTheme(theme: ColorTheme): void;
  destroy(): void;
  /**
   * Adds one text label per item, each linking to `link`, and selects them. With a point in
   * viewport coordinates the first label starts there; otherwise they are centered in view.
   */
  insertLinks(items: { label: string; link: string }[], point?: ViewportPoint): boolean;
  /** Sets the link of the selected elements. A selected label links its container. */
  linkSelection(link: string): boolean;
  /** Replaces element links without adding an undo step. `rewrite` returns the new link. */
  rewriteLinks(rewrite: (link: string) => string | undefined): boolean;
  /** Whether a viewport point is over the drawing area of this editor. */
  contains(point: ViewportPoint): boolean;
}
export type ViewportPoint = { x: number; y: number };
/** What the workspace shows about the drawing: its links and the current selection. */
export interface EditorState {
  links: string[];
  selection: { count: number; text: string };
}
export interface EditorOptions {
  scene: Scene;
  theme: ColorTheme;
  onChange(scene: Scene): void;
  onImport(): void;
  onPending(pending: boolean): void;
  /** Return true when the workspace handled the link, so the browser does not follow it. */
  onLinkOpen(link: string): boolean;
  onState(state: EditorState): void;
}

const uniqueLinks = (elements: readonly unknown[]) => [...new Set(sceneLinks(elements))].sort();
const sameState = (a: EditorState | undefined, b: EditorState) =>
  !!a &&
  a.selection.count === b.selection.count &&
  a.selection.text === b.selection.text &&
  a.links.join('\n') === b.links.join('\n');
// The first line of the selected text, suitable as a canvas name.
const selectionText = (elements: readonly ExcalidrawElement[], state: AppState) => {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const ids = Object.keys(state.selectedElementIds).filter((id) => state.selectedElementIds[id]);
  for (const id of ids) {
    const element = byId.get(id);
    if (!element || element.isDeleted) continue;
    let text = element.type === 'text' ? element.text : '';
    if (!text)
      for (const bound of element.boundElements ?? []) {
        const label = bound.type === 'text' ? byId.get(bound.id) : undefined;
        if (label?.type === 'text' && !label.isDeleted) text = label.text;
      }
    const line = text
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean);
    if (line) return line;
  }
  return '';
};
const selectedCount = (state: AppState) =>
  Object.values(state.selectedElementIds).filter(Boolean).length;

// This React island is the only module coupled to Excalidraw. The workspace uses Solid.
// No JSX here: both runtimes retain their own rendering and lifecycle boundaries.
export function mountEditor(container: HTMLElement, options: EditorOptions): EditorHandle {
  const root = createRoot(container);
  let flush = () => {};
  let destroyed = false;
  let theme = options.theme;
  let api: ExcalidrawImperativeAPI | undefined;
  let host: HTMLElement | undefined;
  let reported: EditorState | undefined;
  const report = (state: EditorState) => {
    if (destroyed || sameState(reported, state)) return;
    reported = state;
    options.onState(state);
  };
  report({ links: uniqueLinks(options.scene.elements), selection: { count: 0, text: '' } });
  function Editor(props: { theme: ColorTheme }) {
    const previous = useRef<{ signature: string; viewport: string; files: unknown }>();
    const selection = useRef<{ ids: unknown; signature: string }>();
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
      // Links and selection are derived only when the scene or the selection changes.
      if (
        selection.current?.ids !== state.selectedElementIds ||
        selection.current.signature !== signature
      ) {
        const links =
          selection.current?.signature === signature && reported
            ? reported.links
            : uniqueLinks(elements);
        selection.current = { ids: state.selectedElementIds, signature };
        const count = selectedCount(state);
        report({
          links,
          selection: { count, text: count ? selectionText(elements, state) : '' },
        });
      }
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
        excalidrawAPI: (value: ExcalidrawImperativeAPI) => {
          api = value;
        },
        onLinkOpen: (element, event) => {
          if (element.link && options.onLinkOpen(element.link)) event.preventDefault();
        },
        langCode: 'en',
        theme: props.theme,
        UIOptions: { canvasActions: { loadScene: false, toggleTheme: false } },
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
  const render = () => root.render(h(Editor, { theme }));
  render();
  host = container;
  // Replaces the whole scene, deleted elements included, so their undo entries survive.
  const update = (
    elements: readonly ExcalidrawElement[],
    capture: (typeof CaptureUpdateAction)[keyof typeof CaptureUpdateAction],
    appState?: Partial<AppState>,
  ) => {
    api?.updateScene({
      elements,
      ...(appState ? { appState: appState as AppState } : {}),
      captureUpdate: capture,
    });
  };
  return {
    insertLinks: (items, point) => {
      if (!api || destroyed || !items.length) return false;
      const state = api.getAppState();
      const viewport = point
        ? { clientX: point.x, clientY: point.y }
        : {
            clientX: state.offsetLeft + state.width / 2,
            clientY: state.offsetTop + state.height / 2,
          };
      const origin = viewportCoordsToSceneCoords(viewport, state);
      const fontSize = state.currentItemFontSize;
      const created = convertToExcalidrawElements(
        items.map((item, index) => ({
          type: 'text' as const,
          text: item.label,
          x: origin.x,
          y: origin.y + index * fontSize * 1.75,
          link: item.link,
          fontSize,
          fontFamily: state.currentItemFontFamily,
          strokeColor: state.currentItemStrokeColor,
          opacity: state.currentItemOpacity,
        })),
      );
      if (!point && created.length) {
        // Center the block of labels in the visible area.
        const width = Math.max(...created.map((element) => element.width));
        const last = created.at(-1)!;
        const height = last.y + last.height - created[0]!.y;
        for (const element of created)
          Object.assign(element, { x: element.x - width / 2, y: element.y - height / 2 });
      }
      update(
        [...api.getSceneElementsIncludingDeleted(), ...created],
        CaptureUpdateAction.IMMEDIATELY,
        {
          selectedElementIds: Object.fromEntries(created.map((element) => [element.id, true])),
          selectedGroupIds: {},
        } as Partial<AppState>,
      );
      return true;
    },
    linkSelection: (link) => {
      if (!api || destroyed) return false;
      const state = api.getAppState();
      const elements = api.getSceneElementsIncludingDeleted();
      const byId = new Map(elements.map((element) => [element.id, element]));
      const targets = new Set<string>();
      for (const [id, selected] of Object.entries(state.selectedElementIds)) {
        const element = selected ? byId.get(id) : undefined;
        if (!element || element.isDeleted) continue;
        const container =
          element.type === 'text' && element.containerId
            ? byId.get(element.containerId)
            : undefined;
        targets.add(container && !container.isDeleted ? container.id : element.id);
      }
      if (!targets.size) return false;
      update(
        elements.map((element) =>
          targets.has(element.id) ? newElementWith(element, { link }) : element,
        ),
        CaptureUpdateAction.IMMEDIATELY,
      );
      return true;
    },
    rewriteLinks: (rewrite) => {
      if (!api || destroyed) return false;
      let changed = false;
      const elements = api.getSceneElementsIncludingDeleted().map((element) => {
        const next = element.link ? rewrite(element.link) : undefined;
        if (next === undefined || next === element.link) return element;
        changed = true;
        return newElementWith(element, { link: next });
      });
      if (changed) update(elements, CaptureUpdateAction.NEVER);
      return changed;
    },
    contains: (point) => {
      const target = document.elementFromPoint(point.x, point.y);
      return !!target && !!host?.contains(target) && !!target.closest('canvas, .excalidraw');
    },
    flush: () => flush(),
    setTheme: (value) => {
      if (destroyed || theme === value) return;
      theme = value;
      render();
    },
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
