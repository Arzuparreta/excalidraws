import { get, set, del } from 'idb-keyval';
import type { Scene } from '../../shared/model';
export interface Draft {
  revision: string;
  scene: Scene;
  updated: number;
}
export interface DraftStore {
  read(path: string): Promise<Draft | undefined>;
  write(path: string, draft: Draft): Promise<void>;
  remove(path: string): Promise<void>;
}
// Ordered writes prevent a completed network save from deleting a newer local draft.
let queue: Promise<unknown> = Promise.resolve();
function ordered<T>(work: () => Promise<T>) {
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
}
const key = (path: string) => `excalidraws:draft:${path}`;
export const drafts: DraftStore = {
  read: (path) => ordered(() => get<Draft>(key(path))),
  write: (path, draft) => ordered(() => set(key(path), draft)),
  remove: (path) => ordered(() => del(key(path))),
};
