import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

export function makeWorkflowSiteServer(root) {
  const base = resolve(root);
  return createServer(async (req, res) => {
    try {
      const path = resolve(base, `.${new URL(req.url, 'http://localhost').pathname}`);
      if (!path.startsWith(`${base}${sep}`)) { res.writeHead(403).end(); return; }
      const bytes = await readFile(path);
      res.writeHead(200, { 'content-type': extname(path) === '.mjs' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
      res.end(bytes);
    } catch { res.writeHead(404).end('Not found'); }
  });
}
