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
export interface Entry {
  path: string;
  kind: 'file' | 'folder';
  modified: string;
}
export interface Document {
  path: string;
  revision: string;
  scene: Scene;
}
export interface TrashEntry {
  id: string;
  path: string;
  kind: Entry['kind'];
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
