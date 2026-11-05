import express from 'express';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { isIP } from 'node:net';
import os from 'node:os';
import { sceneSchema } from '../shared/model.js';
import { Vault, VaultError } from './vault.js';
import { changeStream } from './changes.js';

export function createApp(vault: Vault, clientDirectory?: string) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const hostname = req.hostname?.replace(/^\[|\]$/g, '');
    const hosts = [
      'localhost',
      os.hostname(),
      ...(process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()),
    ];
    if (!hostname || (!isIP(hostname) && !hosts.includes(hostname))) {
      return res.status(403).json({ error: 'Host not allowed.', code: 'host' });
    }
    // No CORS. Also reject cross-origin writes before parsing any document payload.
    const origin = req.get('origin');
    const ownOrigin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== ownOrigin)) {
      return res.status(403).json({ error: 'Origin not allowed.', code: 'origin' });
    }
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Use application/json.', code: 'content_type' });
    }
    next();
  });
  app.use(express.json({ limit: '40mb' }));
  const getPath = (value: unknown) => z.string().parse(value);
  app.get('/api/health', (_req, res) =>
    res.json({ ok: true, application: 'excalidraws', pid: process.pid }),
  );
  const events = changeStream(vault.root);
  app.get('/api/events', events);
  app.get('/api/entries', async (_req, res) => res.json(await vault.list()));
  app.get('/api/document', async (req, res) => res.json(await vault.read(getPath(req.query.path))));
  app.get('/api/revision', async (req, res) =>
    res.json({ revision: await vault.revision(getPath(req.query.path)) }),
  );
  app.post('/api/entries', async (req, res) => {
    const body = z.object({ path: z.string(), scene: sceneSchema.optional() }).parse(req.body);
    res.status(201).json(await vault.create(body.path, body.scene));
  });
  app.put('/api/document', async (req, res) => {
    const body = z
      .object({ path: z.string(), revision: z.string(), scene: sceneSchema })
      .parse(req.body);
    const saved = await vault.save(body.path, body.revision, body.scene);
    res.json({ revision: saved.revision });
  });
  app.post('/api/move', async (req, res) => {
    const body = z
      .object({ from: z.string(), to: z.string(), exclude: z.string().optional() })
      .parse(req.body);
    res.json(await vault.move(body.from, body.to, body.exclude));
  });
  app.post('/api/trash', async (req, res) =>
    res.json(await vault.trash(z.object({ path: z.string() }).parse(req.body).path)),
  );
  app.get('/api/trash', async (_req, res) => res.json(await vault.listTrash()));
  app.post('/api/restore', async (req, res) => {
    const body = z.object({ id: z.string(), path: z.string().optional() }).parse(req.body);
    res.json({ path: await vault.restore(body.id, body.path) });
  });
  // Workspace metadata lives in a private file the watcher ignores, so notify clients directly.
  app.post('/api/library', async (req, res) => {
    const body = z
      .object({
        property: z.enum(['favorite', 'archived']),
        paths: z.array(z.string()).min(1).max(10_000),
        value: z.boolean(),
      })
      .parse(req.body);
    await vault.setLibrary(body.paths, body.property, body.value);
    events.notify();
    res.json({ ok: true });
  });
  app.post('/api/order', async (req, res) => {
    const body = z
      .object({ folder: z.string(), paths: z.array(z.string()).max(10_000) })
      .parse(req.body);
    await vault.order(body.folder, body.paths);
    events.notify();
    res.json({ ok: true });
  });
  app.get('/api/history', async (req, res) =>
    res.json(await vault.history(getPath(req.query.path))),
  );
  app.get('/api/history/document', async (req, res) =>
    res.json(await vault.historical(getPath(req.query.path), getPath(req.query.revision))),
  );
  app.use('/api', (_req, res) =>
    res.status(404).json({ error: 'Unknown route.', code: 'not_found' }),
  );
  if (clientDirectory) {
    app.use(express.static(clientDirectory, { index: false, maxAge: '1h' }));
    app.get('/', (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile('index.html', { root: clientDirectory });
    });
  }
  app.use(
    (
      error: Error & { code?: string; status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof VaultError)
        return res.status(error.status).json({ error: error.message, code: error.code });
      if (error instanceof ZodError || error instanceof SyntaxError)
        return res.status(400).json({ error: 'Invalid data.', code: 'validation' });
      if (error.code === 'ENOENT')
        return res.status(404).json({ error: 'The canvas no longer exists.', code: 'not_found' });
      if (error.code === 'EEXIST')
        return res.status(409).json({ error: 'The name already exists.', code: 'exists' });
      if (error.status === 413)
        return res.status(413).json({ error: 'The document exceeds 40 MB.', code: 'too_large' });
      console.error(error);
      res.status(500).json({
        error: 'The operation could not be completed. Your drawing is still open in the editor.',
        code: 'server',
      });
    },
  );
  return Object.assign(app, { closeStreams: events.close });
}
