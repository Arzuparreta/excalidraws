import { onCleanup, onMount, type JSX } from 'solid-js';

export type DismissReason = 'escape' | 'outside' | 'anchor' | 'tab';
const MARGIN = 8;
const GAP = 4;
const menuItems = (root: HTMLElement) =>
  [
    ...root.querySelectorAll<HTMLElement>(
      '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
    ),
  ].filter((item) => !(item as HTMLButtonElement).disabled);
const focusables = (root: HTMLElement) =>
  [
    ...root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
    ),
  ].filter((item) => item.getClientRects().length);

/**
 * One anchored surface for menus, the folder picker and history. Placement is recomputed
 * from the live anchor, the measured surface and the visual viewport when layout changes, so a
 * scrolled list, keyboard resize or rotation never leaves it detached. It is dismissed when
 * the anchor leaves the document, becomes hidden or scrolls out of its clipping list.
 */
export function Popover(props: {
  anchor: HTMLElement;
  /** Pointer position for context menus, kept relative to the anchor while it moves. */
  point?: { x: number; y: number };
  label: string;
  role: 'menu' | 'dialog';
  id?: string;
  class?: string;
  align?: 'start' | 'end';
  onDismiss(reason: DismissReason): void;
  children: JSX.Element;
}) {
  let surface!: HTMLDivElement;
  let frame = 0;
  let dismissed = false;
  let last = '';
  const initial = props.anchor.getBoundingClientRect();
  const offset = props.point
    ? { x: props.point.x - initial.left, y: props.point.y - initial.top }
    : undefined;
  const dismiss = (reason: DismissReason) => {
    if (dismissed) return;
    dismissed = true;
    props.onDismiss(reason);
  };
  const update = () => {
    if (dismissed || !surface) return;
    const anchor = props.anchor;
    const rect = anchor.getBoundingClientRect();
    if (
      !anchor.isConnected ||
      !anchor.checkVisibility({ visibilityProperty: true }) ||
      anchor.closest('[inert]') ||
      (rect.width === 0 && rect.height === 0)
    )
      return dismiss('anchor');
    const clip = anchor.closest<HTMLElement>('[data-popover-clip]')?.getBoundingClientRect();
    if (clip) {
      const middle = rect.top + rect.height / 2;
      if (middle < clip.top || middle > clip.bottom) return dismiss('anchor');
    }
    const viewport = window.visualViewport;
    const left0 = viewport?.offsetLeft ?? 0;
    const top0 = viewport?.offsetTop ?? 0;
    const width0 = viewport?.width ?? innerWidth;
    const height0 = viewport?.height ?? innerHeight;
    const target = offset
      ? {
          left: rect.left + offset.x,
          right: rect.left + offset.x,
          top: rect.top + offset.y,
          bottom: rect.top + offset.y,
        }
      : rect;
    const width = Math.min(surface.offsetWidth, width0 - MARGIN * 2);
    const natural = surface.scrollHeight;
    const below = top0 + height0 - MARGIN - (target.bottom + GAP);
    const above = target.top - GAP - (top0 + MARGIN);
    const placeBelow = natural <= below || below >= above;
    const maxHeight = Math.max(80, placeBelow ? below : above);
    const height = Math.min(natural, maxHeight);
    const top = placeBelow ? target.bottom + GAP : target.top - GAP - height;
    const preferred = props.align === 'start' || offset ? target.left : target.right - width;
    const left = Math.min(Math.max(preferred, left0 + MARGIN), left0 + width0 - MARGIN - width);
    const next = `${Math.round(left)},${Math.round(top)},${Math.round(maxHeight)}`;
    if (next === last) return;
    last = next;
    surface.style.left = `${Math.round(left)}px`;
    surface.style.top = `${Math.round(top)}px`;
    surface.style.maxHeight = `${Math.round(maxHeight)}px`;
    surface.style.visibility = 'visible';
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  };
  const pointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    // The anchor toggles the surface itself.
    if (surface.contains(target) || props.anchor.contains(target)) return;
    dismiss('outside');
  };
  onMount(() => {
    update();
    const resize = new ResizeObserver(schedule);
    resize.observe(surface);
    resize.observe(props.anchor);
    const content = new MutationObserver(schedule);
    content.observe(surface, { subtree: true, childList: true, characterData: true });
    const position = new MutationObserver(schedule);
    position.observe(props.anchor.closest('[data-entry-path]') ?? props.anchor, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
    onCleanup(() => {
      resize.disconnect();
      content.disconnect();
      position.disconnect();
    });
    document.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    const first =
      props.role === 'menu'
        ? (surface.querySelector<HTMLElement>('[aria-checked="true"]') ?? menuItems(surface)[0])
        : (surface.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(surface)[0]);
    const avoidKeyboard =
      window.matchMedia('(pointer: coarse)').matches && first instanceof HTMLInputElement;
    (avoidKeyboard ? surface : (first ?? surface)).focus({ preventScroll: true });
  });
  onCleanup(() => {
    dismissed = true;
    cancelAnimationFrame(frame);
    document.removeEventListener('pointerdown', pointerDown, true);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
  });
  return (
    <div
      ref={surface}
      id={props.id}
      class={`popover ${props.class ?? ''}`}
      role={props.role}
      aria-label={props.label}
      tabIndex={-1}
      style={{ visibility: 'hidden' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          dismiss('escape');
          return;
        }
        if (event.key === 'Tab') {
          if (props.role === 'menu') {
            event.preventDefault();
            dismiss('tab');
            return;
          }
          const items = focusables(surface);
          const first = items[0];
          const last = items.at(-1);
          if (event.shiftKey && (document.activeElement === first || !items.length)) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
          return;
        }
        if (props.role !== 'menu') return;
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const items = menuItems(surface);
        if (!items.length) return;
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}
    >
      {props.children}
    </div>
  );
}
