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
  save(path: string, revision: string, scene: Scene): Promise<{ revision: string }>;
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
  private draftTimer?: ReturnType<typeof setTimeout>;
  private maxTimer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<boolean>;
  private disposed = false;
  private savingPaused = false;
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
  pauseSaving() {
    if (this.flight || this.state.dirty) throw new Error('Save the canvas before moving it.');
    this.savingPaused = true;
    clearTimeout(this.timer);
    clearTimeout(this.maxTimer);
    this.maxTimer = undefined;
    return () => {
      this.savingPaused = false;
      if (!this.disposed && this.state.status !== 'conflict') this.schedule();
    };
  }
  relocate(path: string) {
    if ((!this.savingPaused && this.state.dirty) || this.flight)
      throw new Error('Save the canvas before moving it.');
    const previous = this.document.path;
    this.document.path = path;
    void this.store.remove(previous).catch(() => this.update({ localError: true }));
  }
  preserveMissing() {
    // A clean file removed externally still needs a recoverable local copy.
    this.savedJSON = '';
    clearTimeout(this.timer);
    clearTimeout(this.maxTimer);
    this.maxTimer = undefined;
    this.update({
      status: 'conflict',
      dirty: true,
      message:
        'The file has been moved, deleted, or can no longer be opened. Your drawing is preserved here.',
    });
    void this.persist();
  }
  private update(change: Partial<SaveState>) {
    if (
      Object.entries(change).every(([key, value]) => this.state[key as keyof SaveState] === value)
    )
      return;
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
    // Coalesce IndexedDB copies rather than cloning every input snapshot. A flush,
    // conflict or page visibility change checkpoints immediately.
    if (!this.draftTimer)
      this.draftTimer = setTimeout(() => {
        void this.persist();
      }, 250);
    if (this.state.status !== 'conflict') this.schedule();
  };
  private async persist() {
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
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
    if (this.savingPaused) return;
    clearTimeout(this.timer);
    if (!this.state.dirty) {
      clearTimeout(this.maxTimer);
      this.maxTimer = undefined;
      return;
    }
    if (this.state.dirty)
      this.timer = setTimeout(() => {
        void this.flush();
      }, 650);
    if (this.state.dirty && !this.maxTimer)
      this.maxTimer = setTimeout(() => {
        void this.flush();
      }, 4000);
  }
  flush = async (): Promise<boolean> => {
    clearTimeout(this.timer);
    clearTimeout(this.maxTimer);
    this.maxTimer = undefined;
    if (this.savingPaused) {
      await this.persist();
      return !this.state.dirty;
    }
    if (this.state.status === 'conflict') {
      await this.persist();
      return false;
    }
    if (this.flight) {
      const ok = await this.flight;
      return ok ? this.flush() : false;
    }
    if (!this.state.dirty) {
      if (this.draftTimer) await this.persist();
      return true;
    }
    const save = async () => {
      const scene = this.scene;
      const json = this.currentJSON;
      this.update({ status: 'saving', message: '' });
      await this.persist();
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
    if (this.savingPaused || this.flight || this.state.status === 'conflict') return;
    const path = this.document.path;
    try {
      const { revision } = await this.transport.revision(path);
      if (
        this.savingPaused ||
        path !== this.document.path ||
        this.flight ||
        revision === this.revision
      )
        return;
      if (this.state.dirty) {
        clearTimeout(this.timer);
        clearTimeout(this.maxTimer);
        this.maxTimer = undefined;
        this.update({
          status: 'conflict',
          message: 'The file has changed externally, and you have unsaved local changes.',
        });
        await this.persist();
        return;
      }
      const next = await this.transport.read(path);
      if (path === this.document.path && !this.state.dirty && !this.flight) return next;
    } catch (e) {
      if (this.savingPaused || path !== this.document.path) return;
      if (e instanceof ApiError && [404, 422].includes(e.status)) this.preserveMissing();
    }
  }
  async discard() {
    clearTimeout(this.timer);
    clearTimeout(this.maxTimer);
    clearTimeout(this.draftTimer);
    await this.store.remove(this.document.path);
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.maxTimer);
    clearTimeout(this.draftTimer);
    this.listeners.clear();
  }
}
