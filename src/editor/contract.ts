import type { Scene } from '../../shared/model';
import type { ColorTheme } from '../workspace/theme';

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

export interface EditorModule {
  contract: 1;
  mountEditor(container: HTMLElement, options: EditorOptions): EditorHandle;
  importScene(file: File): Promise<Scene>;
}
