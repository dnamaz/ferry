import type { Server } from 'node:http';
import type * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoHttpServer } from '../examples/server/http-server.js';
import { startDemoServer } from '../examples/server/server.js';
import { newHttpRequest } from '../src/core/model.js';
import { resolveHttpRequest } from '../src/core/resolve.js';
import { type Timing, formatPhases, phasesFrom, serverTime } from '../src/core/timing.js';
import { discover } from '../src/grpc/discovery.js';
import { invoke } from '../src/grpc/invoke.js';
import { sendHttp } from '../src/http/client.js';
import { timingLines } from '../src/ui/components/ResponsePanel.js';

const names = (t?: Timing) => t?.phases.map((p) => p.name);
const sum = (t?: Timing) => t?.phases.reduce((s, p) => s + p.ms, 0) ?? 0;

describe('phasesFrom', () => {
  it('makes consecutive phases from end times, skipping ones that never happened', () => {
    expect(
      phasesFrom([
        ['prepare', 1],
        ['dns', 6],
        ['connect', 100],
        ['tls', undefined],
        ['http2', 190],
        ['wait', 280],
        ['receive', 281],
      ]),
    ).toEqual([
      { name: 'prepare', ms: 1 },
      { name: 'dns', ms: 5 },
      { name: 'connect', ms: 94 },
      { name: 'http2', ms: 90 },
      { name: 'wait', ms: 90 },
      { name: 'receive', ms: 1 },
    ]);
  });

  it('clamps an end earlier than the previous one to zero', () => {
    expect(phasesFrom([['prepare', 10], ['wait', 4], ['receive', 12]])).toEqual([
      { name: 'prepare', ms: 10 },
      { name: 'wait', ms: 0 },
      { name: 'receive', ms: 2 },
    ]);
  });
});

describe('formatPhases', () => {
  it('prints one line, hiding sub-millisecond phases but never the wait', () => {
    expect(formatPhases({ phases: phasesFrom([['prepare', 0.2], ['wait', 0.4], ['receive', 12.6]]), reused: true })).toBe('wait 0 · receive 12 ms (reused connection)');
  });
});

describe('serverTime', () => {
  it("reads Envoy's upstream service time", () => {
    expect(serverTime([['x-envoy-upstream-service-time', '12']])).toEqual({ serverMs: 12, serverSource: 'x-envoy-upstream-service-time' });
  });
  it('prefers the total entry of Server-Timing, else sums the durations', () => {
    expect(serverTime([['Server-Timing', 'db;dur=5, total;dur=20']]).serverMs).toBe(20);
    expect(serverTime([['server-timing', 'db;dur=5.5, app;desc="x";dur=4, cache;desc=hit']]).serverMs).toBe(9.5);
  });
  it('ignores missing or malformed values', () => {
    expect(serverTime([])).toEqual({});
    expect(serverTime([['x-envoy-upstream-service-time', 'soon']])).toEqual({});
  });
});

describe('gRPC call timing', () => {
  let server: grpc.Server;
  let url: string;
  beforeAll(async () => {
    const s = await startDemoServer(0);
    server = s.server;
    url = `localhost:${s.port}`;
  });
  afterAll(() => server?.forceShutdown());

  it('splits a call on a fresh plaintext connection, with no tls phase', async () => {
    const schema = await discover({ source: { type: 'reflection' }, url });
    const r = await invoke({ url, schema, method: schema.findMethod('/demo.greeter.v1.Greeter/SayHello')!, message: '{"name":"t"}' }).done;
    expect(r.state).toBe('done');
    expect(names(r.timing)).toEqual(['prepare', 'dns', 'connect', 'http2', 'wait', 'receive']);
    expect(r.timing!.phases.every((p) => p.ms >= 0)).toBe(true);
    expect(Math.abs(sum(r.timing) - r.durationMs!)).toBeLessThan(2);
    // {"name":"t"} is field 1, length 1, "t": 3 bytes on the wire.
    expect(r.requestBytes).toBe(3);
    expect(r.responseBytes).toBeGreaterThan(0);
    expect(timingLines(r).find((l) => l.text.startsWith('sent:'))?.text).toBe('sent:     3 B in 1 message');
  });
});

describe('HTTP request timing', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const s = await startDemoHttpServer(0);
    server = s.server;
    base = `http://localhost:${s.port}`;
  });
  afterAll(() => server?.close());

  const get = () => sendHttp(resolveHttpRequest(newHttpRequest({ url: `${base}/healthz`, method: 'GET' }), {})).done;

  // undici decides when to reuse a socket (one sent straight after a response can still get a new
  // one), so `reused` is checked against the connections the server actually accepted.
  it('times the handshake on a new connection and marks a reused one, agreeing with the server', async () => {
    let accepted = 0;
    const count = () => accepted++;
    server.on('connection', count);
    try {
      const seen: boolean[] = [];
      for (let i = 0; i < 4; i++) {
        const before = accepted;
        const r = await get();
        expect(r.status).toBe(200);
        const fresh = accepted > before;
        expect(r.timing?.reused).toBe(!fresh);
        expect(names(r.timing)).toEqual(fresh ? ['prepare', 'dns', 'connect', 'wait', 'receive'] : ['prepare', 'wait', 'receive']);
        expect(Math.abs(sum(r.timing) - r.durationMs!)).toBeLessThan(2);
        seen.push(fresh);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(seen[0]).toBe(true);
      expect(seen).toContain(false);
    } finally {
      server.off('connection', count);
    }
  });

  it('counts the request body bytes it sent', async () => {
    const body = JSON.stringify({ title: 'héllo' }); // é is 2 bytes in UTF-8
    const r = await sendHttp(
      resolveHttpRequest(newHttpRequest({ url: `${base}/notes`, method: 'POST', body: { type: 'json', content: body } }), {}),
    ).done;
    expect(r.requestBytes).toBe(Buffer.byteLength(body));
    expect(names(r.timing)).toContain('send');
    const get = await sendHttp(resolveHttpRequest(newHttpRequest({ url: `${base}/healthz`, method: 'GET' }), {})).done;
    expect(get.requestBytes).toBe(0);
  });

  it('has no timing when the request never went out', async () => {
    const r = await sendHttp(resolveHttpRequest(newHttpRequest({ url: 'http://127.0.0.1:1/', method: 'GET' }), {})).done;
    expect(r.state).toBe('error');
    expect(r.timing).toBeUndefined();
    expect(timingLines(r)[0]!.text).toContain('never went out');
  });
});

describe('timing tab', () => {
  it('shows each phase and the network share of the wait', () => {
    const timing: Timing = { phases: phasesFrom([['dns', 5], ['connect', 100], ['wait', 190], ['receive', 191]]), serverMs: 0, serverSource: 'x-envoy-upstream-service-time' };
    const text = timingLines({ state: 'done', headers: [], trailers: [], messages: [], sent: 1, startedAt: 0, timing }, 80).map((l) => l.text);
    expect(text[0]).toBe('// 191 ms total · new connection');
    expect(text.find((l) => l.startsWith('connect:'))).toMatch(/95 ms\s+TCP handshake\s+█+/);
    expect(text.at(-1)).toBe('// so about 90 ms of the 90 ms wait is network and proxies');
  });
});
