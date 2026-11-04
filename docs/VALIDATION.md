# Delivery verification

Verified on `desktop` on November 4, 2026.

- Client and server TypeScript checks pass.
- The production build passes. Vite reports large editor chunks; diagram modules load
  separately. There are no compilation errors.
- All 12 server and session tests pass.
- All 7 Chromium E2E flows pass. They cover drawing and immediate switching, files and folders,
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
