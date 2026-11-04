import { watch, type FSWatcher } from 'node:fs';
import type { Request, Response } from 'express';

// One native watcher is shared by all visible clients. Hidden tabs disconnect.
// Private history and temporary writes never produce client work. Changes to private
// workspace metadata are announced explicitly with notify().
export function changeStream(root: string) {
  const clients = new Set<Response>();
  let watcher: FSWatcher | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const broadcast = () => {
    pending = undefined;
    for (const client of clients) {
      if (!client.write('event: change\ndata: {}\n\n')) client.end();
    }
  };
  const schedule = () => {
    clearTimeout(pending);
    pending = setTimeout(broadcast, 160);
  };
  const connect = (_req: Request, res: Response) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    clients.add(res);
    if (!watcher) {
      try {
        watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
          if (filename?.split(/[\\/]/).some((part) => part.startsWith('.'))) return;
          schedule();
        });
        watcher.on('error', () => {
          // Reconnection performs a full revision check and recreates the watcher.
          for (const client of [...clients]) client.end();
        });
      } catch {
        clients.delete(res);
        res.end();
        return;
      }
      heartbeat = setInterval(() => {
        for (const client of clients) if (!client.write(': keep-alive\n\n')) client.end();
      }, 30_000);
      heartbeat.unref();
    }
    res.on('close', () => {
      clients.delete(res);
      if (!clients.size) {
        watcher?.close();
        watcher = undefined;
        clearTimeout(pending);
        clearInterval(heartbeat);
      }
    });
  };
  return Object.assign(connect, {
    notify: () => {
      if (clients.size) schedule();
    },
    close: () => {
      for (const client of [...clients]) client.end();
    },
  });
}
