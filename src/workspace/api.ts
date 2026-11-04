import type { Document, Entry, HistoryEntry, Scene, TrashEntry } from '../../shared/model';

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
async function request<T>(route: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api${route}`, {
    method: body === undefined ? 'GET' : method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
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
  read: (path: string) => request<Document>(`/document${query(path)}`),
  revision: (path: string) => request<{ revision: string }>(`/revision${query(path)}`),
  save: (path: string, revision: string, scene: Scene) =>
    request<Document>('/document', { path, revision, scene }, 'PUT'),
  create: (path: string, kind: Entry['kind'], scene?: Scene) =>
    request<Document>('/entries', { path, kind, scene }),
  move: (from: string, to: string) => request('/move', { from, to }),
  trash: (path: string) => request('/trash', { path }),
  listTrash: () => request<TrashEntry[]>('/trash'),
  restore: (id: string, path?: string) => request<{ path: string }>('/restore', { id, path }),
  history: (path: string) => request<HistoryEntry[]>(`/history${query(path)}`),
  historical: (path: string, revision: string) =>
    request<Scene>(`/history/document${query(path)}&revision=${revision}`),
};
