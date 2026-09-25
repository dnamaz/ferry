import { readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoHttpServer } from '../examples/server/http-server.js';
import { startDemoServer } from '../examples/server/server.js';
import { type Collection, type Folder, newGrpcRequest, newHttpRequest } from '../src/core/model.js';
import { previewGrpc, previewHttp } from '../src/core/preview.js';
import { resolveHttpRequest, resolveRequest } from '../src/core/resolve.js';
import { certificateFor, matchHost, mergeTls } from '../src/core/tls.js';
import { discover } from '../src/grpc/discovery.js';
import { invoke } from '../src/grpc/invoke.js';
import { effectiveHttpHeaders, jsonBody, sendHttp } from '../src/http/client.js';
import { cachedToken, clearTokens, getToken, withToken } from '../src/http/oauth.js';
import { type TestPki, makeTestPki } from './tls-helpers.js';

let pki: TestPki;
let https: HttpsServer;
let httpsBase: string;
let grpcServer: grpc.Server;
let grpcPort: number;
let demo: HttpServer;
let demoBase: string;
let home: string;

beforeAll(async () => {
  pki = makeTestPki();
  home = mkdtempSync(join(tmpdir(), 'ferry-home-'));
  // HTTPS server that requires a client certificate signed by the test CA.
  https = createHttpsServer(
    { key: readFileSync(pki.serverKey), cert: readFileSync(pki.serverCert), ca: readFileSync(pki.ca), requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const peer = (req.socket as TLSSocket).getPeerCertificate();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ client: peer.subject?.CN, auth: req.headers.authorization ?? null, team: req.headers['x-team'] ?? null }));
    },
  );
  await new Promise<void>((r) => https.listen(0, r));
  httpsBase = `https://localhost:${(https.address() as AddressInfo).port}`;
  // gRPC over mTLS with a certificate that is only valid for demo.internal.
  const creds = grpc.ServerCredentials.createSsl(readFileSync(pki.ca), [{ private_key: readFileSync(pki.internalKey), cert_chain: readFileSync(pki.internalCert) }], true);
  const g = await startDemoServer(0, creds);
  grpcServer = g.server;
  grpcPort = g.port;
  const d = await startDemoHttpServer(0);
  demo = d.server;
  demoBase = `http://localhost:${d.port}`;
});
afterAll(() => {
  https?.close();
  grpcServer?.forceShutdown();
  demo?.close();
  rmSync(pki.dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('certificate rules', () => {
  it('matches hosts by specificity', () => {
    expect(matchHost('api.example.com', 'api.example.com')).toBe(3);
    expect(matchHost('api.example.com:8443', 'api.example.com', '8443')).toBe(4);
    expect(matchHost('api.example.com:8443', 'api.example.com', '443')).toBe(-1);
    expect(matchHost('*.example.com', 'a.b.example.com')).toBe(1);
    expect(matchHost('*.example.com', 'example.com')).toBe(-1);
    const rules = [
      { id: '1', host: '*.example.com', caCert: 'wild.pem' },
      { id: '2', host: 'api.example.com', caCert: 'exact.pem' },
      { id: '3', host: 'api.example.com:9', caCert: 'off.pem', disabled: true },
    ];
    expect(certificateFor(rules, 'api.example.com', '9')?.caCert).toBe('exact.pem');
    expect(certificateFor(rules, 'x.example.com')?.caCert).toBe('wild.pem');
  });

  it('merges host rule < collection < request, replacing client material as a unit', () => {
    expect(mergeTls({ caCert: 'a', pfx: 'x.p12', passphrase: 'p' }, { clientCert: 'c.pem', clientKey: 'c.key' }, undefined)).toEqual({ caCert: 'a', clientCert: 'c.pem', clientKey: 'c.key' });
  });
});

describe('HTTP mTLS', () => {
  const send = (tls: object, extra: Parameters<typeof resolveHttpRequest>[1] = {}) =>
    sendHttp(resolveHttpRequest(newHttpRequest({ url: `${httpsBase}/`, tls }), extra)).done;

  it('explains an untrusted server certificate', async () => {
    const r = await send({});
    expect(r.state).toBe('error');
    expect(r.error).toMatch(/isn't trusted/);
  });

  it('fails without a client certificate', async () => {
    const r = await send({ caCert: pki.ca });
    expect(r.state).toBe('error');
  });

  it('succeeds with PEM client cert + key and a custom CA', async () => {
    const r = await send({ caCert: pki.ca, clientCert: pki.clientCert, clientKey: pki.clientKey });
    expect(r.status).toBe(200);
    expect(jsonBody(r)).toMatchObject({ client: 'ferry-test-client' });
  });

  it('succeeds with a PKCS#12 bundle and passphrase from a variable', async () => {
    const collection: Collection = { id: 'c', name: 'C', variables: [{ key: 'p12pass', value: 'p12-pass' }], items: [] };
    const r = await send({ caCert: pki.ca, pfx: pki.clientP12, passphrase: '{{p12pass}}' }, { collection });
    expect(r.status).toBe(200);
  });

  it('applies per-host certificate rules', async () => {
    const certificates = [{ id: 'x', host: 'localhost', caCert: pki.ca, clientCert: pki.clientCert, clientKey: pki.clientKey }];
    const r = await send({}, { certificates });
    expect(r.status).toBe(200);
  });
});

describe('gRPC mTLS and server name override', () => {
  const settings = { secureConnection: true };
  const tls = () => ({ caCert: pki.ca, clientCert: pki.clientCert, clientKey: pki.clientKey });

  it('rejects the certificate when the name does not match', async () => {
    await expect(discover({ source: { type: 'reflection' }, url: `localhost:${grpcPort}`, settings, tls: tls() }, true)).rejects.toThrow(/different name|altnames|does not match|UNAVAILABLE/);
  });

  it('works with serverName set to the certificate name', async () => {
    const s = { ...settings, serverName: 'demo.internal' };
    const schema = await discover({ source: { type: 'reflection' }, url: `localhost:${grpcPort}`, settings: s, tls: tls() }, true);
    const r = await invoke({ url: `localhost:${grpcPort}`, settings: s, tls: tls(), schema, method: schema.findMethod('/demo.greeter.v1.Greeter/SayHello')!, message: '{"name":"tls"}' }).done;
    expect(r.messages).toEqual([expect.objectContaining({ message: 'Hello, tls!' })]);
  });

  it('works with a PKCS#12 client bundle', async () => {
    const s = { ...settings, serverName: 'demo.internal' };
    const p12 = { caCert: pki.ca, pfx: pki.clientP12, passphrase: 'p12-pass' };
    const schema = await discover({ source: { type: 'reflection' }, url: `localhost:${grpcPort}`, settings: s, tls: p12 }, true);
    expect(schema.services.length).toBeGreaterThan(0);
  });
});

describe('OAuth2 client credentials', () => {
  const auth = (extra: Record<string, string> = {}) => ({
    type: 'oauth2',
    credentials: Object.entries({
      grant_type: 'client_credentials',
      accessTokenUrl: `${demoBase}/oauth/token`,
      clientId: '{{clientId}}',
      clientSecret: 'demo-secret',
      scope: 'notes:read',
      ...extra,
    }).map(([key, value]) => ({ key, value })),
  });
  const env = { id: 'e', name: 'E', values: [{ key: 'clientId', value: 'demo-client' }] };

  it('resolves the config, fetches, caches and sends the token', async () => {
    clearTokens(home);
    const r = resolveHttpRequest(newHttpRequest({ url: `${demoBase}/notes`, auth: auth() }), { environment: env });
    expect(r.oauth).toMatchObject({ clientId: 'demo-client', clientAuth: 'body', headerPrefix: 'Bearer', scope: 'notes:read' });
    expect(r.headers.find((h) => /authorization/i.test(h.key))).toBeUndefined(); // added at send time
    const first = await getToken(r.oauth!, home);
    const second = await getToken(r.oauth!, home);
    expect([first.fromCache, second.fromCache]).toEqual([false, true]);
    const stats = jsonBody(await sendHttp(resolveHttpRequest(newHttpRequest({ url: `${demoBase}/oauth/stats` }), {})).done) as { tokenRequests: number };
    expect(stats.tokenRequests).toBe(1);
    const res = await sendHttp(r, undefined, { oauthToken: first.accessToken }).done;
    expect(res.status).toBe(200);
  });

  it('sends client credentials as Basic when asked, and refetches expired tokens', async () => {
    const r = resolveHttpRequest(newHttpRequest({ url: `${demoBase}/x`, auth: auth({ client_authentication: 'header', accessTokenUrl: `${demoBase}/oauth/token?expires_in=1` }) }), { environment: env });
    const t = await getToken(r.oauth!, home);
    expect(t.accessToken).toBe('demo-token');
    // 1 s lifetime is inside the refresh window, so it is never reused
    expect(cachedToken(r.oauth!, home)).toBeUndefined();
  });

  it('reports token endpoint errors', async () => {
    const r = resolveHttpRequest(newHttpRequest({ url: `${demoBase}/x`, auth: auth({ clientSecret: 'wrong' }) }), { environment: env });
    await expect(getToken(r.oauth!, home, { force: true })).rejects.toThrow(/401 Unauthorized — unknown client or bad secret/);
  });

  it('authorizes gRPC calls too', async () => {
    const insecure = await startDemoServer(0);
    try {
      const url = `localhost:${insecure.port}`;
      const req = newGrpcRequest({ url, methodPath: '/demo.inventory.v1.Inventory/GetItem', message: '{"sku":"SKU-001"}', auth: auth() });
      const r = resolveRequest(req, { environment: env });
      const token = (await getToken(r.oauth!, home)).accessToken;
      const schema = await discover({ source: { type: 'reflection' }, url });
      const res = await invoke({ url, schema, method: schema.findMethod(r.methodPath)!, message: r.message, metadata: withToken(r.metadata, r.oauth!, token, true) }).done;
      expect(res.state).toBe('done');
    } finally {
      insecure.server.forceShutdown();
    }
  });
});

describe('headers and bearer auth', () => {
  const folder: Folder = { type: 'folder', id: 'f', name: 'Reporting', items: [], headers: [{ key: 'X-Team', value: 'tax' }, { key: 'X-Trace', value: 'folder' }] };
  const collection: Collection = { id: 'c', name: 'STF', variables: [{ key: 't', value: '' }], headers: [{ key: 'X-Trace', value: 'collection' }, { key: 'X-Env', value: 'local' }], items: [folder] };

  it('sends collection/folder headers as gRPC metadata, nearest wins', () => {
    const r = resolveRequest(newGrpcRequest({ url: 'h:1', metadata: [{ key: 'X-Team', value: 'request' }] }), { collection, ancestors: [folder] });
    expect(r.metadata).toEqual([
      { key: 'x-env', value: 'local' },
      { key: 'x-trace', value: 'folder' },
      { key: 'x-team', value: 'request' },
    ]);
    expect(r.metadataSources.map((m) => `${m.key}:${m.source}`)).toEqual(['x-env:collection', 'x-trace:folder', 'x-team:request']);
  });

  it('strips a duplicate Bearer prefix and skips empty tokens with a warning', () => {
    const withPrefix = resolveHttpRequest(newHttpRequest({ url: 'h', auth: { type: 'bearer', credentials: [{ key: 'token', value: 'Bearer abc' }] } }), {});
    expect(withPrefix.headers).toEqual([{ key: 'authorization', value: 'Bearer abc' }]);
    const empty = resolveHttpRequest(newHttpRequest({ url: 'h', auth: { type: 'bearer', credentials: [{ key: 'token', value: '{{t}}' }] } }), { collection });
    expect(empty.headers.find((h) => h.key === 'authorization')).toBeUndefined();
    expect(empty.warnings[0]).toMatch(/Bearer token is empty/);
  });

  it('previews final headers with sources and masked secrets', () => {
    const req = newHttpRequest({ method: 'POST', url: 'https://api.example.com/x', body: { type: 'json', content: '{}' }, auth: undefined });
    const f2: Folder = { ...folder, auth: { type: 'bearer', credentials: [{ key: 'token', value: 'secret-token-value-123' }] } };
    const r = resolveHttpRequest(req, { collection, ancestors: [f2] });
    const text = previewHttp(r, { request: req, ancestors: [f2], collection });
    expect(text).toContain('POST https://api.example.com/x');
    expect(text).toMatch(/authorization\s+Bearer secret…\(22 chars\)\s+auth: bearer \(inherited from folder Reporting\)/);
    expect(text).toMatch(/X-Team\s+tax\s+folder Reporting/);
    expect(text).toMatch(/Content-Type\s+application\/json\s+default \(json body\)/);
    expect(previewHttp(r, { request: req, ancestors: [f2], collection, reveal: true })).toContain('Bearer secret-token-value-123');
    expect(effectiveHttpHeaders(r).map((h) => h.key)).toEqual(['authorization', 'X-Env', 'X-Team', 'X-Trace', 'Content-Type', 'User-Agent', 'Accept']);

    const g = resolveRequest(newGrpcRequest({ url: 'grpcs://svc:443', methodPath: 'pkg.S/M', settings: { serverName: 'svc.internal' } }), { collection });
    const gtext = previewGrpc(g, { request: newGrpcRequest(), ancestors: [], collection, target: { address: 'svc:443', tls: true } });
    expect(gtext).toMatch(/:authority\s+svc\.internal/);
    expect(gtext).toMatch(/x-env\s+local\s+collection/);
  });
});
