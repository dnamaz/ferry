import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoHttpServer } from '../examples/server/http-server.js';
import { evaluateHttpCaptures } from '../src/core/captures.js';
import { type Collection, type Folder, type HttpRequest, newHttpRequest } from '../src/core/model.js';
import { resolveHttpRequest } from '../src/core/resolve.js';
import { fetchErrorMessage, jsonBody, looksBinary, sendHttp } from '../src/http/client.js';
import { toCurl } from '../src/http/curl.js';

let server: Server;
let base: string;
beforeAll(async () => {
  const s = await startDemoHttpServer(0);
  server = s.server;
  base = `http://localhost:${s.port}`;
});
afterAll(() => server?.close());

const collection = (): Collection => ({
  id: 'c',
  name: 'C',
  variables: [{ key: 'base', value: base }],
  headers: [{ key: 'X-Collection', value: 'yes' }],
  items: [],
  importedFrom: join(import.meta.dirname, 'fixtures', 'files'),
});
const notesFolder: Folder = { type: 'folder', id: 'f', name: 'Notes', items: [], auth: { type: 'bearer', credentials: [{ key: 'token', value: '{{token}}' }] } };
const env = { id: 'e', name: 'Local', values: [{ key: 'token', value: 'demo-token' }] };

const send = (req: Partial<HttpRequest>, ancestors: Folder[] = []) =>
  sendHttp(resolveHttpRequest(newHttpRequest(req), { collection: collection(), ancestors, environment: env })).done;

describe('HTTP requests', () => {
  it('resolves variables, path variables and query params', () => {
    const r = resolveHttpRequest(
      newHttpRequest({
        url: '{{base}}/notes/:id',
        pathVariables: [{ key: 'id', value: 'a b/c' }],
        queryParams: [{ key: 'q', value: 'x y&z' }, { key: 'off', value: '1', disabled: true }, { key: 'flag', value: '' }],
      }),
      { collection: collection(), environment: env },
    );
    expect(r.url).toBe(`${base}/notes/a%20b%2Fc?q=x%20y%26z&flag`);
    expect(r.headers).toEqual([{ key: 'X-Collection', value: 'yes' }]);
  });

  it('sends GETs with inherited bearer auth and parses JSON', async () => {
    const denied = await send({ url: '{{base}}/notes' });
    expect(denied.status).toBe(401);
    const ok = await send({ url: '{{base}}/notes' }, [notesFolder]);
    expect(ok).toMatchObject({ state: 'done', status: 200, contentType: 'application/json' });
    expect((jsonBody(ok) as { items: unknown[] }).items).toHaveLength(2);
  });

  it('does CRUD with JSON bodies and path variables', async () => {
    const created = await send({ method: 'POST', url: '{{base}}/notes', body: { type: 'json', content: '{"text":"hi","tags":["t"]}' } }, [notesFolder]);
    expect(created.status).toBe(201);
    const id = (jsonBody(created) as { id: string }).id;
    const got = await send({ url: '{{base}}/notes/:id', pathVariables: [{ key: 'id', value: id }] }, [notesFolder]);
    expect(jsonBody(got)).toEqual({ id, text: 'hi', tags: ['t'] });
    const del = await send({ method: 'DELETE', url: '{{base}}/notes/:id', pathVariables: [{ key: 'id', value: id }] }, [notesFolder]);
    expect(del.status).toBe(204);
    expect((await send({ url: '{{base}}/notes/:id', pathVariables: [{ key: 'id', value: id }] }, [notesFolder])).status).toBe(404);
  });

  it('encodes urlencoded and multipart bodies, and api keys in the query', async () => {
    const form = jsonBody(
      await send({
        method: 'POST',
        url: '{{base}}/echo',
        auth: { type: 'apikey', credentials: [{ key: 'key', value: 'api_key' }, { key: 'value', value: 'k1' }, { key: 'in', value: 'query' }] },
        body: { type: 'urlencoded', fields: [{ key: 'name', value: 'Ada Lovelace' }, { key: 'skip', value: 'x', disabled: true }] },
      }),
    ) as { query: Record<string, string>; body: string; headers: Record<string, string> };
    expect(form.query).toEqual({ api_key: 'k1' });
    expect(form.body).toBe('name=Ada+Lovelace');
    expect(form.headers['content-type']).toBe('application/x-www-form-urlencoded');

    const multi = jsonBody(
      await send({ method: 'POST', url: '{{base}}/echo', body: { type: 'formdata', fields: [{ key: 'note', value: 'hi' }, { key: 'file', value: 'hello.txt', type: 'file' }] } }),
    ) as { body: string; headers: Record<string, string> };
    expect(multi.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(multi.body).toContain('name="file"; filename="hello.txt"');
    expect(multi.body).toContain('hello upload');
  });

  it('follows redirects unless told not to', async () => {
    expect(await send({ url: '{{base}}/redirect' })).toMatchObject({ status: 200 });
    expect(await send({ url: '{{base}}/redirect', settings: { followRedirects: false } })).toMatchObject({ status: 302 });
  });

  it('times out and can be cancelled', async () => {
    const slow = await send({ url: '{{base}}/slow?ms=2000', settings: { timeout: 100 } });
    expect(slow).toMatchObject({ state: 'error', error: 'Timed out after 100 ms' });
    const handle = sendHttp(resolveHttpRequest(newHttpRequest({ url: `${base}/slow?ms=2000` }), {}));
    setTimeout(() => handle.cancel(), 50);
    expect((await handle.done).state).toBe('cancelled');
  });

  it('streams server-sent events as they arrive', async () => {
    const seen: number[] = [];
    const final = await sendHttp(resolveHttpRequest(newHttpRequest({ url: `${base}/events` }), {}), (r) => seen.push(r.body.length)).done;
    expect(final.body.toString()).toBe(['1', '2', '3'].map((n) => `event: tick\ndata: {"n":${n}}\n\n`).join(''));
    expect(new Set(seen.filter((n) => n > 0 && n < final.body.length)).size).toBeGreaterThan(0);
  });

  it('keeps binary bodies intact', async () => {
    const pdf = await send({ url: '{{base}}/report.pdf' });
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    expect(looksBinary(pdf.body, pdf.contentType)).toBe(true);
  });

  it('captures values from JSON bodies', async () => {
    const token = await send({ method: 'POST', url: '{{base}}/oauth/token', body: { type: 'json', content: '{"client_id":"demo-client","client_secret":"demo-secret"}' } });
    expect(evaluateHttpCaptures([{ variable: 'token', path: 'access_token' }], jsonBody(token))).toMatchObject([{ variable: 'token', value: 'demo-token' }]);
  });

  it('reports connection errors', async () => {
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address() as AddressInfo;
    await new Promise((r) => probe.close(r));
    const r = await sendHttp(resolveHttpRequest(newHttpRequest({ url: `http://127.0.0.1:${port}/x` }), {})).done;
    expect(r.state).toBe('error');
    expect(r.error).toMatch(/^fetch failed: .*ECONNREFUSED/);
  });

  it('surfaces per-address errors when every address fails', () => {
    const aggregate = Object.assign(
      new AggregateError([new Error('connect ETIMEDOUT 10.0.0.1:80'), new Error('connect ENETUNREACH 10.0.0.2:80')], ''),
      { code: 'ETIMEDOUT' },
    );
    expect(fetchErrorMessage(new TypeError('fetch failed', { cause: aggregate }))).toBe(
      'fetch failed: connect ETIMEDOUT 10.0.0.1:80; connect ENETUNREACH 10.0.0.2:80',
    );
    expect(fetchErrorMessage(new TypeError('fetch failed', { cause: Object.assign(new Error(''), { code: 'ECONNRESET' }) }))).toBe(
      'fetch failed: ECONNRESET',
    );
    expect(fetchErrorMessage(new Error('Timed out after 100 ms'))).toBe('Timed out after 100 ms');
  });

  it('builds curl commands', () => {
    const r = resolveHttpRequest(
      newHttpRequest({
        method: 'POST',
        url: '{{base}}/notes',
        headers: [{ key: 'X-Id', value: "it's" }],
        body: { type: 'json', content: '{"a":1}' },
        settings: { strictSSL: false, timeout: 1500 },
      }),
      { collection: { ...collection(), variables: [{ key: 'base', value: 'https://api.example.com' }], headers: [] } },
    );
    expect(toCurl(r)).toBe(
      [
        'curl https://api.example.com/notes',
        '  -X POST',
        '  -L',
        '  -k',
        '  --max-time 1.5',
        `  -H 'X-Id: it'\\''s'`,
        `  -H 'Content-Type: application/json'`,
        `  --data-raw '{"a":1}'`,
      ].join(' \\\n'),
    );
  });
});
