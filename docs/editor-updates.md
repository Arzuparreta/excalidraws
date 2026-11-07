# Downloadable editor plan and maintenance

## Delivery boundary

The distributable application is `dist/client`, `dist/server`, `dist/shared`, and production
server dependencies. It contains the Solid shell, file service and editor downloader.
Excalidraw and React are development dependencies used only to build a separate editor
artifact. Neither their code nor their fonts are copied into the shell build.

The editor artifact contains the unchanged official npm package, React, the public-API
adapter in `src/editor/ExcalidrawAdapter.tsx`, CSS, fonts, and license notices. No editor
source is forked. The shell/editor contract is `src/editor/contract.ts`, versioned by
`shared/editor.ts`. A contract-breaking change requires a new channel and shell update.

## Install and update lifecycle

1. An empty workspace needs no editor download. Opening or importing a canvas requests it.
2. The server resolves the contract's stable release channel, downloads a bounded compressed
   JSON archive, checks SHA-256, validates its complete file inventory, and stages regular files.
3. Only a complete verified directory becomes current via an atomic pointer rename. The cache
   is separate from the vault. Concurrent requests share one install. Interrupted staging is
   removed on startup. The first download displays progress with an actionable retry on failure.
4. A cached editor opens without waiting for the network. The server checks for compatible
   updates in the background at most every six hours while clients request the editor.
   Failed updates keep the installed editor and are retried after the check interval.
5. A browser pins its module and styles for the page lifetime. Updates activate on a later
   page load, without interrupting drawings or changing undo history. Installed versions stay
   available to existing pages. A failed module/style load tries the previous cached version.
6. A cold installation needs network access; a warm installation works when the artifact
   host is unavailable. Clearing the cache requires another download. The browser still needs
   access to the local file service; this does not add a service worker or offline vault.

## Artifact protocol and trust

`editor-manifest.json` describes format/contract 1, a content-derived editor ID, package
version, entry, CSS, archive hash/size and every file's hash/size. The archive URL points
to an immutable release (or defaults to `editor.json.gz` next to the manifest for local
publishers). It contains an array of `{ path, data }` records, with base64 regular-file data.
Limits bound download, decompression, file count and total size. Unknown, duplicate, unsafe,
missing or modified paths reject the whole candidate. There are no package scripts at runtime.

HTTPS and the configured publisher establish trust. Hashes detect corrupted/inconsistent
assets; they are not independent publisher signatures. The default source is this repository's
`editor-channel-v1` GitHub release. Only maintainers publishing tested artifacts can change it.
`EDITOR_MANIFEST_URL` can select another trusted HTTPS publisher (HTTP is allowed only on
loopback for local development/tests). Do not point it at untrusted code.

Cache defaults to `$XDG_CACHE_HOME/excalidraws/editors`, or `~/.cache/excalidraws/editors`.
`EDITOR_CACHE_DIR` overrides it. Do not share one cache between server processes or put it
inside the vault. Cached files are checked again after server restart; corrupt candidates
are ignored. A previous version is retained for module-load fallback. Cache versions are
not automatically pruned, because an older browser can still need lazy chunks and fonts.
Operators can remove unused version directories with the service stopped. Editor rollback
cannot reverse a newer scene format: preserve vault backups and document revisions.

## Build, test and publish

- `npm run build` builds the shell only.
- `npm run package:shell` produces a prebuilt shell archive with the service installer.
  Packaged installation uses `npm ci --omit=dev` and never downloads editor build dependencies.
- `npm run build:editor` builds the independent editor and its downloadable artifact.
- `npm run check` tests the shell against that artifact through the real download/cache path.
- `npm run dev` uses the same local artifact protocol, without accessing public releases.
- The editor publishing workflow runs all checks before publishing an immutable release
  for the content ID, verifies the downloaded release assets, then updates the stable
  contract channel. First publication runs after this change merges to `main` (or by
  manual workflow dispatch on `main`); until then a cold production install shows a
  retryable error.
- Dependabot checks the official stable npm package daily and opens a dependency PR.
  Its PRs trigger the normal required checks. Maintainers inspect upstream changes, fix
  the adapter if needed, and merge. Existing candidates and maintainer fixes are preserved
  by GitHub's dependency-update workflow. Merging then triggers editor publication.
  No custom token or permission to create/approve PRs from Actions is needed.

The default channel follows tested stable npm releases, not every commit or every feature
on excalidraw.com. Collaboration and hosted application services are separate integrations.
A failed upstream candidate never replaces the current published channel. Publishing remains
independent of installing or deploying the shell. The initial shell download is smaller;
total installed size still includes the downloaded editor.

## Acceptance coverage

Verify shell output excludes React/editor/fonts; cold download and progress; concurrent
installs; hash, path, size, decompression and contract rejection; interrupted/corrupt cache;
offline restart; failed/successful background update; old-version asset retention; module
fallback; retry; and normal drawing, autosave, import/export, images, links, themes and undo.
The browser suite uses a disposable vault and local artifact host, never the installed vault.

## Local validation for this implementation

The complete `npm run check` passed 59 server/session/installer tests and 34 Chromium
browser tests through a real locally served editor artifact. Desktop and mobile progress
and retry screenshots were visually inspected. Formatting and the dependency audit passed.
A fresh extracted shell archive installed with no Excalidraw, React or Vite in its production
dependency tree, downloaded the editor on first use, and served it after an offline restart
while preserving its disposable vault bytes. The installed port-3000 service and real vault
were not deployed or modified. Public editor publication remains pending merge to `main`.
