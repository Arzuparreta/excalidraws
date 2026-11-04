# Excalidraws: plan and boundaries

## Goal

Extend the official Excalidraw editor into a personal file workspace: a persistent left
sidebar, folders, multiple canvases, automatic saving on the desktop, and access from other
devices. The repository started empty; the editor remains an upstream dependency.

## Architecture

- React and `@excalidraw/excalidraw`, with exact versions and a lockfile. Only the adapter
  knows the editor API: `initialData`, `onChange`, and public serialization utilities.
- `src/workspace`: the HTTP client, save lifecycle, and file explorer. The integration page
  simply mounts this module.
- Node and Express serve the compiled application and a same-origin API.
- A configurable folder is the source of truth. Documents are standard `.excalidraw` JSON
  files with embedded images and viewport state. There is no database.
- SHA-256 revisions and temporary-file writes followed by fsync and rename. A queue serializes
  service mutations. Clients always submit the revision they opened.
- Trash and history live outside the visible tree. Names and paths are validated, symbolic
  links are rejected, and foreign-origin writes are blocked.

## Integrity and user experience

- Save after a short pause; also retain a local draft in IndexedDB.
- Wait for saving before switching documents. Errors and conflicts keep the current drawing open.
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
