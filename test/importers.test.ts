import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBru } from '../src/core/bruno.js';
import { importAny } from '../src/core/importers.js';
import { type Collection, type Folder, type GrpcRequest, type HttpRequest, type Item, walkItems } from '../src/core/model.js';
import { exportPostmanV2Collection } from '../src/core/postman-v2.js';
import { exportCollectionV3 } from '../src/core/postman-v3.js';

const FIX = join(import.meta.dirname, 'fixtures');
const EXAMPLES = join(import.meta.dirname, '..', 'examples');
const tmp: string[] = [];
const mktemp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ferry-imp-'));
  tmp.push(d);
  return d;
};
afterEach(() => tmp.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const byName = (c: Collection, name: string): Item => [...walkItems(c.items)].find((x) => x.item.name === name)!.item;
/** Collections compared without ids/source paths. */
const strip = (c: Collection) => JSON.parse(JSON.stringify(c, (k, v) => (k === 'id' || k === 'importedFrom' ? undefined : v)));

describe('Postman v2.1 JSON', () => {
  const res = importAny(join(FIX, 'v2'));
  const col = res.collections[0]!;

  it('imports folders, requests, variables and auth', () => {
    expect(res.formats).toEqual(['postman-v2']);
    expect(col.name).toBe('Shop');
    expect(col.auth).toEqual({ type: 'bearer', credentials: [{ key: 'token', value: '{{token}}' }] });
    expect(res.warnings).toContain('collection variable "base" is defined 2 times; the last one wins');
    expect((col.items[0] as Folder).name).toBe('Auth');
    expect(res.environments).toEqual([
      expect.objectContaining({ name: 'Local', values: [expect.objectContaining({ key: 'base' }), expect.objectContaining({ key: 'token', type: 'secret' })] }),
    ]);
  });

  it('splits URLs into base, query params (incl. disabled) and path variables', () => {
    const get = byName(col, 'Get order') as HttpRequest;
    expect(get).toMatchObject({
      type: 'http',
      method: 'GET',
      url: '{{base}}/orders/:orderId',
      queryParams: [{ key: 'expand', value: 'items' }, { key: 'page', value: '2' }, { key: 'debug', value: 'true', disabled: true }],
      pathVariables: [{ key: 'orderId', value: 'o-1', description: 'Order id' }],
      headers: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Debug', value: '1', disabled: true }],
    });
    expect(get.examples).toHaveLength(1);
  });

  it('maps bodies and turns token scripts into captures', () => {
    expect((byName(col, 'Upload') as HttpRequest).body).toEqual({
      type: 'formdata',
      fields: [{ key: 'note', value: 'hi' }, { key: 'file', value: './receipt.pdf', type: 'file' }],
    });
    expect((byName(col, 'Search') as HttpRequest).body).toEqual({ type: 'urlencoded', fields: [{ key: 'q', value: 'shoes' }] });
    const token = byName(col, 'Get token') as HttpRequest;
    expect(token.auth).toEqual({ type: 'noauth', credentials: [] });
    expect(token.body).toEqual({ type: 'json', content: '{"client_id": "{{clientId}}"}' });
    // The script has other logic, so it's kept and the capture is marked as derived.
    expect(token.captures).toEqual([{ variable: 'token', path: 'access_token', source: 'script' }]);
    expect(token.scripts).toHaveLength(1);
  });

  it('round-trips through v2.1 export', () => {
    const out = mktemp();
    const { file, skipped } = exportPostmanV2Collection(col, out);
    expect(skipped).toEqual([]);
    const again = importAny(file).collections[0]!;
    expect(strip(again)).toEqual({ ...strip(col), importedFrom: undefined });
  });
});

describe('Bruno .bru', () => {
  it('parses blocks, disabled entries and multi-line text', () => {
    const blocks = parseBru('meta {\n  name: x\n}\n\nbody:json {\n  {\n    "a": 1\n  }\n}\n\nparams:query {\n  a: 1\n  ~b: 2\n}\n');
    expect([...blocks.keys()]).toEqual(['meta', 'body:json', 'params:query']);
    expect(blocks.get('body:json')!.lines).toEqual(['{', '  "a": 1', '}']);
  });

  const res = importAny(join(FIX, 'bruno', 'Shop'));
  const col = res.collections[0]!;

  it('imports collection auth, headers, variables and folders', () => {
    expect(res.formats).toEqual(['bruno']);
    expect(col).toMatchObject({
      name: 'Shop',
      auth: { type: 'bearer', credentials: [{ key: 'token', value: '{{token}}' }] },
      headers: [{ key: 'X-Client', value: 'ferry-tests' }],
      variables: [{ key: 'base', value: 'http://localhost:4' }],
    });
    expect(col.items.map((i) => i.name)).toEqual(['login', 'Orders']);
    expect(col.items[1]).toMatchObject({ type: 'folder', headers: [{ key: 'X-Folder', value: 'orders' }] });
  });

  it('imports requests with params, path vars, bodies, auth and captures', () => {
    expect(byName(col, 'login')).toMatchObject({
      method: 'POST',
      auth: { type: 'noauth' },
      body: { type: 'json', content: '{\n  "client_id": "{{clientId}}"\n}' },
      captures: [{ variable: 'token', path: 'access_token' }],
    });
    const get = byName(col, 'order/{id}') as HttpRequest;
    expect(get).toMatchObject({
      url: '{{base}}/orders/:id',
      queryParams: [{ key: 'expand', value: 'items' }, { key: 'debug', value: 'true', disabled: true }],
      pathVariables: [{ key: 'id', value: 'o-1' }],
      description: 'Returns one order.',
    });
    expect(get.auth).toBeUndefined(); // inherit
    const search = byName(col, 'search') as HttpRequest;
    expect(search.auth).toEqual({ type: 'apikey', credentials: [{ key: 'key', value: 'api_key' }, { key: 'value', value: '{{apiKey}}' }, { key: 'in', value: 'query' }] });
    expect(search.body).toEqual({ type: 'urlencoded', fields: [{ key: 'q', value: 'shoes' }, { key: 'sort', value: 'price', disabled: true }] });
    expect(search.captures).toEqual([{ variable: 'firstId', path: 'items[0].id', source: 'script' }]);
  });

  it('imports environments, including secret names', () => {
    expect(res.environments).toEqual([
      expect.objectContaining({
        name: 'Local',
        values: [
          { key: 'base', value: 'http://localhost:5', enabled: true, type: 'default' },
          { key: 'clientId', value: 'demo-client', enabled: true, type: 'default' },
          { key: 'apiKey', value: '', enabled: true, type: 'secret' },
        ],
      }),
    ]);
  });
});

describe('Bruno OpenCollection YAML', () => {
  const res = importAny(join(FIX, 'oc'));
  const col = res.collections[0]!;

  it('imports HTTP and gRPC requests', () => {
    expect(res.formats).toEqual(['opencollection']);
    expect(col.headers).toEqual([{ key: 'X-Collection', value: 'oc' }]);
    const list = byName(col, 'List items') as HttpRequest;
    expect(list).toMatchObject({
      method: 'GET',
      url: '{{base}}/items/:kind',
      queryParams: [{ key: 'page', value: '1' }],
      pathVariables: [{ key: 'kind', value: 'shoes' }],
      settings: { followRedirects: false, timeout: 5000 },
      captures: [{ variable: 'itemId', path: 'items[0].id' }],
    });
    expect((col.items[0] as Folder).auth).toEqual({ type: 'bearer', credentials: [{ key: 'token', value: '{{token}}' }] });
    expect(byName(col, 'Create item')).toMatchObject({
      method: 'POST',
      body: { type: 'json', content: '{ "name": "hat" }' },
      auth: { type: 'basic', credentials: [{ key: 'username', value: 'admin' }, { key: 'password', value: '{{password}}' }] },
    });
    const ping = byName(col, 'Ping') as GrpcRequest;
    expect(ping).toMatchObject({ type: 'grpc', url: 'grpc://{{grpcHost}}', methodPath: '/demo.greeter.v1.Greeter/Chat', metadata: [{ key: 'x-trace', value: '1' }] });
    expect(JSON.parse(ping.message)).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(res.environments[0]!.values[1]).toMatchObject({ key: 'password', type: 'secret' });
  });
});

describe('Postman v3 http-request', () => {
  it('round-trips the example REST requests', () => {
    const [col] = importAny(EXAMPLES).collections;
    const notes = col!.items.find((i) => i.name === 'Notes (REST)') as Folder;
    expect(notes.items.map((i) => i.type)).toEqual(Array(notes.items.length).fill('http'));
    const token = notes.items.find((i) => i.name === 'Get token') as HttpRequest;
    // An exact capture script becomes a capture (and is written back as a script).
    expect(token.captures).toEqual([{ variable: 'token', path: 'access_token' }]);
    expect(token.scripts).toBeUndefined();
    const form = notes.items.find((i) => i.name === 'Echo form') as HttpRequest;
    expect(form).toMatchObject({ url: '{{httpBase}}/echo', queryParams: [{ key: 'source', value: 'demo' }], body: { type: 'urlencoded' } });

    const out = mktemp();
    const dir = exportCollectionV3(col!, out);
    expect(readFileSync(join(dir, 'Notes (REST)', 'Get token.request.yaml'), 'utf8')).toContain('pm.environment.set("token", pm.response.json().access_token);');
    const [again] = importAny(out).collections;
    expect(strip(again!)).toEqual(strip(col!));
  });
});

describe('mixed folders', () => {
  it('imports everything in a plain folder and labels same-named collections by format', () => {
    const res = importAny(join(FIX));
    expect(res.formats.sort()).toEqual(['bruno', 'opencollection', 'postman-v2']);
    expect(res.collections.map((c) => c.name).sort()).toEqual(['Mixed', 'Shop', 'Shop (Postman v2)']);
  });
});

describe('Bruno collection .proto files', () => {
  const write = (dir: string, file: string, content: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  };
  const expected = { type: 'proto', files: ['../protos/a.proto', '../protos/b.proto'], importPaths: ['../protos'] };

  it('reads opencollection.yml config.protobuf as the collection schema', () => {
    const dir = mktemp();
    write(dir, 'opencollection.yml', [
      'opencollection: 1.0.0',
      'info:',
      '  name: Protos',
      'config:',
      '  protobuf:',
      '    protoFiles:',
      "      - { type: file, path: '../protos/a.proto' }",
      "      - { type: file, path: '../protos/b.proto' }",
      '    importPaths:',
      "      - path: '../protos'",
      "      - { path: '../off', enabled: false }",
      '',
    ].join('\n'));
    const col = importAny(dir).collections[0]!;
    expect(col.schema).toEqual(expected);
    expect(col.importedFrom).toBe(dir);
  });

  it('reads bruno.json protobuf as the collection schema', () => {
    const dir = mktemp();
    write(dir, 'bruno.json', JSON.stringify({
      version: '1', name: 'Protos', type: 'collection',
      protobuf: {
        protoFiles: [{ path: '../protos/a.proto' }, { path: '../protos/b.proto' }],
        importPaths: [{ path: '../protos', enabled: true }, { path: '../off', enabled: false }],
      },
    }));
    expect(importAny(dir).collections[0]!.schema).toEqual(expected);
  });

  it('leaves the schema unset (reflection) when the collection lists no .proto files', () => {
    const dir = mktemp();
    write(dir, 'opencollection.yml', 'opencollection: 1.0.0\ninfo:\n  name: Plain\n');
    expect(importAny(dir).collections[0]!.schema).toBeUndefined();
  });
});
