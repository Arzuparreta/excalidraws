import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Local publisher for development and E2E; production always uses the configured HTTPS channel.
export async function artifactServer() {
  const server = createServer(async (req, res) => {
    const name = req.url?.slice(1);
    if (!['editor-manifest.json', 'editor.json.gz'].includes(name)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(`dist/editor-artifact/${name}`);
      res.writeHead(200, {
        'Content-Type': name.endsWith('.gz') ? 'application/gzip' : 'application/json',
        'Content-Length': bytes.length,
      });
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/editor-manifest.json`,
    close: () => server.close(),
  };
}
