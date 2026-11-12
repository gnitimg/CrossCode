import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Serves a built single-page app (Vite `dist/`) from the gateway origin.
 *
 * Why on the gateway origin: the workbench resolves REST to `/api/**` and the
 * session socket to `/ws/session` when no explicit daemon URL is configured,
 * so hosting the assets here lets both the desktop shell and a plain browser
 * use one origin with no CORS and no proxy.
 *
 * Unknown GET paths fall back to `index.html` so client-side routing works.
 */

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

async function trySendFile(reply: FastifyReply, filePath: string, relative: string): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return false;

  reply.type(MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream');
  reply.header(
    'cache-control',
    relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  );
  reply.send(await fs.readFile(filePath));
  return true;
}

export function registerStaticFiles(app: FastifyInstance, rootDir: string): void {
  const root = path.resolve(rootDir);
  const indexPath = path.join(root, 'index.html');

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({ error: 'not found' });
    }

    const rawPath = (request.raw.url ?? '/').split('?')[0] ?? '/';
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return reply.code(400).send({ error: 'malformed path' });
    }

    const relative = decoded.replace(/^\/+/, '');
    const candidate = path.resolve(root, relative);
    // Traversal guard: the resolved path must stay inside the static root.
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    if (relative.length > 0 && (await trySendFile(reply, candidate, relative))) {
      return reply;
    }
    if (await trySendFile(reply, indexPath, 'index.html')) {
      return reply;
    }
    return reply.code(404).send({ error: 'not found' });
  });
}
