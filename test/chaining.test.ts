import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capturesToScript, evaluateCaptures, scriptToCaptures } from '../src/core/captures.js';
import { formatPath, isPlaceholder, jsonLines, leaves, matchFields, normalizeKey, parsePath, setInJsonText, suggestVariableName } from '../src/core/jsonpath.js';
import type { GrpcRequest } from '../src/core/model.js';
import { exportCollectionV3, importV3 } from '../src/core/postman-v3.js';
import { Workspace } from '../src/core/workspace.js';

const tmp: string[] = [];
const mktemp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ferry-chain-'));
  tmp.push(d);
  return d;
};
afterEach(() => tmp.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('json paths', () => {
  it('formats and parses paths', () => {
    const p = [3, 'items', 1, 'weird-key', 'id'];
    expect(formatPath(p)).toBe('[3].items[1]["weird-key"].id');
    expect(parsePath('[3].items[1]["weird-key"].id')).toEqual(p);
    expect(parsePath("[0]['a b']")).toEqual([0, 'a b']);
    expect(parsePath('addressId')).toEqual(['addressId']);
    expect(parsePath('[0]..x')).toBeUndefined();
  });

  it('pretty-prints exactly like JSON.stringify and tags scalar lines with paths', () => {
    const msg = { addressId: 'a-1', tags: ['x', 'y'], nested: { n: 1, empty: {} }, list: [] };
    const lines = jsonLines(msg, [2]);
    expect(lines.map((l) => l.text).join('\n')).toBe(JSON.stringify(msg, null, 2));
    expect(lines.filter((l) => l.path).map((l) => [formatPath(l.path!), l.value])).toEqual([
      ['[2].addressId', 'a-1'],
      ['[2].tags[0]', 'x'],
      ['[2].tags[1]', 'y'],
      ['[2].nested.n', 1],
    ]);
  });

  it('writes values into request JSON and lists candidate fields', () => {
    const text = '{\n  "tenant_id": "{{tenantId}}",\n  "address_id": ""\n}';
    expect(JSON.parse(setInJsonText(text, ['address_id'], 'a-1'))).toEqual({ tenant_id: '{{tenantId}}', address_id: 'a-1' });
    expect(leaves(JSON.parse(text)).map((l) => formatPath(l.path))).toEqual(['tenant_id', 'address_id']);
    expect(normalizeKey('address_id')).toBe(normalizeKey('addressId'));
  });

  it('matches other request fields to response values by name', () => {
    const response = {
      tenantId: 't-1',
      company: { companyId: 'c-1', name: 'Acme', address: { id: 'a-1', zipCode: '10001' } },
      employee: { id: 'e-1', name: 'Ada' },
    };
    const source = leaves(response).map((l) => ({ path: [0, ...l.path], value: l.value }));
    const [tenant, company, zip, addressId, id, missing] = matchFields(
      source,
      [['tenant_id'], ['company_id'], ['address', 'zip_code'], ['address', 'id'], ['id'], ['pay_date']],
      [0, 'employee', 'id'],
    );
    expect(tenant).toEqual({ from: [0, 'tenantId'], value: 't-1', strong: true });
    expect(company?.from).toEqual([0, 'company', 'companyId']);
    expect(zip?.value).toBe('10001');
    // parents decide between same-named fields
    expect(addressId).toMatchObject({ value: 'a-1', strong: true });
    // a bare generic name takes the one nearest the picked value, but isn't ticked by default
    expect(id).toMatchObject({ value: 'e-1', strong: false });
    expect(missing).toBeUndefined();
  });

  it('tells template placeholders from real values', () => {
    for (const v of ['', 0, false, null, '0', 'ADDRESS_TYPE_UNSPECIFIED']) expect(isPlaceholder(v)).toBe(true);
    for (const v of ['x', 1, true, '{{tenantId}}']) expect(isPlaceholder(v)).toBe(false);
  });

  it('suggests variable names', () => {
    expect(suggestVariableName(['addressId'])).toBe('addressId');
    expect(suggestVariableName(['id'], 'ListAddresses')).toBe('addressId');
    expect(suggestVariableName(['company', 'id'])).toBe('companyId');
    expect(suggestVariableName(['source_company_id'])).toBe('sourceCompanyId');
    expect(suggestVariableName(['id'], 'ListCompanies')).toBe('companyId');
    expect(suggestVariableName(['id'], 'ListBatches')).toBe('batchId');
    expect(suggestVariableName(['id'], 'GetStatus')).toBe('statusId');
  });
});

describe('captures', () => {
  const messages = [{ addressId: 'a-1', n: 5 }, { addressId: 'a-2', nested: { ok: true } }];

  it('evaluates against response messages', () => {
    expect(
      evaluateCaptures(
        [
          { variable: 'first', path: '[0].addressId' },
          { variable: 'second', path: '[1].addressId' },
          { variable: 'num', path: '[0].n' },
          { variable: 'obj', path: '[1].nested' },
          { variable: 'missing', path: '[5].addressId' },
          { variable: 'nope', path: '[0].zzz' },
        ],
        messages,
      ).map((r) => [r.variable, r.value ?? r.error]),
    ).toEqual([
      ['first', 'a-1'],
      ['second', 'a-2'],
      ['num', '5'],
      ['obj', '{"ok":true}'],
      ['missing', 'no message #6 (got 2)'],
      ['nope', 'nothing at [0].zzz'],
    ]);
  });

  it('round-trips through Postman afterResponse scripts', () => {
    const captures = [
      { variable: 'addressId', path: '[0].addressId' },
      { variable: 'x', path: '[2].items[1]["weird-key"]' },
    ];
    const script = capturesToScript(captures);
    expect(script.code).toBe(
      'pm.environment.set("addressId", pm.response.messages.idx(0).data.addressId);\n' +
        'pm.environment.set("x", pm.response.messages.idx(2).data.items[1]["weird-key"]);',
    );
    expect(scriptToCaptures(script)).toEqual(captures);
    // scripts with anything else are left alone
    expect(scriptToCaptures({ type: 'afterResponse', code: `${script.code}\nconsole.log(1);` })).toBeUndefined();
    expect(scriptToCaptures({ type: 'beforeInvoke', code: script.code })).toBeUndefined();
  });

  it('imports capture scripts from v3 files and exports them back', () => {
    const root = mktemp();
    const dir = join(root, 'postman', 'collections', 'C');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'List.request.yaml'),
      [
        '$kind: grpc-request',
        "url: 'h:1'",
        'methodPath: pkg.Svc/List',
        'scripts:',
        '  - type: afterResponse',
        '    language: text/javascript',
        '    code: |-',
        '      pm.environment.set("addressId", pm.response.messages.idx(0).data.addressId);',
        '',
      ].join('\n'),
    );
    const [col] = importV3(root).collections;
    const req = col!.items[0] as GrpcRequest;
    expect(req.captures).toEqual([{ variable: 'addressId', path: '[0].addressId' }]);
    expect(req.scripts).toBeUndefined();

    const out = mktemp();
    const written = exportCollectionV3(col!, out);
    expect(readFileSync(join(written, 'List.request.yaml'), 'utf8')).toContain('pm.environment.set("addressId", pm.response.messages.idx(0).data.addressId);');
  });

  it('stores variables in the active environment, else the collection', () => {
    const ws = new Workspace(mktemp());
    const c = ws.createCollection('C');
    expect(ws.setVariable('a', '1', { collectionId: c.id })).toBe('collection "C"');
    expect(ws.collection(c.id)!.variables).toEqual([{ key: 'a', value: '1' }]);
    const env = ws.createEnvironment('Local');
    ws.setActiveEnvironment(env.id);
    expect(ws.setVariable('a', '2', { collectionId: c.id })).toBe('environment "Local"');
    expect(ws.setVariable('a', '3')).toBe('environment "Local"');
    expect(ws.activeEnvironment!.values).toEqual([{ key: 'a', value: '3', enabled: true, type: 'default' }]);
  });
});
