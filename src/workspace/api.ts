import type {
  Document,
  Entry,
  HistoryEntry,
  LibraryProperty,
  Scene,
  TrashEntry,
} from '../../shared/model';

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
async function request<T>(
  route: string,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${route}`, {
    method: body === undefined ? 'GET' : method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      data.error ?? 'The operation could not be completed.',
      data.code ?? 'unknown',
      response.status,
    );
  return data;
}
const query = (path: string) => `?path=${encodeURIComponent(path)}`;
export const api = {
  entries: () => request<Entry[]>('/entries'),
  read: (path: string, signal?: AbortSignal) =>
    request<Document>(`/document${query(path)}`, undefined, 'GET', signal),
  revision: (path: string) => request<{ revision: string }>(`/revision${query(path)}`),
  save: (path: string, revision: string, scene: Scene) =>
    request<{ revision: string }>('/document', { path, revision, scene }, 'PUT'),
  create: (path: string, scene?: Scene) => request<Document>('/entries', { path, scene }),
  /** Moves a canvas with its contents. Links to it are rewritten except in `exclude`. */
  move: (from: string, to: string, exclude?: string) =>
    request<{ rewritten: string[] }>('/move', { from, to, exclude }),
  trash: (path: string) => request<TrashEntry>('/trash', { path }),
  listTrash: () => request<TrashEntry[]>('/trash'),
  // Without path: the original location, or a readable "(restored)" name if it is occupied.
  restore: (id: string, path?: string) => request<{ path: string }>('/restore', { id, path }),
  setLibrary: (paths: string[], property: LibraryProperty, value: boolean) =>
    request<{ ok: true }>('/library', { property, paths, value }),
  /** Custom order of the canvases in a content folder ('' is the top level). */
  order: (folder: string, paths: string[]) => request<{ ok: true }>('/order', { folder, paths }),
  history: (path: string) => request<HistoryEntry[]>(`/history${query(path)}`),
  historical: (path: string, revision: string) =>
    request<Scene>(`/history/document${query(path)}&revision=${revision}`),
};
