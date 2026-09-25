/**
 * Demo REST server for trying out (and testing) HTTP requests.
 *
 *   GET    /healthz                  {"status":"ok"}
 *   POST   /oauth/token              client credentials (form or JSON, body or Basic) → {"access_token":"demo-token"}
 *   GET    /notes                    list (requires Bearer demo-token)
 *   GET    /notes/:id                one note, 404 if missing
 *   POST   /notes                    create (JSON body) → 201
 *   PUT    /notes/:id                replace
 *   DELETE /notes/:id                → 204
 *   ANY    /echo                     echoes method, path, query, headers and body
 *   GET    /redirect                 302 → /healthz
 *   GET    /events                   text/event-stream, 3 events 150 ms apart
 *   GET    /report.pdf               small binary download
 *   GET    /slow?ms=500              responds after a delay
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Note {
  id: string;
  text: string;
  tags: string[];
}

function makeNotes(): Map<string, Note> {
  return new Map(
    [
      { id: 'n-100', text: 'Review the quarterly filing deadline', tags: ['filing'] },
      { id: 'n-101', text: 'Rotate the demo API key', tags: ['ops', 'security'] },
    ].map((n) => [n.id, n]),
  );
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

export function createDemoHttpServer(): Server {
  const notes = makeNotes();
  let seq = 102;
  let tokenRequests = 0;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const body = await readBody(req);
    const authed = req.headers.authorization === 'Bearer demo-token';

    try {
      if (path === '/healthz') return json(res, 200, { status: 'ok' });

      if (path === '/oauth/token' && req.method === 'POST') {
        // JSON (Auth0 style) or form-encoded (RFC 6749), client creds in the body or as HTTP Basic.
        const raw = body.toString();
        const input: Record<string, string> = /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (basic) {
          const [id, secret] = Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent);
          input.client_id = id!;
          input.client_secret = secret!;
        }
        tokenRequests++;
        if (input.client_id !== 'demo-client' || input.client_secret !== 'demo-secret') return json(res, 401, { error: 'invalid_client', error_description: 'unknown client or bad secret' });
        const expires = Number(url.searchParams.get('expires_in') ?? 3600);
        return json(res, 200, { access_token: 'demo-token', token_type: 'Bearer', expires_in: expires, scope: input.scope ?? '' });
      }
      if (path === '/oauth/stats') return json(res, 200, { tokenRequests });

      if (path === '/echo') {
        return json(res, 200, {
          method: req.method,
          path,
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          body: body.toString(),
        });
      }

      if (path === '/redirect') {
        res.writeHead(302, { location: '/healthz' });
        return res.end();
      }

      if (path === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        let i = 0;
        const t = setInterval(() => {
          i++;
          res.write(`event: tick\ndata: {"n":${i}}\n\n`);
          if (i === 3) {
            clearInterval(t);
            res.end();
          }
        }, 150);
        return;
      }

      if (path === '/report.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report.pdf"' });
        return res.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0x01, 0x02, 0xff, 0xfe]));
      }

      if (path === '/slow') {
        const ms = Math.min(Number(url.searchParams.get('ms') ?? 500), 10_000);
        await new Promise((r) => setTimeout(r, ms));
        return json(res, 200, { waited: ms });
      }

      const m = /^\/notes(?:\/([^/]+))?$/.exec(path);
      if (m) {
        if (!authed) return json(res, 401, { error: 'missing or invalid bearer token (expected "demo-token")' });
        const id = m[1] ? decodeURIComponent(m[1]) : undefined;
        if (!id && req.method === 'GET') {
          const tag = url.searchParams.get('tag');
          return json(res, 200, { items: [...notes.values()].filter((n) => !tag || n.tags.includes(tag)), total: notes.size });
        }
        if (!id && req.method === 'POST') {
          const input = JSON.parse(body.toString() || '{}');
          const note: Note = { id: `n-${seq++}`, text: String(input.text ?? ''), tags: Array.isArray(input.tags) ? input.tags : [] };
          notes.set(note.id, note);
          return json(res, 201, note, { location: `/notes/${note.id}` });
        }
        if (id && req.method === 'GET') return notes.has(id) ? json(res, 200, notes.get(id)) : json(res, 404, { error: `note ${id} not found` });
        if (id && req.method === 'PUT') {
          if (!notes.has(id)) return json(res, 404, { error: `note ${id} not found` });
          const input = JSON.parse(body.toString() || '{}');
          const note = { id, text: String(input.text ?? ''), tags: Array.isArray(input.tags) ? input.tags : [] };
          notes.set(id, note);
          return json(res, 200, note);
        }
        if (id && req.method === 'DELETE') {
          if (!notes.delete(id)) return json(res, 404, { error: `note ${id} not found` });
          res.writeHead(204);
          return res.end();
        }
      }
      json(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
  });
}

export function startDemoHttpServer(port = 0): Promise<{ server: Server; port: number }> {
  const server = createDemoHttpServer();
  return new Promise((resolve) => server.listen(port, () => resolve({ server, port: (server.address() as AddressInfo).port })));
}
