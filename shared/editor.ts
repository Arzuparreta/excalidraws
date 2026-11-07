import { z } from 'zod';

export const EDITOR_CONTRACT = 1;
export const MAX_EDITOR_BYTES = 80 * 1024 * 1024;
export const editorPath = z
  .string()
  .max(240)
  .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
  .refine((value) => value.split('/').every((part) => part !== '.' && part !== '..'));
export const editorManifestSchema = z
  .object({
    format: z.literal(1),
    contract: z.literal(EDITOR_CONTRACT),
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/),
    packageVersion: z.string().max(80),
    entry: editorPath,
    css: z.array(editorPath).min(1).max(10),
    archive: z.object({
      url: z.string().url().max(2048).optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      size: z
        .number()
        .int()
        .positive()
        .max(40 * 1024 * 1024),
    }),
    files: z
      .array(
        z.object({
          path: editorPath,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          size: z
            .number()
            .int()
            .nonnegative()
            .max(25 * 1024 * 1024),
        }),
      )
      .min(3)
      .max(1000),
  })
  .superRefine((manifest, context) => {
    const paths = new Set(manifest.files.map((file) => file.path));
    if (
      paths.size !== manifest.files.length ||
      paths.has('manifest.json') ||
      !paths.has(manifest.entry) ||
      manifest.css.some((file) => !paths.has(file)) ||
      manifest.files.reduce((size, file) => size + file.size, 0) > MAX_EDITOR_BYTES
    )
      context.addIssue({ code: 'custom', message: 'Invalid editor file inventory.' });
  });
export type EditorManifest = z.infer<typeof editorManifestSchema>;
export interface EditorLocation {
  id: string;
  packageVersion: string;
  entry: string;
  css: string[];
}
export interface EditorStatus {
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  received: number;
  total: number;
  error?: string;
}
