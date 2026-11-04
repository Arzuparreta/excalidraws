import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { DocumentSession } from '../workspace/session';
import type { EditorHandle } from './ExcalidrawAdapter';

// Each document owns one mounted React island. Cleanup releases its scene, canvases,
// image cache and subscriptions before Solid mounts another document.
export function EditorSurface(props: {
  session: DocumentSession;
  onImport(): void;
  onReady(handle: EditorHandle | undefined): void;
  onPending(pending: boolean): void;
  onError(error: unknown): void;
}) {
  let container!: HTMLDivElement;
  let handle: EditorHandle | undefined;
  let disposed = false;
  const [loading, setLoading] = createSignal(true);
  onMount(async () => {
    try {
      const { mountEditor } = await import('./ExcalidrawAdapter');
      if (disposed) return;
      handle = mountEditor(container, {
        scene: props.session.initialScene,
        onChange: props.session.change,
        onImport: props.onImport,
        onPending: props.onPending,
      });
      props.onReady(handle);
      setLoading(false);
    } catch (error) {
      if (!disposed) {
        setLoading(false);
        props.onError(error);
      }
    }
  });
  onCleanup(() => {
    disposed = true;
    props.onReady(undefined);
    props.onPending(false);
    handle?.destroy();
  });
  return (
    <div class="editor-surface">
      <div class="editor-mount" ref={container} />
      <Show when={loading()}>
        <div class="editor-loading">Loading canvas…</div>
      </Show>
    </div>
  );
}
