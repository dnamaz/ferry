import { join } from 'node:path';
import type * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoServer } from '../examples/server/server.js';
import { discover } from '../src/grpc/discovery.js';
import { invoke } from '../src/grpc/invoke.js';
import { describeMethod, methodTemplate, type Schema } from '../src/grpc/schema.js';

const PROTOS = join(import.meta.dirname, '..', 'examples', 'protos');
let server: grpc.Server;
let url: string;

beforeAll(async () => {
  const started = await startDemoServer(0);
  server = started.server;
  url = `localhost:${started.port}`;
});
afterAll(() => server?.forceShutdown());

const sources = {
  reflection: () => discover({ source: { type: 'reflection' }, url }),
  'proto files': () =>
    discover({ source: { type: 'proto', files: [join(PROTOS, 'greeter.proto'), join(PROTOS, 'inventory.proto')], importPaths: [] }, url }),
};

describe.each(Object.entries(sources))('via %s', (_, load) => {
  let schema: Schema;
  beforeAll(async () => {
    schema = await load();
  });

  const call = (path: string, message: string, metadata: Array<{ key: string; value: string }> = []) =>
    invoke({ url, schema, method: schema.findMethod(path)!, message, metadata }).done;

  it('discovers services and method kinds', () => {
    expect(schema.services.map((s) => s.name)).toEqual(['demo.greeter.v1.Greeter', 'demo.inventory.v1.Inventory']);
    expect(schema.services[0]!.methods.map((m) => m.kind)).toEqual(['unary', 'server_streaming', 'client_streaming', 'bidi_streaming']);
  });

  it('calls unary methods with enums and well-known types', async () => {
    const r = await call('/demo.greeter.v1.Greeter/SayHello', '{"name":"Ada","language":"LANGUAGE_FRENCH"}');
    expect(r.state).toBe('done');
    expect(r.messages).toEqual([{ message: 'Bonjour, Ada!', sentAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }]);
    expect(r.trailers).toContainEqual(['x-served-by', 'demo-server']);
  });

  it('streams server messages', async () => {
    const r = await call('/demo.greeter.v1.Greeter/StreamGreetings', '{"name":"B","times":2}');
    expect(r.messages).toHaveLength(2);
  });

  it('sends JSON arrays on client and bidi streams', async () => {
    const c = await call('demo.greeter.v1.Greeter/CollectNames', '[{"name":"a"},{"name":"b"}]');
    expect(c.messages[0]).toMatchObject({ message: 'Hello, a & b!' });
    const b = await call('demo.greeter.v1.Greeter/Chat', '[{"name":"x"},{"name":"y","language":2}]');
    expect(b.messages.map((m) => (m as { message: string }).message)).toEqual(['Hello, x!', 'Hola, y!']);
  });

  it('reports gRPC status errors and metadata-based auth', async () => {
    const denied = await call('/demo.inventory.v1.Inventory/GetItem', '{"sku":"SKU-001"}');
    expect(denied).toMatchObject({ state: 'error', codeName: 'UNAUTHENTICATED' });
    const ok = await call('/demo.inventory.v1.Inventory/UpdateItem', '{"item":{"sku":"SKU-001","quantity":"3"},"updateMask":"quantity"}', [
      { key: 'authorization', value: 'Bearer demo-token' },
    ]);
    expect(ok.messages[0]).toMatchObject({ sku: 'SKU-001', quantity: '3', attributes: { switch: 'brown' }, warehouse: 'WH-EAST-1' });
  });

  it('rejects unknown fields and invalid JSON before sending', async () => {
    expect((await call('/demo.greeter.v1.Greeter/SayHello', '{"nmae":"x"}')).error).toMatch(/nmae/);
    expect((await call('/demo.greeter.v1.Greeter/SayHello', '{')).error).toMatch(/not valid JSON/);
  });

  it('generates templates and descriptions', () => {
    const m = schema.findMethod('/demo.inventory.v1.Inventory/UpdateItem')!;
    const t = JSON.parse(methodTemplate(m));
    expect(Object.keys(t.item)).toEqual(expect.arrayContaining(['sku', 'price', 'attributes', 'status', 'warehouse', 'updatedAt']));
    expect(t.item).not.toHaveProperty('storeAddress'); // only first oneof member
    expect(describeMethod(m)).toContain('map<string, string> attributes = 6;');
    expect(JSON.parse(methodTemplate(schema.findMethod('/demo.greeter.v1.Greeter/Chat')!))).toBeInstanceOf(Array);
  });
});

describe('failures', () => {
  it('surfaces connection errors from reflection', async () => {
    await expect(discover({ source: { type: 'reflection' }, url: 'localhost:1' })).rejects.toThrow(/UNAVAILABLE/);
  });
});
