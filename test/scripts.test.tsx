import React from 'react';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startDemoHttpServer } from '../examples/server/http-server.js';
import { type Collection, type Environment, type Script, newGrpcRequest, newHttpRequest } from '../src/core/model.js';
import { resolveHttpRequest, resolveRequest } from '../src/core/resolve.js';
import {
  type ScriptResponseInfo,
  type ScriptVars,
  checkScript,
  dryRunVars,
  httpRequestInfo,
  httpResponseInfo,
  runPhase,
  runScripts,
  scriptsFor,
  summarizeOutcome,
  withLocals,
} from '../src/core/scripts.js';
import { Workspace } from '../src/core/workspace.js';
import { sendHttp } from '../src/http/client.js';
import { varAt, varColor } from '../src/ui/components/JsonLine.js';
import { KVEditorModal, type KVRow } from '../src/ui/components/Modals.js';
import { TextEditor } from '../src/ui/components/TextEditor.js';
import { theme } from '../src/ui/theme.js';

const tmp: string[] = [];
afterEach(() => tmp.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const mkhome = () => {
  const d = mkdtempSync(join(tmpdir(), 'ferry-scripts-'));
  tmp.push(d);
  return d;
};

/** In-memory variables: env + collection maps. */
function memoryVars(env: Record<string, string> = {}, coll: Record<string, string> = {}): ScriptVars & { env: Record<string, string>; coll: Record<string, string> } {
  return {
    env,
    coll,
    environmentName: 'Test',
    get: (scope, name) => (scope === 'environment' ? env[name] : scope === 'collection' ? coll[name] : (env[name] ?? coll[name])),
    set: (scope, name, value) => {
      (scope === 'environment' ? env : coll)[name] = value;
      return `${scope} "Test"`;
    },
    unset: (scope, name) => {
      delete (scope === 'environment' ? env : coll)[name];
    },
  };
}

const after = (code: string, type = 'afterResponse'): { script: Script; from: string } => ({ script: { type, code }, from: 'request' });
const httpResponse = (body: unknown, status = 200): ScriptResponseInfo => ({
  status,
  statusText: 'OK',
  headers: [['content-type', 'application/json'], ['x-trace', 'abc']],
  body: Buffer.from(JSON.stringify(body)),
  durationMs: 12,
});
const request = { name: 'Get token', url: 'https://auth.example.com/oauth/token', method: 'POST', headers: [] };

// The post-response script from the STF gRPC Bruno collection's "Get token" request.
const BRUNO_TOKEN_SCRIPT = `const body = res.getBody();
if (!body || !body.access_token) {
  throw new Error('No token: ' + JSON.stringify(body));
}
// Kept in memory for this session, not written back to the environment file.
bru.setEnvVar('accessToken', body.access_token);
bru.setEnvVar('reportingToken', body.access_token);
bru.setEnvVar('reportingInternalToken', body.access_token);`;

describe('script runner', () => {
  it('runs a Bruno post-response script that stores a token', async () => {
    const vars = memoryVars();
    const out = await runScripts({ phase: 'after', scripts: [after(BRUNO_TOKEN_SCRIPT)], request, response: httpResponse({ access_token: 'tok-1' }), vars });
    expect(out.error).toBeUndefined();
    expect(vars.env).toEqual({ accessToken: 'tok-1', reportingToken: 'tok-1', reportingInternalToken: 'tok-1' });
    expect(out.set.map((s) => s.name)).toEqual(['accessToken', 'reportingToken', 'reportingInternalToken']);
  });

  it('reports a thrown error with its line number', async () => {
    const out = await runScripts({ phase: 'after', scripts: [after(BRUNO_TOKEN_SCRIPT)], request, response: httpResponse({ error: 'denied' }, 401), vars: memoryVars() });
    expect(out.error).toMatch(/post-response script: No token: \{"error":"denied"\} \(line 3\)/);
  });

  it('supports the Postman API: variables, response helpers, tests', async () => {
    const vars = memoryVars({ existing: 'x' });
    const code = `
      const data = pm.response.json();
      pm.environment.set('token', data.access_token);
      pm.collectionVariables.set('expires', data.expires_in);
      pm.test('status is 200', () => pm.response.to.have.status(200));
      pm.test('has a token', () => pm.expect(data).to.have.property('access_token'));
      pm.test('fails', () => pm.expect(data.expires_in).to.be.above(5000));
      console.log('trace', pm.response.headers.get('X-Trace'), pm.environment.get('existing'));
    `;
    const out = await runScripts({ phase: 'after', scripts: [after(code)], request, response: httpResponse({ access_token: 't', expires_in: 3600 }), vars });
    expect(out.error).toBeUndefined();
    expect(vars.env.token).toBe('t');
    expect(vars.coll.expires).toBe('3600');
    expect(out.tests.map((t) => [t.name, t.passed])).toEqual([
      ['status is 200', true],
      ['has a token', true],
      ['fails', false],
    ]);
    expect(out.tests[2]!.error).toBe('expected 3600 to be above 5000 (line 7)');
    expect(out.logs).toEqual(['trace abc x']);
    expect(summarizeOutcome(out).ok).toBe(false);
  });

  it('reads gRPC responses via pm.response.messages and res.getBody()', async () => {
    const vars = memoryVars();
    const response: ScriptResponseInfo = { headers: [], trailers: [], messages: [{ accessToken: 'g-1', user: { id: 7 } }], code: 0, codeName: 'OK' };
    const code = `
      pm.environment.set('a', pm.response.messages.idx(0).data.accessToken);
      bru.setEnvVar('b', res.getBody().user.id);
      bru.setEnvVar('c', res('user.id'));
      pm.test('ok', () => pm.expect(pm.response.code).to.equal(0));
    `;
    const out = await runScripts({ phase: 'after', scripts: [after(code)], request, response, vars });
    expect(out.error).toBeUndefined();
    expect(vars.env).toEqual({ a: 'g-1', b: '7', c: '7' });
    expect(out.tests[0]!.passed).toBe(true);
  });

  it('runs TypeScript', async () => {
    const vars = memoryVars();
    const code = `
      interface Token { access_token: string; expires_in?: number }
      const body = res.getBody() as Token;
      const bearer: string = body.access_token!;
      bru.setEnvVar('accessToken', bearer);
    `;
    const out = await runScripts({ phase: 'after', scripts: [after(code)], request, response: httpResponse({ access_token: 'ts-1' }), vars });
    expect(out.error).toBeUndefined();
    expect(vars.env.accessToken).toBe('ts-1');
  });

  it('supports await, and pre-request pm.variables for this send only', async () => {
    const vars = memoryVars();
    const code = `await bru.sleep(1); pm.variables.set('requestId', 'r-1'); bru.setEnvVar('saved', pm.variables.get('requestId'));`;
    const out = await runScripts({ phase: 'before', scripts: [{ script: { type: 'beforeRequest', code }, from: 'request' }], request, vars });
    expect(out.error).toBeUndefined();
    expect(out.locals).toEqual({ requestId: 'r-1' });
    expect(vars.env.saved).toBe('r-1');
    const env: Environment = { id: 'e', name: 'E', values: [] };
    const r = resolveRequest(newGrpcRequest({ url: 'x:1', metadata: [{ key: 'x-request-id', value: '{{requestId}}' }] }), { environment: withLocals(env, out.locals) });
    expect(r.metadata).toContainEqual({ key: 'x-request-id', value: 'r-1' });
    expect(env.values).toEqual([]);
  });

  it('stops runaway scripts and blocks unexpected modules', async () => {
    const loop = await runScripts({ phase: 'after', scripts: [after('while (true) {}')], request, response: httpResponse({}), vars: memoryVars(), timeoutMs: 100 });
    expect(loop.error).toMatch(/timed out/i);
    const req = await runScripts({ phase: 'after', scripts: [after("require('fs')")], request, response: httpResponse({}), vars: memoryVars() });
    expect(req.error).toMatch(/require\("fs"\) is not available/);
    const ok = await runScripts({ phase: 'after', scripts: [after("bru.setEnvVar('h', require('crypto').createHash('sha256').update('a').digest('hex').slice(0, 8))")], request, response: httpResponse({}), vars: memoryVars() });
    expect(ok.error).toBeUndefined();
  });

  it('runs collection, folder and request scripts in order for the phase', () => {
    const req = newHttpRequest({ scripts: [{ type: 'afterResponse', code: 'r' }, { type: 'beforeRequest', code: 'rb' }] });
    const collection: Collection = { id: 'c', name: 'C', variables: [], items: [], scripts: [{ type: 'tests', code: 'c' }] };
    const folder = { type: 'folder' as const, id: 'f', name: 'Auth', items: [], scripts: [{ type: 'afterResponse', code: 'f' }] };
    expect(scriptsFor('after', req, [folder], collection).map((s) => [s.from, s.script.code])).toEqual([
      ['collection', 'c'],
      ['folder "Auth"', 'f'],
      ['request', 'r'],
    ]);
    expect(scriptsFor('before', req, [folder], collection).map((s) => s.script.code)).toEqual(['rb']);
  });
});

describe('script checks', () => {
  it('finds syntax errors with their line and column, in JavaScript and TypeScript', () => {
    expect(checkScript('const a: number = 1;\nbru.setEnvVar("a", a);')).toBeUndefined();
    expect(checkScript('const a = 1;\nconst b = ;')).toMatchObject({ line: 2, column: 11 });
    // a missing ")" is noticed where the next statement starts
    expect(checkScript("pm.test('x', () => pm.expect(1).to.equal(1)\nbru.setEnvVar('a', 1);")).toMatchObject({ message: expect.stringMatching(/expected/i), line: 2, column: 1 });
  });

  it('test runs read real variables but never write them', async () => {
    const store: Record<string, string> = { token: 't0' };
    const real: ScriptVars = {
      get: (_s, n) => store[n],
      set: (_s, n, v) => ((store[n] = v), 'environment'),
      unset: (_s, n) => void delete store[n],
      environmentName: 'Dev',
    };
    const code = "bru.setEnvVar('token', bru.getEnvVar('token') + '-new'); console.log(bru.getEnvVar('token'));";
    const outcome = await runScripts({ phase: 'before', scripts: [{ script: { type: 'beforeRequest', code }, from: 'request' }], request: { name: 'r', url: 'u', method: 'GET', headers: [] }, vars: dryRunVars(real) });
    expect(outcome.logs).toEqual(['t0-new']);
    expect(outcome.set).toEqual([{ scope: 'environment', name: 'token', value: 't0-new', where: 'environment "Dev", not saved' }]);
    expect(store.token).toBe('t0');
  });
});

describe('scripts with the workspace', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const s = await startDemoHttpServer(0);
    server = s.server;
    base = `http://localhost:${s.port}`;
  });
  afterAll(() => server?.close());

  it('"Get token" sets {{accessToken}} in the environment, and gRPC metadata picks it up', async () => {
    const ws = new Workspace(mkhome());
    const env = ws.createEnvironment('Dev');
    env.values.push({ key: 'accessToken', value: '', type: 'secret', enabled: true });
    ws.saveEnvironment(env);
    ws.setActiveEnvironment(env.id);
    const collection: Collection = { id: 'c1', name: 'STF', variables: [{ key: 'base', value: base }], items: [] };
    ws.collections.push(collection);

    const getToken = newHttpRequest({
      name: 'Get token',
      method: 'POST',
      url: '{{base}}/oauth/token',
      headers: [{ key: 'content-type', value: 'application/json' }],
      body: { type: 'json', content: '{"client_id":"demo-client","client_secret":"demo-secret"}' },
      scripts: [{ type: 'afterResponse', code: BRUNO_TOKEN_SCRIPT, language: 'text/javascript' }],
    });
    const r = resolveHttpRequest(getToken, { collection, environment: ws.activeEnvironment });
    const res = await sendHttp(r).done;
    expect(res.status).toBe(200);
    const out = await runPhase('after', { store: ws, request: getToken, collection, environment: ws.activeEnvironment, info: httpRequestInfo(getToken.name, r), response: httpResponseInfo(res) });
    expect(out?.error).toBeUndefined();

    // Persisted to disk, and the secret flag is kept.
    const saved = JSON.parse(readFileSync(join(ws.home, 'environments', `${env.id}.json`), 'utf8')) as Environment;
    expect(saved.values.find((v) => v.key === 'accessToken')).toMatchObject({ value: 'demo-token', type: 'secret' });
    expect(saved.values.find((v) => v.key === 'reportingToken')?.value).toBe('demo-token');

    // A fresh workspace (e.g. the next `ferry run`) resolves it into gRPC metadata.
    const next = new Workspace(ws.home);
    const call = newGrpcRequest({ url: 'localhost:50051', metadata: [{ key: 'authorization', value: 'Bearer {{accessToken}}' }] });
    expect(resolveRequest(call, { environment: next.activeEnvironment }).metadata).toContainEqual({ key: 'authorization', value: 'Bearer demo-token' });
  });

  it('writes to the collection when no environment is active', async () => {
    const ws = new Workspace(mkhome());
    const collection: Collection = { id: 'c2', name: 'C', variables: [], items: [] };
    ws.collections.push(collection);
    const req = newHttpRequest({ scripts: [{ type: 'afterResponse', code: "pm.environment.set('t', 'v'); pm.environment.unset('gone')" }] });
    const out = await runPhase('after', { store: ws, request: req, collection, info: request, response: httpResponse({}) });
    expect(out?.set[0]?.where).toBe('collection "C"');
    expect(collection.variables).toEqual([{ key: 't', value: 'v' }]);
  });
});

describe('variable table editor', () => {
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const ESC = '\u001B';

  it('keeps a pasted value when esc ends the edit', async () => {
    let saved: KVRow[] | undefined;
    const token = `eyJ${'x'.repeat(1200)}.sig`;
    const app = render(
      <KVEditorModal title="Env" rows={[{ key: 'accessToken', value: '', secret: true }]} width={80} height={20} allowSecret onSave={(rows) => (saved = rows)} onCancel={() => {}} />,
    );
    await tick();
    app.stdin.write('\u001B[C'); // → value column
    await tick();
    app.stdin.write('\r'); // edit
    await tick();
    app.stdin.write(token); // one paste chunk
    await tick();
    app.stdin.write(ESC); // finish editing
    await tick();
    expect(app.lastFrame()).toContain('••••••••');
    app.stdin.write(ESC); // save & close
    await tick();
    app.unmount();
    expect(saved).toEqual([{ key: 'accessToken', value: token, secret: true }]);
  });

  it('puts a paste on a selected cell into that cell', async () => {
    let saved: KVRow[] | undefined;
    const app = render(<KVEditorModal title="Env" rows={[{ key: 'accessToken', value: 'old', secret: true }]} width={80} height={20} allowSecret onSave={(rows) => (saved = rows)} onCancel={() => {}} />);
    await tick();
    app.stdin.write('\u001B[C'); // → value column, not editing
    await tick();
    app.stdin.write('new-token-value\n');
    await tick();
    app.stdin.write('\r'); // apply
    await tick();
    app.stdin.write(ESC); // save & close
    await tick();
    app.unmount();
    expect(saved).toEqual([{ key: 'accessToken', value: 'new-token-value', secret: true }]);
  });

  it('types straight into a selected empty cell', async () => {
    let saved: KVRow[] | undefined;
    const app = render(<KVEditorModal title="Vars" rows={[{ key: 'baseUrl', value: '' }]} width={80} height={20} onSave={(rows) => (saved = rows)} onCancel={() => {}} />);
    await tick();
    expect(app.lastFrame()).toMatch(/baseUrl\s+<empty>/);
    app.stdin.write('\u001B[C'); // → value column, not editing
    await tick();
    for (const ch of 'dev.local') {
      // letters like d / e / v / a are commands on a filled cell, text on an empty one
      app.stdin.write(ch);
      await tick();
    }
    app.stdin.write('\r'); // apply
    await tick();
    expect(app.lastFrame()).toMatch(/baseUrl\s+dev\.local/);
    app.stdin.write(ESC); // save & close
    await tick();
    app.unmount();
    expect(saved).toEqual([{ key: 'baseUrl', value: 'dev.local' }]);
  });

  it('keeps letters as commands on a filled cell', async () => {
    let saved: KVRow[] | undefined;
    const app = render(<KVEditorModal title="Vars" rows={[{ key: 'a', value: '1' }, { key: 'b', value: '2' }]} width={80} height={20} onSave={(rows) => (saved = rows)} onCancel={() => {}} />);
    await tick();
    app.stdin.write('d'); // delete the first row
    await tick();
    app.stdin.write(ESC);
    await tick();
    app.unmount();
    expect(saved).toEqual([{ key: 'b', value: '2' }]);
  });

  it('drops a new row left empty', async () => {
    let saved: KVRow[] | undefined;
    const app = render(<KVEditorModal title="Env" rows={[]} width={80} height={20} onSave={(rows) => (saved = rows)} onCancel={() => {}} />);
    await tick();
    app.stdin.write('a');
    await tick();
    app.stdin.write(ESC);
    await tick();
    app.stdin.write(ESC);
    await tick();
    app.unmount();
    expect(saved).toEqual([]);
  });
});

describe('variables in the message editor', () => {
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const vars = (table: Record<string, string>) => (name: string) => table[name];

  it('colors {{vars}} by whether they have a value', () => {
    const lookup = vars({ host: 'api.local', token: '' });
    expect(varColor('{{host}}', lookup)).toBe(theme.vars.set);
    expect(varColor('{{ token }}', lookup)).toBe(theme.vars.empty);
    expect(varColor('{{missing}}', lookup)).toBe(theme.vars.empty);
  });

  it('finds the {{var}} under the cursor', () => {
    const line = '  "id": "{{userId}}",';
    expect(varAt(line, line.indexOf('{{'))?.name).toBe('userId');
    expect(varAt(line, line.indexOf('}}') + 2)?.name).toBe('userId');
    expect(varAt(line, 2)).toBeUndefined();
  });

  it('sets an empty {{var}} in place with enter', async () => {
    const set: Array<[string, string]> = [];
    let text = '{"id": "{{userId}}"}';
    const app = render(<TextEditor value={text} onChange={(v) => (text = v)} width={60} height={5} active vars={vars({})} onSetVar={(n, v) => set.push([n, v])} />);
    await tick();
    for (let i = 0; i < 10; i++) app.stdin.write('\u001B[C'); // → onto {{userId}}
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(app.lastFrame()).toContain('{{userId}} =');
    app.stdin.write('u-42');
    await tick();
    app.stdin.write('\r');
    await tick();
    app.unmount();
    expect(set).toEqual([['userId', 'u-42']]);
    expect(text).toBe('{"id": "{{userId}}"}'); // the message itself is untouched
  });

  it('keeps enter as a newline away from a {{var}}', async () => {
    let text = '{}';
    const app = render(<TextEditor value={text} onChange={(v) => (text = v)} width={60} height={5} active vars={vars({})} onSetVar={() => {}} />);
    await tick();
    app.stdin.write('\u001B[C');
    await tick();
    app.stdin.write('\r');
    await tick();
    app.unmount();
    expect(text).toBe('{\n  \n}');
  });
});
