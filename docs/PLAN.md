# Excalidraws: plan and boundaries

## Goal

Extend the official Excalidraw editor into a personal file workspace: a collapsible left
sidebar, folders, multiple canvases, automatic saving on the desktop, and access from other
devices. The repository started empty; the editor remains an upstream dependency.

## Architecture

- Solid.js renders the workspace, navigation, virtualized sidebar, and anchored popovers. Vite builds
  the application. Dependencies use exact versions and a lockfile.
- `@excalidraw/excalidraw` remains the official React component. Only
  `src/editor/ExcalidrawAdapter.tsx` knows its public API and React lifecycle. A lazy import
  mounts one editor island and explicitly destroys it when switching documents.
- `src/workspace`: the HTTP client, save lifecycle, and file explorer. The integration page
  simply mounts this module.
- Node and Express serve the compiled application and a same-origin API.
- A shared native filesystem watcher and server-sent events invalidate visible clients.
  Hidden clients disconnect; focus and reconnection revalidate the open revision. No periodic
  document polling or vault scanning runs in the browser. Graceful shutdown closes streams.
- A configurable folder is the source of truth. Documents are standard `.excalidraw` JSON
  files with embedded images and viewport state. There is no database.
- SHA-256 revisions and temporary-file writes followed by fsync and rename. A queue serializes
  service mutations. Clients always submit the revision they opened.
- Trash and history live outside the visible tree. Names and paths are validated, symbolic
  links are rejected, and foreign-origin writes are blocked.

## Integrity and user experience

- Save after a short pause; also retain a local draft in IndexedDB.
- Wait for saving before switching documents. Errors and conflicts keep the current drawing open.
- Coalesce drawing snapshots outside input handlers and defer viewport serialization until
  pan/zoom pauses. Group IndexedDB writes, bound save scheduling during continuous drawing,
  and explicitly flush before switching, exporting, or hiding the page.
- Cancel obsolete document reads and commit only the latest requested canvas. Keep navigation
  history as paths rather than retaining inactive scenes. Undo history belongs to the one
  active editor and resets when it is destroyed.
- Keep the active canvas in its folder in a virtualized keyboard-navigable explorer.
  Favorites, Archive, and Trash use the same explorer area. On narrow or short viewports,
  contain keyboard/pointer interaction in an overlay drawer without resizing the canvas.
- Store shared organization in `.workspace/library.json`, separately from scene data.
  File and folder moves carry metadata and history; trash/restore retain both.
- Anchor management surfaces to their controls. Reversible actions offer Undo; discarding
  local edits requires inline confirmation. See [UX-DESIGN.md](UX-DESIGN.md).
- Reload external changes when the editor is clean. When local edits exist, retain the draft
  and offer to load the server version or save a copy.
- Compare the draft's original revision when recovering after a page reload.
- Support creating, renaming, and moving files and folders. Deletion sends them to the trash.
- Use the native format for imports and exports. Detect conflicts between devices without
  attempting to merge simultaneous edits or provide CRDT collaboration.
- Use English throughout the UI and repository, including errors, comments, filenames,
  identifiers, test fixtures, and generated default document names.

## Delivery and verification

1. Define the file contract and test concurrency, paths, trash, and history.
2. Build the editor integration, responsive explorer, search, autosave, and recovery.
3. Exercise the actual editor: drawing, switching, saving, reloads, images, conflicts, and mobile.
4. Produce a self-contained build, including fonts, and a systemd installer with unit backups,
   HTTP checks, and documentation for updates, backups, and rollback.

## Updates

Use public package exports and avoid the editor's internal DOM or private modules.
Updates are explicit: review the changelog, update the pinned version, and run compatibility
checks. Future 0.x releases may introduce breaking API changes.
