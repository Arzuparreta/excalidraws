import type { Document, Scene } from '../../shared/model';
import { ApiError } from './api';
import type { Draft, DraftStore } from './drafts';

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'offline' | 'conflict';
export interface SaveState {
  status: SaveStatus;
  dirty: boolean;
  message: string;
  localError: boolean;
}
interface Transport {
  save(path: string, revision: string, scene: Scene): Promise<Document>;
  revision(path: string): Promise<{ revision: string }>;
  read(path: string): Promise<Document>;
}

/** Owns one document for its entire lifetime. No React or Excalidraw dependency. */
export class DocumentSession {
  readonly initialScene: Scene;
  private scene: Scene;
  private revision: string;
  private savedJSON: string;
  private currentJSON: string;
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<boolean>;
  private disposed = false;
  private listeners = new Set<() => void>();
  private state: SaveState = { status: 'saved', dirty: false, message: '', localError: false };
  constructor(
    readonly document: Document,
    private transport: Transport,
    private store: DraftStore,
    draft?: Draft,
  ) {
    this.revision = document.revision;
    this.savedJSON = JSON.stringify(document.scene);
    this.scene = draft?.scene ?? document.scene;
    this.initialScene = this.scene;
    this.currentJSON = JSON.stringify(this.scene);
    if (draft && this.currentJSON !== this.savedJSON) {
      const conflict = draft.revision !== document.revision;
      this.state = {
        ...this.state,
        dirty: true,
        status: conflict ? 'conflict' : 'pending',
        message: conflict
          ? 'The recovered draft and the file have different versions.'
          : 'Draft recovered from this browser.',
      };
      if (!conflict) this.schedule();
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  getScene = () => this.scene;
  preserveMissing() {
    // A clean file removed externally still needs a recoverable local copy.
    this.savedJSON = '';
    clearTimeout(this.timer);
    this.update({
      status: 'conflict',
      dirty: true,
      message:
        'The file has been moved, deleted, or can no longer be opened. Your drawing is preserved here.',
    });
    void this.persist();
  }
  private update(change: Partial<SaveState>) {
    this.state = { ...this.state, ...change };
    if (!this.disposed) this.listeners.forEach((fn) => fn());
  }
  change = (scene: Scene) => {
    if (this.disposed) return;
    const json = JSON.stringify(scene);
    if (json === this.currentJSON) return;
    this.scene = scene;
    this.currentJSON = json;
    const dirty = json !== this.savedJSON;
    this.update({
      dirty,
      ...(this.state.status === 'conflict' ? {} : { status: dirty ? 'pending' : 'saved' }),
    });
    void this.persist();
    if (this.state.status !== 'conflict') this.schedule();
  };
  private async persist() {
    try {
      if (this.currentJSON === this.savedJSON) await this.store.remove(this.document.path);
      else
        await this.store.write(this.document.path, {
          revision: this.revision,
          scene: this.scene,
          updated: Date.now(),
        });
      this.update({ localError: false });
    } catch {
      this.update({ localError: true });
    }
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.state.dirty)
      this.timer = setTimeout(() => {
        void this.flush();
      }, 650);
  }
  flush = async (): Promise<boolean> => {
    clearTimeout(this.timer);
    if (this.state.status === 'conflict') return false;
    if (this.flight) {
      const ok = await this.flight;
      return ok ? this.flush() : false;
    }
    if (!this.state.dirty) return true;
    const save = async () => {
      const scene = this.scene;
      const json = this.currentJSON;
      this.update({ status: 'saving', message: '' });
      try {
        const result = await this.transport.save(this.document.path, this.revision, scene);
        this.revision = result.revision;
        this.savedJSON = json;
        const dirty = this.currentJSON !== json;
        this.update({ status: dirty ? 'pending' : 'saved', dirty, message: '' });
        await this.persist();
        return true;
      } catch (error) {
        const conflict =
          error instanceof ApiError && ['conflict', 'not_found'].includes(error.code);
        this.update({
          status: conflict ? 'conflict' : 'offline',
          message: conflict
            ? 'The file has changed or moved. Your drawing is preserved here.'
            : 'Could not save to the server. Retry when the connection is restored.',
        });
        await this.persist();
        return false;
      }
    };
    this.flight = save();
    const ok = await this.flight;
    this.flight = undefined;
    // A switch must wait for edits made while the first request was in flight too.
    if (ok && this.state.dirty) return this.flush();
    return ok;
  };
  async checkExternal(): Promise<Document | undefined> {
    if (this.flight || this.state.status === 'conflict') return;
    try {
      const { revision } = await this.transport.revision(this.document.path);
      if (this.flight || revision === this.revision) return;
      if (this.state.dirty) {
        clearTimeout(this.timer);
        this.update({
          status: 'conflict',
          message: 'The file has changed externally, and you have unsaved local changes.',
        });
        return;
      }
      const next = await this.transport.read(this.document.path);
      if (!this.state.dirty && !this.flight) return next;
    } catch (e) {
      if (e instanceof ApiError && [404, 422].includes(e.status)) this.preserveMissing();
    }
  }
  async discard() {
    clearTimeout(this.timer);
    await this.store.remove(this.document.path);
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
