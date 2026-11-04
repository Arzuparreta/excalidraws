# Delivery verification

Verified on `desktop` on November 4, 2026.

- Client and server TypeScript checks pass.
- The production build passes. Vite reports large editor chunks; diagram modules load
  separately. There are no compilation errors.
- All 15 server and session tests pass.
- All 11 Chromium E2E flows pass. They cover drawing and immediate switching, files and folders,
  images and viewport state, imports and exports, text and arrows, conflicts, recovery after
  save failures, and recovery after external deletion.
- Desktop and a 390 × 844 mobile viewport were inspected. The mobile explorer becomes hidden
  and inaccessible when closed. There is no horizontal overflow.
- Editor assets and fonts work with external HTTP requests blocked in the text and arrow test.
  Test data uses independent temporary vaults.
- `npm audit` reports zero vulnerabilities with the delivered lockfile.
- Prettier formatting checks pass.
- A packaging regression is covered: HTML and assets load from releases under a hidden parent
  such as `.local`, while hidden files remain private.

## Installed service

- Unit: `excalidraws.service`, enabled and active.
- Listen address: `0.0.0.0:3000`.
- Frontend and API checked at `http://127.0.0.1:3000` and
  `http://100.91.167.48:3000` from the desktop.
- Vault: `/home/arsu/.local/share/excalidraws/vault`.
- User lingering is enabled, allowing startup without an interactive session.
- A rectangle was drawn through Chromium against the installed service. After saving and
  restarting systemd, the file retained its content and SHA-256 revision before the editor
  reloaded. Reloading recovered the drawing without JavaScript errors. The acceptance file
  and its history were removed afterward.
- A deployment to an occupied port was intentionally attempted. Its check failed, and the
  installer restored the working service on port 3001.
- At the user's request, the previous `excalidraw.service`, its container, and its Docker image
  were removed. `excalidraws.service` moved to port 3000, leaving port 3001 free. Vault files
  retained their SHA-256 hashes. Tailscale and browser data were unchanged.

The mobile check uses an emulated viewport rather than a physical phone. Tailscale
connectivity was checked from the desktop rather than a second device.

## English-language update

The workspace UI, official editor locale, browser title, API errors, recovery messages,
documentation, fixtures, and generated default names use English. All tracked filenames
and source identifiers were reviewed for the same policy. The existing test flows now
exercise English labels in both the workspace and the official editor.

The English build was deployed to the existing service on port 3000. A read-only Chromium
inspection with a French browser locale confirmed English workspace labels, official editor
tools, page language, title, and API errors, with no JavaScript errors. The existing vault's
filenames and file hashes were unchanged by deployment.

## Solid workspace update

The workspace was rebuilt in Solid.js with a compact sidebar based on the supplied T3 Code
reference. The active canvas stays visible above a virtualized file list; the editor occupies
the remaining area. Decorative welcome artwork, promotional copy, and animated loading
indicators were removed. React and Excalidraw imports exist only in the public-API adapter.
The adapter mounts its React root once per document; workspace interactions do not render it.

- `npm run check` passes: type checks, 15 server/session tests, production build, and 11
  Chromium E2E tests. `npm run format:check` passes.
- The empty workspace does not request the editor JavaScript or CSS. The workspace entry
  chunk is approximately 69 kB minified; the editor loads separately when opening a canvas.
- A 300-canvas library renders fewer than 60 file rows. Search retains the active document.
- Rapid selection cancels a deliberately blocked read and opens the last selected canvas
  without mounting the intermediate canvas. A failed read keeps the current editor attached.
  Only one editor remains mounted after navigation and resizing.
- An idle observation window of 3.2 seconds produces no document, revision, or entry-list
  requests after startup settles. Pointer movement and sidebar search do not save documents
  or replace the active canvas. Live updates use a shared native filesystem watcher and SSE.
- External filesystem edits produce notifications; private metadata writes do not. Graceful
  shutdown closes event streams, including an attached browser client.
- Snapshot coalescing, grouped local drafts, bounded save scheduling during continuous edits,
  save-in-flight edits, conflicts, and offline draft recovery are covered. Pending editor
  snapshots keep the status from claiming that all changes are saved.
- Desktop, 390 px mobile drawer, 320 px canvas, and a short landscape viewport were visually
  inspected. Automated layout checks also cover widths of 760, 761, 1024, and 1366 px.
  The mobile drawer makes the underlying workspace inert, contains keyboard focus, and
  returns focus when closed. Escape closes a dialog before closing the drawer behind it.
- Browser errors were absent in the visual inspection. Text, arrows, image import/export,
  zoom/scroll recovery, history, trash, and file operations pass against the production build.

The updated build is installed in `excalidraws.service` at port 3000. Its health PID matches
systemd's active process. Before updating, the vault was archived under
`~/.local/share/excalidraws/backups/`. All seven existing document/metadata files retain their
SHA-256 hashes, excluding the service lock. A separate browser context inspected the installed
empty workspace, then used a browser-only document fixture to exercise its installed editor
bundle at desktop and mobile sizes. API writes were blocked and vault hashes remained unchanged.
The installed editor uses English even with a Spanish browser locale.

These are desktop Chromium checks and emulated viewports. Physical ThinkPad battery/GPU
consumption and physical touch-device behavior have not been measured. Switching documents
destroys the inactive editor and resets its undo/redo history; scene content and viewport
are preserved.

## Creation and naming workflow update

Canvases and folders are created immediately with unique English default names. New folders
can be named inline after creation; cancelling keeps the created item. Canvas titles and
explorer rows support inline renaming. Move destinations are picked inside the sidebar.

- `npm run check` passes: TypeScript, 18 server/session tests, production build, and 14
  Chromium E2E flows. `npm run format:check` passes.
- Default names are scoped to their destination. A deliberately introduced concurrent
  creation collision is retried without overwriting the other client's document. Repeated
  folder creation produces siblings. Folder names ending in `.excalidraw` remain intact.
- Naming checks cover empty and invalid names, existing-name collisions, typing, Enter,
  checkmark submission, Escape, blur, retained search focus, and clicking Create while a
  name is being edited. Escape cancels a name before closing the mobile explorer.
- Renaming an open canvas or its parent folder preserves the mounted editor and undo
  history. Navigation and the last-opened path follow the new location. Selection waits
  for an ongoing naming operation instead of dropping the click. Late editor snapshots
  wait for a move to finish; a failed move resumes saving to the original path.
- Desktop inline folder naming, the sidebar move picker, and the 390 px mobile title editor
  were visually inspected. Layout checks also cover 320, 760, 761, 1024, and 1366 px widths.
- The installed service remains active at `0.0.0.0:3000`, using the original vault and host
  settings. Its health PID matches systemd and its served HTML matches the checked build.
  A separate browser context with a Spanish locale exercised the installed creation and
  inline naming UI at desktop and mobile sizes using browser-only API fixtures. No writes
  reached the real vault and no browser errors occurred.
- Before deployment the vault was archived as
  `~/.local/share/excalidraws/backups/workflow-2026-11-04T13-38-28Z.tar.gz`.
  After deployment and browser inspection, all 21 existing document/metadata files retained
  their SHA-256 hashes and all 11 directories were unchanged, excluding the service lock.

## Shared inline name editing

Pencil buttons beside canvas and folder names open an inline editor in the sidebar. The
canvas header keeps its title editing and places its pencil beside the title instead of
in the document tools. A single rename draft feeds both views synchronously; typing does
not change filesystem paths, sort or filter the tree, or remount the editor. Only confirming
or leaving the field persists the name. Switching between the sidebar and header carries
the draft without an intermediate rename. Escape discards it in both views.

The browser regression checks exercise each typed character, both edit locations, transfer
between them, cancellation, a single committed move, inactive canvas and folder pencils,
editor identity, and the mobile sidebar. Screenshots cover the desktop and mobile controls.
The list's rename scrolling depends only on the target path and error visibility, so typing
does not rescan the list to reposition it.
