import { onCleanup, onMount, Show } from 'solid-js';
import { Check, X } from 'lucide-solid';

export type RenameState = { path: string; name: string; error: string };

/**
 * Edits a name in the slot where it is shown. Leaving the field saves it, except when focus
 * moves to a control that commits the rename itself before running its own action.
 */
export function InlineName(props: {
  value: RenameState;
  label: string;
  busy: boolean;
  onInput(name: string): void;
  onSave(restoreFocus: boolean): Promise<boolean>;
  onCancel(): void;
}) {
  let container!: HTMLSpanElement;
  let input!: HTMLInputElement;
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  let outsidePointer = false;
  const save = async (restoreFocus: boolean) => {
    const saved = await props.onSave(restoreFocus);
    if (!saved && input.isConnected) input.focus();
  };
  onMount(() => {
    const pointer = (event: PointerEvent) => {
      outsidePointer = event.target instanceof Node && !container.contains(event.target);
    };
    document.addEventListener('pointerdown', pointer, true);
    onCleanup(() => document.removeEventListener('pointerdown', pointer, true));
    input.focus({ preventScroll: true });
    input.select();
  });
  onCleanup(() => clearTimeout(blurTimer));
  return (
    <span
      class="inline-name"
      ref={container}
      onFocusOut={(event) => {
        const next = event.relatedTarget;
        const deliberate = outsidePointer;
        outsidePointer = false;
        if (
          next instanceof Element &&
          !container.contains(next) &&
          next.closest('.file-select, .title-button, [data-name-transition], [data-menu-trigger]')
        )
          return;
        if (deliberate && next instanceof Element && next.closest('.file-row')) return;
        // Let a clicked workspace action finish the edit before its own operation.
        blurTimer = setTimeout(() => {
          if (!container.isConnected || container.contains(document.activeElement) || props.busy)
            return;
          if (!deliberate && !next && document.activeElement === document.body) {
            // A refresh or editor remount can briefly take focus. Keep the draft;
            // saving it must be a consequence of a user's action.
            if (document.hasFocus()) input.focus({ preventScroll: true });
            return;
          }
          void save(false);
        }, 0);
      }}
      onKeyDown={(event) => {
        outsidePointer = false;
        event.stopPropagation();
        if (event.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          void save(true);
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          props.onCancel();
        }
      }}
    >
      <input
        ref={input}
        aria-label={props.label}
        aria-invalid={!!props.value.error}
        aria-describedby={props.value.error ? 'rename-error' : undefined}
        title="Enter to save · Escape to cancel"
        maxLength={160}
        size={Math.max(1, props.value.name.length)}
        value={props.value.name}
        readOnly={props.busy}
        enterkeyhint="done"
        autocomplete="off"
        spellcheck={false}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <button
        class="icon-button"
        type="button"
        onClick={() => void save(true)}
        aria-label="Save name"
        title="Save name · Enter"
        disabled={props.busy}
      >
        <Check size={15} />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Cancel rename"
        title="Cancel rename · Escape"
        disabled={props.busy}
        onClick={props.onCancel}
      >
        <X size={15} />
      </button>
      <Show when={props.value.error}>
        <span id="rename-error" class="rename-error" role="alert">
          {props.value.error}
        </span>
      </Show>
    </span>
  );
}
