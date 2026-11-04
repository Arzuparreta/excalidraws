# Repository conventions

Use English for all repository-owned text: UI copy, editor locale, documentation, comments,
error messages, filenames, directory names, identifiers, test fixtures, and generated default
names. Keep existing user-created document names and content intact.

Integrate Excalidraw only through its public package API, keeping editor-specific code in
`src/editor/ExcalidrawAdapter.tsx`.

Run `npm run check` for functional changes and `npm run format:check` before committing.
Verify the rendered UI when changing visible text or layout. Keep the installed service on
port 3000 and preserve its vault when deploying updates.

# Delivery workflow

After each requested change, create a dedicated branch, commit the completed work, push it,
open a pull request, and merge it automatically once the required checks pass. Fetch the
latest target branch and verify that the delivery branch includes it before opening and
merging the pull request. Follow any explicit delivery restrictions given by the user for
that task.
