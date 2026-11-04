import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { CornerLeftUp, Folder, House } from 'lucide-solid';
import { basename, folderLabel, isInside, parentOf, type LibraryEntry } from './tree';

const LIMIT = 150;

/** Searchable destination list. One click or Enter moves; nothing else needs confirming. */
export function MovePicker(props: {
  folders: LibraryEntry[];
  moving: string[];
  title: string;
  onPick(folder: string): void;
}) {
  const [filter, setFilter] = createSignal('');
  const [active, setActive] = createSignal(0);
  // A shared current folder is shown but cannot be chosen again.
  const current = createMemo(() => {
    const parents = new Set(props.moving.map(parentOf));
    return parents.size === 1 ? [...parents][0] : undefined;
  });
  const options = createMemo(() => {
    const query = filter().trim().toLocaleLowerCase();
    const allowed = props.folders.filter(
      (folder) => !folder.archived && !props.moving.some((path) => isInside(folder.path, path)),
    );
    const all = [
      { path: '', label: 'Library', detail: 'Top level' },
      ...allowed
        .sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))
        .map((folder) => ({
          path: folder.path,
          label: basename(folder.path),
          detail: parentOf(folder.path) || 'Library',
        })),
    ].filter((option) => !query || `${option.label} ${option.path}`.toLowerCase().includes(query));
    return { shown: all.slice(0, LIMIT), hidden: Math.max(0, all.length - LIMIT) };
  });
  const enabled = () => options().shown.filter((option) => option.path !== current());
  const activeOption = () => enabled()[Math.min(active(), enabled().length - 1)];
  const id = (path: string) => `move-option-${encodeURIComponent(path || '/').replace(/%/g, '_')}`;
  createEffect(() => {
    const option = activeOption();
    if (option) document.getElementById(id(option.path))?.scrollIntoView({ block: 'nearest' });
  });
  return (
    <div class="move-picker">
      <p class="popover-title">{props.title}</p>
      <Show when={current()}>
        {(folder) => (
          <button
            class="move-out"
            data-name-transition
            onClick={() => props.onPick(parentOf(folder()))}
          >
            <CornerLeftUp size={15} />
            <span>
              Move out to <strong>{folderLabel(parentOf(folder()))}</strong>
            </span>
          </button>
        )}
      </Show>
      <input
        class="popover-filter"
        data-autofocus
        type="text"
        inputmode="search"
        role="combobox"
        aria-label="Filter folders"
        aria-expanded="true"
        aria-controls="move-options"
        aria-activedescendant={activeOption() ? id(activeOption()!.path) : undefined}
        aria-autocomplete="list"
        placeholder="Filter folders…"
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
      <ul id="move-options" class="move-options" role="listbox" aria-label="Destination folders">
        <For each={options().shown}>
          {(option) => {
            const disabled = () => option.path === current();
            return (
              <li
                id={id(option.path)}
                role="option"
                class="move-option"
                classList={{ active: activeOption()?.path === option.path, current: disabled() }}
                aria-selected={activeOption()?.path === option.path}
                aria-disabled={disabled()}
                data-name-transition
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => !disabled() && props.onPick(option.path)}
              >
                <Show when={option.path} fallback={<House size={15} />}>
                  <Folder size={15} />
                </Show>
                <span class="move-option-text">
                  <span>{option.label}</span>
                  <small>{disabled() ? 'Current folder' : option.detail}</small>
                </span>
              </li>
            );
          }}
        </For>
        <Show when={!options().shown.length}>
          <li class="move-empty" role="presentation">
            No matching folders.
          </li>
        </Show>
      </ul>
      <Show when={options().hidden}>
        <p class="popover-help">{options().hidden} more. Refine the filter to find them.</p>
      </Show>
    </div>
  );
}
