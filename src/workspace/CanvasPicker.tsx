import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { FileText, House } from 'lucide-solid';
import { displayName, locationLabel, type LibraryEntry } from './tree';

const LIMIT = 150;
let instances = 0;

/**
 * Searchable list of canvases. One click or Enter picks; nothing else needs confirming.
 * `top` adds the top level of the library as the option ''. `current` is shown but
 * cannot be picked. `actions` are shortcuts shown above the filter.
 */
export function CanvasPicker(props: {
  title: string;
  help?: string;
  canvases: LibraryEntry[];
  top?: string;
  current?: string;
  currentLabel?: string;
  actions?: JSX.Element;
  listLabel: string;
  onPick(path: string): void;
}) {
  const prefix = `canvas-option-${++instances}`;
  const [filter, setFilter] = createSignal('');
  const [active, setActive] = createSignal(0);
  const options = createMemo(() => {
    const query = filter().trim().toLocaleLowerCase();
    const all = [
      ...(props.top !== undefined ? [{ path: '', label: 'Library', detail: props.top }] : []),
      ...[...props.canvases]
        .sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))
        .map((canvas) => ({
          path: canvas.path,
          label: displayName(canvas),
          detail: locationLabel(canvas.path) || 'Library',
        })),
    ].filter(
      (option) => !query || `${option.label} ${option.detail}`.toLocaleLowerCase().includes(query),
    );
    return { shown: all.slice(0, LIMIT), hidden: Math.max(0, all.length - LIMIT) };
  });
  const enabled = () => options().shown.filter((option) => option.path !== props.current);
  const activeOption = () => enabled()[Math.min(active(), enabled().length - 1)];
  const id = (path: string) => `${prefix}-${encodeURIComponent(path || '/').replace(/%/g, '_')}`;
  createEffect(() => {
    const option = activeOption();
    if (option) document.getElementById(id(option.path))?.scrollIntoView({ block: 'nearest' });
  });
  return (
    <div class="canvas-picker">
      <p class="popover-title">{props.title}</p>
      <Show when={props.help}>
        <p class="popover-help">{props.help}</p>
      </Show>
      {props.actions}
      <input
        class="popover-filter"
        data-autofocus
        type="text"
        inputmode="search"
        role="combobox"
        aria-label="Filter canvases"
        aria-expanded="true"
        aria-controls={`${prefix}-list`}
        aria-activedescendant={activeOption() ? id(activeOption()!.path) : undefined}
        aria-autocomplete="list"
        placeholder="Filter canvases…"
        autocomplete="off"
        value={filter()}
        onInput={(event) => {
          setFilter(event.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          const count = enabled().length;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (count)
              setActive((value) => (value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
          } else if (event.key === 'Home' && event.ctrlKey) {
            event.preventDefault();
            setActive(0);
          } else if (event.key === 'End' && event.ctrlKey) {
            event.preventDefault();
            setActive(Math.max(0, count - 1));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const option = activeOption();
            if (option) props.onPick(option.path);
          }
        }}
      />
      <ul id={`${prefix}-list`} class="picker-options" role="listbox" aria-label={props.listLabel}>
        <For each={options().shown}>
          {(option) => {
            const disabled = () => option.path === props.current;
            return (
              <li
                id={id(option.path)}
                role="option"
                class="picker-option"
                classList={{ active: activeOption()?.path === option.path, current: disabled() }}
                aria-selected={activeOption()?.path === option.path}
                aria-disabled={disabled()}
                data-name-transition
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => !disabled() && props.onPick(option.path)}
              >
                <Show when={option.path} fallback={<House size={15} />}>
                  <FileText size={15} />
                </Show>
                <span class="picker-option-text">
                  <span>{option.label}</span>
                  <small>{disabled() ? (props.currentLabel ?? 'Current') : option.detail}</small>
                </span>
              </li>
            );
          }}
        </For>
        <Show when={!options().shown.length}>
          <li class="picker-empty" role="presentation">
            {filter().trim() ? 'No matching canvases.' : 'There are no other canvases yet.'}
          </li>
        </Show>
      </ul>
      <Show when={options().hidden}>
        <p class="popover-help">{options().hidden} more. Refine the filter to find them.</p>
      </Show>
    </div>
  );
}
