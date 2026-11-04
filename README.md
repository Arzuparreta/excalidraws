# Excalidraws

The official Excalidraw editor with a sidebar explorer and real files on your server.
Each canvas is an independent `.excalidraw` file: edit it in your browser, open it
in Excalidraw, or include its folder in your backups.

The workspace is built with Solid.js and Vite. The official React editor is an isolated,
lazy-loaded component; React does not render the sidebar, navigation, or dialogs.

The integration uses `@excalidraw/excalidraw` and its public API. The editor remains
a dependency; this repository adds document management and a file service. It does
not maintain an editor fork or provide an installable plugin for excalidraw.com.

## Usage

- Create canvases and folders with one click in the sidebar. They are saved immediately as
  `Untitled canvas` or `Untitled folder`, followed by `(1)`, `(2)`, etc. when needed. Names
  are unique within the destination folder, including when another client creates one first.
- Click the pencil beside a canvas or folder name in the sidebar to rename it in place.
  The canvas header also has a pencil beside its title. Both locations share a live name
  draft: typing updates the other view immediately, without renaming the file per keystroke.
  You can also use the `…` menu or press F2 on a focused explorer row. Edit names in place: Enter or the checkmark saves,
  Escape cancels, and leaving the field saves. New folders offer inline naming immediately;
  cancelling keeps the folder with its default name.
- The “Creating in” line shows where new items will go. Select a folder to create inside it,
  or use its reset button to return to My canvases. Creating a folder keeps the current
  destination so repeated clicks create siblings. Search by name or path.
- The active canvas stays at the top of the sidebar. Sort other canvases by recent changes
  or name, collapse folders, and use the back/forward buttons to revisit opened canvases.
- Use Ctrl/Cmd+K to focus search. Hide the sidebar for more drawing space; on small screens,
  it opens as a drawer with keyboard focus contained inside it.
- Use the `…` menu to rename, move, or send files and folders to the trash. Moving uses a
  folder picker inside the sidebar. Renaming or moving an open canvas (or its parent folder)
  preserves the mounted editor, drawing, viewport, and undo/redo history.
- Changes are saved automatically after a short pause. Continuous changes schedule a save
  within four seconds. Switching canvases flushes the current drawing before loading another.
- Rapid selections cancel obsolete loads and open the last requested canvas. Failed loads
  leave the current drawing intact. Only one editor is mounted; inactive canvases do not
  keep live renderers or image caches. Switching resets the editor's undo/redo history.
- Drawings include embedded images and retain their scroll position and zoom.
- Import one or more `.excalidraw` files without replacing existing files. Download a canvas
  from its header.
- Restore deleted files from the trash. Version history retains the last 20 previous versions
  **per path**. Restoring a version creates a new canvas.
- External changes reload automatically when the editor is clean. If you have local changes,
  a conflict lets you save a copy, download your drawing, or load the server version.

This is a personal workspace with conflict detection. It does not merge simultaneous edits.
When two clients save against the same revision, the second receives a conflict. External
file writers do not participate in the service lock. The revision is checked again immediately
before rename, but an external write in that narrow interval can still race with saving.
Avoid editing the same file in multiple tools at once.

The workspace and the embedded editor use English. Repository documentation, messages,
comments, identifiers, filenames, test data, and generated default names also use English.

## Development

Requires Node **22.12 or later**, npm, and Linux for the systemd installer.

```sh
npm ci
npm run dev
```

Open `http://localhost:5173`. Vite proxies the API to `127.0.0.1:3001`.
Files are stored in `./data/` by default, which is ignored by Git.

```sh
npm run build
npm start
```

The production build serves the frontend and API at `http://127.0.0.1:3001` by default.
Excalidraw assets and fonts are included; the editor does not require a CDN.

| Variable        | Default              | Purpose                                   |
| --------------- | -------------------- | ----------------------------------------- |
| `VAULT_DIR`     | `./data`             | Document folder                           |
| `HOST`          | `127.0.0.1`          | Listen address                            |
| `PORT`          | `3001`               | HTTP port                                 |
| `ALLOWED_HOSTS` | empty                | Additional DNS names, separated by commas |
| `PUBLIC_ORIGIN` | incoming HTTP origin | External origin when using an HTTPS proxy |

The API accepts `localhost`, the machine hostname, and IP addresses. For a Tailscale DNS
name or a reverse proxy, add the hostname to `ALLOWED_HOSTS` and preserve Host and Origin.
If the proxy terminates HTTPS, set `PUBLIC_ORIGIN=https://draw.example.com`
(installer option: `--origin`).

The API rejects foreign origins, hidden paths, traversal outside the vault, and symbolic
links. There are no accounts or authentication: use loopback or a trusted private network.
Public deployments need authentication and HTTPS in front of the service.
The document size limit is 40 MB.

## User systemd service

The installer creates a release independent of the checkout, installs production dependencies,
and enables `excalidraws.service`. Updates back up the previous unit and roll back if the
frontend or API check fails. The vault stays outside the releases.

```sh
npm run build
node scripts/install-service.mjs --dry-run --host 0.0.0.0 --port 3000
# Access from localhost, LAN, and Tailscale:
node scripts/install-service.mjs --host 0.0.0.0 --port 3000
# To restrict access to localhost:
# node scripts/install-service.mjs --port 3000
```

The default vault is `~/.local/share/excalidraws/vault`. The installer respects
`XDG_DATA_HOME` and `XDG_CONFIG_HOME`. It does not change other services or Tailscale.

```sh
systemctl --user status excalidraws
systemctl --user restart excalidraws
journalctl --user -u excalidraws -f
```

The service starts with the user session. To run it without an interactive session,
enable user lingering if needed: `loginctl enable-linger "$USER"`.

To roll back, copy a previous unit backup to `~/.config/systemd/user/excalidraws.service`,
run `systemctl --user daemon-reload`, and restart the service.

To uninstall, run `systemctl --user disable --now excalidraws`, remove the unit file,
and run `systemctl --user daemon-reload`. You can remove the releases separately;
keep the vault to retain your drawings.

### Migration and backups

The standard Excalidraw frontend stores drawings in the browser. Export those drawings as
`.excalidraw` files and import them here. Browser storage is not shared across ports.
This workspace does not delete the previous frontend's browser storage.

Back up **the entire vault**, including `.workspace/` for history and trash. Stop the service
for a consistent backup. When restoring with the service stopped, remove
`.workspace/server.lock` if necessary: a PID from another machine may match an active process.
Do not share the vault between multiple servers or let untrusted users edit its contents.
The lock prevents two local service instances; it does not coordinate multiple hosts over NFS.

Moving or renaming a document starts a new history for its path. Previous versions remain
in `.workspace/history` under the old path's hash.

Local draft writes are grouped over 250 ms; editor snapshots are also coalesced. Switching,
exporting, and hiding the page flush pending editor snapshots. Draft availability depends
on browser storage. The “Saved” status confirms that the server accepted the current changes,
including any pending editor snapshot.
Keep the page open until that status appears; the browser warns about unsaved changes.

The sidebar virtualizes long lists. A shared filesystem watcher notifies visible clients
of changes over server-sent events instead of repeatedly polling documents or scanning the
vault. Hidden pages disconnect and check for changes when visible again. Changes made by
external tools are detected, but concurrent edits are still resolved as conflicts, not merged.

## Checks and updates

```sh
npm test
npm run build
npx playwright install chromium  # Only if Chromium is not installed yet.
npm run test:e2e
```

Server and session tests cover images, concurrent writes, external changes, paths, symbolic
links, trash, history, drafts, and edits made while a save is in flight. Playwright uses the
production build with a temporary vault to test drawing, quick switching, reloads, conflicts,
recovery after save failures, imports, exports, mobile layouts, obsolete-load cancellation,
idle network activity, and a library of 300 canvases. These tests do not use
the personal vault or the installed service.

Versions are pinned in `package.json` and `package-lock.json`. Overrides address known
advisories in Excalidraw's transitive dependencies: nanoid, lodash-es, and KaTeX.
When updating, review the editor changelog and overrides, run `npm run check` and `npm audit`,
and inspect drawing, text, arrows, images, viewport state, and imports.
`src/editor/ExcalidrawAdapter.tsx` is the integration boundary with Excalidraw 0.18.1.

Architecture and decisions: [docs/PLAN.md](docs/PLAN.md).
Verification evidence: [docs/VALIDATION.md](docs/VALIDATION.md).
