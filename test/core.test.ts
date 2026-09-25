import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newGrpcRequest, type Collection, type Folder } from '../src/core/model.js';
import { exportCollectionV3, importV3, toV3Yaml } from '../src/core/postman-v3.js';
import { resolveRequest } from '../src/core/resolve.js';
import { createResolver } from '../src/core/vars.js';
import { Workspace, migrateLegacyHome } from '../src/core/workspace.js';
import { parseTarget } from '../src/grpc/connection.js';
import { normalizeMethodPath } from '../src/grpc/schema.js';

const EXAMPLES = join(import.meta.dirname, '..', 'examples');
const tmp: string[] = [];
const mktemp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ferry-test-'));
  tmp.push(d);
  return d;
};
afterEach(() => tmp.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('variables', () => {
  it('resolves with later scopes winning, and reports missing names', () => {
    const r = createResolver([
      { name: 'collection', values: [{ key: 'host', value: 'a:1' }, { key: 'user', value: 'ada' }] },
      { name: 'env', values: [{ key: 'host', value: 'b:2' }, { key: 'off', value: 'x', enabled: false }] },
    ]);
    expect(r.resolve('{{host}}/{{ user }}/{{off}}/{{nope}}')).toBe('b:2/ada/{{off}}/{{nope}}');
    expect([...r.missing].sort()).toEqual(['nope', 'off']);
  });

  it('supports nested references and dynamic variables', () => {
    const r = createResolver([{ name: 'c', values: [{ key: 'base', value: 'h' }, { key: 'url', value: '{{base}}:9' }] }]);
    expect(r.resolve('{{url}}')).toBe('h:9');
    expect(r.resolve('{{$guid}}')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('request resolution', () => {
  it('inherits auth from the nearest folder and respects noauth overrides', () => {
    const folder: Folder = { type: 'folder', id: 'f', name: 'F', items: [], auth: { type: 'bearer', credentials: [{ key: 'token', value: '{{token}}' }] } };
    const col: Collection = { id: 'c', name: 'C', variables: [{ key: 'token', value: 't0' }], items: [folder] };
    const inherited = resolveRequest(newGrpcRequest({ url: 'h:1' }), { collection: col, ancestors: [folder] });
    expect(inherited.metadata).toEqual([{ key: 'authorization', value: 'Bearer t0' }]);

    const none = resolveRequest(newGrpcRequest({ auth: { type: 'noauth' } }), { collection: col, ancestors: [folder] });
    expect(none.metadata).toEqual([]);

    // explicit metadata beats auth-generated metadata
    const explicit = resolveRequest(newGrpcRequest({ metadata: [{ key: 'Authorization', value: 'custom' }] }), { collection: col, ancestors: [folder] });
    // gRPC metadata keys are lowercase on the wire
    expect(explicit.metadata).toEqual([{ key: 'authorization', value: 'custom' }]);
  });
});

describe('targets', () => {
  it('parses Postman-style URLs', () => {
    expect(parseTarget('localhost:50051')).toEqual({ address: 'localhost:50051', tls: false });
    expect(parseTarget('grpcs://api.example.com')).toEqual({ address: 'api.example.com:443', tls: true });
    expect(parseTarget('grpc://h:1', { secureConnection: true })).toEqual({ address: 'h:1', tls: true });
    expect(() => parseTarget('')).toThrow();
  });

  it('normalizes method paths', () => {
    expect(normalizeMethodPath('pkg.Svc/M')).toBe('/pkg.Svc/M');
    expect(normalizeMethodPath('pkg.Svc.M')).toBe('/pkg.Svc/M');
    expect(normalizeMethodPath('/pkg.Svc/M')).toBe('/pkg.Svc/M');
  });
});

describe('Postman v3', () => {
  it('imports the example workspace', () => {
    const res = importV3(EXAMPLES);
    expect(res.warnings).toEqual([]);
    expect(res.collections.map((c) => c.name)).toEqual(['Demo API']);
    expect(res.environments.map((e) => e.name)).toEqual(['Local']);

    const col = res.collections[0]!;
    expect(col.variables.find((v) => v.key === 'host')?.value).toBe('localhost:50051');
    expect(col.items.map((i) => i.name)).toEqual(['Greeter', 'Inventory', 'Notes (REST)']);
    const greeter = col.items[0] as Folder;
    expect(greeter.items.map((i) => i.name)).toEqual(['Say hello', 'Stream greetings', 'Collect names', 'Chat']);
    const hello = greeter.items[0]!;
    expect(hello.type).toBe('grpc');
    if (hello.type !== 'grpc') return;
    expect(hello.methodPath).toBe('demo.greeter.v1.Greeter/SayHello');
    expect(JSON.parse(hello.message)).toEqual({ name: '{{user}}', language: 'LANGUAGE_FRENCH' });
    expect(hello.metadata).toEqual([{ key: 'x-request-id', value: '{{$guid}}' }]);

    const inventory = col.items[1] as Folder;
    expect(inventory.auth?.type).toBe('bearer');
    const rest = col.items[2] as Folder;
    expect(rest.items[0]).toMatchObject({ type: 'http', method: 'GET', url: '{{httpBase}}/healthz' });
  });

  it('round-trips through export without losing data', () => {
    const [col] = importV3(EXAMPLES).collections;
    const out = mktemp();
    const dir = exportCollectionV3(col!, out);
    expect(readFileSync(join(dir, 'Greeter', 'Say hello.request.yaml'), 'utf8')).toContain("url: '{{host}}'");
    const [again] = importV3(out).collections;
    const strip = (c: Collection) => JSON.parse(JSON.stringify(c, (k, v) => (k === 'id' || k === 'importedFrom' ? undefined : v)));
    expect(strip(again!)).toEqual(strip(col!));
  });

  it('blanks secret environment values on export unless asked', () => {
    const ws = new Workspace(mktemp());
    ws.importV3(EXAMPLES);
    const out = mktemp();
    ws.exportV3(ws.collections[0]!.id, out, { withEnvironments: true });
    const envFile = join(out, 'postman', 'environments', 'Local.environment.yaml');
    expect(readFileSync(envFile, 'utf8')).toContain("key: token\n    value: ''");
    ws.exportV3(ws.collections[0]!.id, out, { withEnvironments: true, includeSecrets: true });
    expect(readFileSync(envFile, 'utf8')).toContain('value: demo-token');
  });

  it('quotes values per the v3 YAML rules', () => {
    const yaml = toV3Yaml({ url: '{{host}}/x', name: 'Health check: v2', n: '123', order: 1000, body: 'a\nb' });
    expect(yaml).toContain("url: '{{host}}/x'");
    expect(yaml).toContain("name: 'Health check: v2'");
    expect(yaml).toContain("n: '123'");
    expect(yaml).toContain('order: 1000');
    expect(yaml).toContain('body: |-');
  });
});

describe('workspace', () => {
  it('moves data from the old ~/.grpc-client folder to ~/.ferry once', () => {
    const home = mktemp();
    const saved = { HOME: process.env.HOME, FERRY_HOME: process.env.FERRY_HOME, GRPC_CLIENT_HOME: process.env.GRPC_CLIENT_HOME };
    try {
      process.env.HOME = home;
      delete process.env.FERRY_HOME;
      delete process.env.GRPC_CLIENT_HOME;
      mkdirSync(join(home, '.grpc-client', 'collections'), { recursive: true });
      writeFileSync(join(home, '.grpc-client', 'state.json'), '{}');
      expect(migrateLegacyHome()).toBe(join(home, '.grpc-client'));
      expect(existsSync(join(home, '.ferry', 'state.json'))).toBe(true);
      expect(existsSync(join(home, '.grpc-client'))).toBe(false);
      expect(migrateLegacyHome()).toBeUndefined(); // only once
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('persists collections and re-imports in place by name', () => {
    const home = mktemp();
    const ws = new Workspace(home);
    ws.importV3(EXAMPLES);
    const id = ws.collections[0]!.id;
    const again = ws.importV3(EXAMPLES);
    expect(again.replaced).toContain('Demo API');
    expect(ws.collections).toHaveLength(1);
    expect(ws.collections[0]!.id).toBe(id);

    const reloaded = new Workspace(home);
    expect(reloaded.findByPath('demo api/greeter/say hello')?.item?.name).toBe('Say hello');
  });

  it('activates the imported environment that defines the collection variables', () => {
    const ws = new Workspace(mktemp());
    const other = ws.createEnvironment('Other');
    ws.setActiveEnvironment(other.id);
    const res = ws.importV3(EXAMPLES);
    // Demo API defines {{host}} itself; {{token}} (folder auth) comes from the Local environment.
    expect(res.activatedEnvironment).toBe('Local');
    expect(ws.activeEnvironment?.name).toBe('Local');
    // re-importing keeps the (already covering) active environment
    expect(ws.importV3(EXAMPLES).activatedEnvironment).toBeUndefined();
  });

  it('reorders and duplicates items with spaced order values', () => {
    const ws = new Workspace(mktemp());
    const c = ws.createCollection('C');
    const a = newGrpcRequest({ name: 'a' });
    const b = newGrpcRequest({ name: 'b' });
    ws.addItem(c.id, c.id, a);
    ws.addItem(c.id, c.id, b);
    ws.moveItem(b.id, -1);
    expect(ws.collection(c.id)!.items.map((i) => [i.name, i.order])).toEqual([['b', 1000], ['a', 2000]]);
    ws.duplicateItem(b.id);
    expect(ws.collection(c.id)!.items.map((i) => i.name)).toEqual(['b', 'b copy', 'a']);
  });
});
