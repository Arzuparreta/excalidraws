import { loadEditor } from './loader';
import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { DocumentSession } from '../workspace/session';
import type { ColorTheme } from '../workspace/theme';
import type { EditorHandle, EditorState } from './contract';

// Each document owns one mounted React island. Cleanup releases its scene, canvases,
// image cache and subscriptions before Solid mounts another document.
export function EditorSurface(props: {
  session: DocumentSession;
  theme: ColorTheme;
  onImport(): void;
  onReady(handle: EditorHandle | undefined): void;
  onPending(pending: boolean): void;
  onLinkOpen(link: string): boolean;
  onState(state: EditorState | undefined): void;
  onError(error: unknown): void;
}) {
  let container!: HTMLDivElement;
  let handle: EditorHandle | undefined;
  let disposed = false;
  const [loading, setLoading] = createSignal(true);
  const [message, setMessage] = createSignal('Preparing Excalidraw…');
  const [failed, setFailed] = createSignal(false);
  createEffect(() => {
    const theme = props.theme;
    handle?.setTheme(theme);
  });
  const mount = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const { mountEditor } = await loadEditor(setMessage);
      if (disposed) return;
      handle = mountEditor(container, {
        scene: props.session.initialScene,
        theme: props.theme,
        onChange: props.session.change,
        onImport: props.onImport,
        onPending: props.onPending,
        onLinkOpen: (link) => props.onLinkOpen(link),
        onState: (state) => props.onState(state),
      });
      props.onReady(handle);
      setLoading(false);
    } catch (error) {
      if (!disposed) {
        setLoading(false);
        setMessage(error instanceof Error ? error.message : 'Excalidraw could not be loaded.');
        setFailed(true);
      }
    }
  };
  onMount(mount);
  onCleanup(() => {
    disposed = true;
    props.onReady(undefined);
    props.onPending(false);
    props.onState(undefined);
    handle?.destroy();
  });
  return (
    <div class="editor-surface">
      <div class="editor-mount" ref={container} />
      <Show when={loading() || failed()}>
        <div class="editor-loading" role={failed() ? 'alert' : 'status'} aria-live="polite">
          <span>{message()}</span>
          <Show when={failed()}>
            <button type="button" class="secondary" onClick={mount}>
              Retry editor download
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
