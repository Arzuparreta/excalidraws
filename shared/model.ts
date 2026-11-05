import { z } from 'zod';

export const sceneSchema = z
  .object({
    type: z.literal('excalidraw'),
    version: z.number().int().positive(),
    source: z.string().optional(),
    elements: z.array(z.record(z.string(), z.unknown())),
    appState: z.record(z.string(), z.unknown()).default({}),
    files: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

export type Scene = z.infer<typeof sceneSchema>;
/** A canvas in the library. See shared/canvas.ts for how canvases are stored. */
export interface Entry {
  /** Vault path of the canvas file, such as `Ideas/Idea A.excalidraw`. */
  path: string;
  modified: string;
  /** Number of canvases directly inside this one. */
  children: number;
  /** The folder of its contents exists, but its file does not yet: it opens empty. */
  unsaved?: boolean;
  /** Explicitly marked as a favorite. Not inherited. */
  favorite?: boolean;
  /** Archived itself or inside an archived folder. */
  archived?: boolean;
  /** The nearest explicitly archived path: the entry itself or an ancestor folder. */
  archiveRoot?: string;
  /** Index among siblings: custom order first, then the remaining items by name. */
  order?: number;
}
export type LibraryProperty = 'favorite' | 'archived';
export interface Document {
  path: string;
  revision: string;
  scene: Scene;
}
export interface TrashEntry {
  id: string;
  /** Original path of the canvas. */
  path: string;
  /** Number of canvases that were inside it, at any depth. */
  inside: number;
  deleted: string;
}
export interface HistoryEntry {
  revision: string;
  modified: string;
}
export const emptyScene = (): Scene => ({
  type: 'excalidraw',
  version: 2,
  source: 'excalidraws',
  elements: [],
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
});
