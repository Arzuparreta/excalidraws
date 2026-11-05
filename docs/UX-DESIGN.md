# Canvas workspace design

## Objective

Make a large collection of canvases as easy to organize as a small one, without
interrupting drawing. The explorer owns organization; the editor owns drawing.
Desktop, keyboard, and touch users must be able to complete the same tasks.

## Research

Three independent Claude Opus 5.5 agents, with high effort, inspected the merged
baseline `2fae3dd` before implementation. Their perspectives were desktop canvas
operations, mobile interaction and accessibility, and product/visual direction.
The study covered the actual workspace, controller, session, vault, API, existing
browser evidence, and tests. This was an expert code and interaction audit, not
a user study or physical-device usability test.

All three identified the same structural issues:

- Opening a canvas removes its row from the hierarchy and duplicates its identity
  in an active card. This shifts neighboring rows and makes folders appear empty.
- Folder expansion also changes the creation destination, making creation depend
  on hidden state. Moving requires a distant form and several unnecessary steps.
- A global operation flag blocks drawing even when managing unrelated items.
- Five centered dialogs interrupt tasks that mostly belong to one item or list.
- History is keyed by path but does not follow a move. Trash restore cannot
  recover when the original parent is missing or the name has been reused.
- Desktop pencils are permanently visible, touch controls are too small, and
  phone landscape leaves almost no space for the list.
- The chrome uses a different accent from the embedded editor. Repeated dates,
  status changes, and duplicated controls compete with canvas content.

## Decisions and disagreements resolved

### Stable hierarchy

Keep the open canvas in its folder and mark it as current. Remove the active card
and the creation-destination footer. Opening, searching, expanding, favoriting,
archiving, or sorting must never switch the document as a side effect. Creation
uses an explicit destination: root from the global action, or a folder's own
action. Folder expansion has exactly one job.

Keep Library as the default tree. Favorites is a compact filtered view rather
than a second permanent copy of every favorite row. Archive and Trash replace
the list in the same explorer. Search includes archived matches with a badge;
it never searches discarded content in Trash.

### Archive and order are workspace metadata

Two council members recommended private server metadata; the mobile report
proposed a physical Archive folder. Choose `.workspace/library.json`: adopting
an existing user folder as a system feature or moving files during archive would
change user-owned organization and introduce collisions. Metadata is versioned,
validated, written atomically under the vault's serial queue, and changed through
operations rather than whole-document replacement. A missing file means defaults.
Favorite, archive, and order must not change scene bytes, revisions, or mtimes.

Archived folders hide their subtree. The current archived canvas remains editable
and offers an explicit route to unarchive its owning archived folder. Move, trash,
and restore maintain metadata. History follows file and folder moves.

Recent modification remains the initial sort; custom order is explicit. The
visual report preferred custom order as the default, but the desktop report's
large-library concern is stronger. Dragging must never silently change the sort.

### Local, reversible management

Use one anchored surface for menus, destination picking, and history. Recompute
placement from the live anchor, measured size, and visual viewport; flip at the
edges and dismiss when the anchor disappears. A scrolled list must not leave an
orphan menu behind. On a narrow drawer the surface can use its available width,
but it must retain its relationship to the originating item.

Trash and archive run immediately and offer Undo. Trash remains recoverable from
its own explorer view after the notice is dismissed. Do not add permanent delete
or Empty trash in this redesign. Discarding an unsaved local version is different:
keep a second deliberate step inside the conflict notice.

Move supports a searchable folder picker, root destination, a direct move-out
action, and desktop drag. Custom order supports drag insertion and explicit
move-up/down controls. Every drag has a non-drag equivalent. Group selection is
available through explicit selection controls as well as desktop modifiers.

Duplicate works for any canvas. Duplicating the current conflicted canvas copies
the local drawing without overwriting the remote file. New names are readable,
collision-safe, and editable in place. Restore preserves both versions when a
path has been reused and recreates missing parent folders safely.

### Mouse, keyboard, and touch

The topbar title is one rename button containing its decorative pencil. A tree
row opens a canvas and contains no rename button: Rename is the first item of the
row's actions menu and F2 on a focused row. Desktop secondary actions appear on
hover and keyboard focus in a fixed column at the row's end. Touch uses a visible
actions button.

The virtual tree has one navigation entry point, arrow navigation, Home/End,
Enter, F2, context-menu keys, and scoped organization shortcuts. Virtualization
must preserve keyboard access to offscreen rows. Workspace shortcuts must not
take Excalidraw tool or hyperlink shortcuts away from the editor.

Use an overlay explorer below 1024 px or below 500 px in height. Keep the desktop
collapse preference separate from the drawer state. Rotation and clean external
updates must not close an ongoing management interaction. Focus returns to the
originating control, a surviving neighboring row, or the explorer entry point.
Use 44 px targets and at least 16 px input text on touch devices. Keep the main
editor inert while the mobile drawer is open, not during unrelated operations.

The mobile report opposed per-canvas browser history because of edge swipes;
the other two favored deep links and conventional Back/Forward. Choose ordinary
canvas navigation and explicit overlay dismissal, without inventing canvas-edge
gestures. Renaming or moving updates the current URL rather than adding a visit.

### Visual system

Use neutral paper surfaces, dark ink, and the editor's violet accent. Establish a
clear density hierarchy: compact desktop rows, comfortable touch rows, a quiet
topbar, stable-width save status, restrained separators, and strong focus rings.
Reduce repeated dates and chrome. Keep the drawing area spacious and provide
useful empty states with direct creation and import actions. Respect reduced
motion; do not animate the editor's size.

## Rejected directions

- Thumbnail galleries require loading and rendering scenes merely to navigate.
- Multiple live editor tabs retain large scenes and fragment drawing history.
- Swipe-to-delete and touch drag as the only move path conflict with scrolling,
  drawing, system gestures, keyboard access, and discoverability.
- Browser-only archive/order would diverge between devices.
- Global explorer Undo or letter shortcuts would steal drawing commands.
- Optimistic filesystem changes without reliable rollback would misrepresent
  persistence. A clear pending state is preferable to invented success.

## Refinement of the implemented design

Two additional independent Opus 5.5 high-effort council reviews examined the
implemented code and desktop/mobile captures. The resulting refinements include:

- Treat moving between folders and inserting at a position as one operation with
  one Undo, including restoration of the previous sibling positions. Clear an
  implicit name order rather than accidentally pinning it as a custom order.
- Flush coalesced text/keyboard edits before disposing a trashed canvas or
  accepting a clean external reload. Filter removed siblings when undoing order.
- Preserve an active rename or move picker when crossing the docked/drawer
  breakpoint. Dismiss surfaces whose anchor becomes hidden or inert.
- Restore focus without scrolling back when a menu's anchor scrolls out of view.
  Give resolved document warnings and unarchive actions a surviving focus target.
- Keep a rename draft through incidental focus loss during a refresh; distinguish
  deliberate pointer/keyboard departure from the document temporarily taking focus.
- Rank exact names, prefixes, name substrings, then folder-path matches. Exclude
  the file-format extension and respect IME composition before opening results.
- Advertise the global search shortcut accurately, expose folder import through
  the ordinary menu, and give breadcrumbs action-specific accessible names.
- Combine search and creation controls in phone landscape, retaining four or more
  touch rows. Observe popover layout changes instead of measuring on every frame.
- Reject folder moves that would make descendant paths invalid. Recreated restore
  parents start without metadata left by externally removed folders.

The persistent Undo notice is dismissed on deliberate document navigation; Trash
remains available for later recovery. No expiry timer makes recovery depend on
reading or reacting within a time limit.

## Sidebar control hierarchy

A review of the rendered sidebar found five unrelated button styles above the list,
the current view named twice (its tab and the list title), icon-only views with an
unrecognizable Library icon, an import arrow that read as upload or export, a sort
icon that read as filters, and visit-history arrows in the sidebar that acted on the
editor. Row rename pencils followed each name's length, and selection mode moved every
name to the right. The controls now follow one order, from most to least frequent:

- Creation is one split control: New canvas, plus a menu with Import. A row's `+`
  opens New canvas inside and Import inside for that canvas.
- Library and Favorites are a labeled two-option switch. Archive and Trash are labeled
  footer buttons beside an icon-only Settings button. Opening Archive or Trash shows
  the view name with a Back to Library button in the list header.
- The list header states what the list contains (`7 canvases`, `3 results`), shows
  the current sort as text, and offers selection. It is the only header above the list.
- Selection replaces the list header with the count, the actions once something is
  selected, and Done. Checkboxes take the place of row icons, so names do not move.
- Back and Forward for opened canvases sit in the topbar before the breadcrumb.
  Viewports under 360 px hide them and rely on the browser's own navigation.
- Touch actions buttons are dimmed except on the current or selected row, keeping a
  contrast of at least 3:1.

## Canvases inside canvases

Organizing canvases in folders kept producing a separate canvas whose only job was to
list a folder's canvases, and folders that did not match what their index canvas listed.
Folders are now gone from the model: every item is a canvas, and any canvas can contain
canvases. Containing others is a state of a canvas, not a second kind of item.

- Words: only "canvas" and "inside". Actions read New canvas inside, Import inside,
  and Move to… with canvases as destinations. No separate name such as board or hub,
  which would reintroduce a second kind of item.
- Rows: one icon for every canvas. A chevron and a muted count of the canvases
  directly inside appear only when there are any; the count gives way to the row
  actions on hover. Clicking a row always opens it; the chevron only expands or
  collapses. Dropping on the middle of any row moves into that canvas.
- Links: the topbar Link to canvas dialog links the selection to a canvas, or adds a
  linked label. Its first option creates a canvas inside the open one, named after the
  selected text, without leaving the drawing. Rows dragged onto the drawing become
  linked labels. Following a link opens the canvas in the workspace; a link to a canvas
  that no longer exists names it in an error instead of opening a blank page.
- Consistency: when the drawing does not link to some canvases inside it, a topbar
  count (`2 not linked`) lists them with Add link, Open, and Add all as a list. This is
  the check that a parent canvas and its contents describe the same things.
- Context: the topbar names up to two containing canvases, each one opening it, with
  an ellipsis that shows the full location in the explorer.
- Storage stays readable outside the workspace: `Ideas.excalidraw` plus the folder
  `Ideas/` for its contents, which exists only while it has contents. Rejected
  alternatives: an `index.excalidraw` inside each folder (turning a canvas into a
  container would move its file, and every container would be called index) and
  nesting recorded only in metadata (the files would lose their structure).
- Moving or renaming a canvas rewrites relative links to it in other canvases. The open
  canvas is excluded on the service and updated in the editor without an undo step,
  so neither a dirty drawing nor its history is replaced.

## Acceptance

- Opening a document keeps its row in place and mounts only one editor.
- Rename, move, archive, favorite, and reorder preserve the active editor instance.
- No centered application dialog remains; destructive local discard is confirmed
  beside its warning. Menus fit and stay attached through scroll and resize.
- Move into/out of canvases, custom order, archive/unarchive, selection, duplicate,
  trash/Undo, and restore work without drag and on touch.
- Metadata survives restart, updates another client, and leaves scenes untouched.
- History survives canvas and ancestor-canvas moves. Restore handles missing parents
  and name reuse without replacing existing documents.
- Verify 320/390 px phones, landscape, portrait tablet, 1024 px, and wide desktop;
  inspect rendered UI as well as geometry and behavior. State physical Safari
  limitations rather than claiming device acceptance from Chromium emulation.
- Run `npm run check`, formatting, and CI before one PR is merged into current main.
- Deploy on port 3000 through the existing installer and verify vault preservation.
