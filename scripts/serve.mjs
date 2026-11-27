/** Tiny static server for testing /docs locally: npm run serve */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'docs');
const port = Number(process.env.PORT) || 8080;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) throw new Error('Forbidden');
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      file = path.join(file, 'index.html'); // /help -> /help/index.html
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    try {
      const body = await readFile(path.join(root, 'index.html'));
      res.writeHead(200, { 'Content-Type': types['.html'], 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found. Run `npm run build` first.');
    }
  }
}).listen(port, () => console.log(`Serving /docs at http://localhost:${port}`));
