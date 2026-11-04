# Repository conventions

Use English for all repository-owned text: UI copy, editor locale, documentation, comments,
error messages, filenames, directory names, identifiers, test fixtures, and generated default
names. Keep existing user-created document names and content intact.

Integrate Excalidraw only through its public package API, keeping editor-specific code in
`src/editor/ExcalidrawAdapter.tsx`.

Run `npm run check` for functional changes and `npm run format:check` before committing.
Verify the rendered UI when changing visible text or layout. Keep the installed service on
port 3000 and preserve its vault when deploying updates.
