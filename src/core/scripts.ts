/**
 * Runs pre-request and post-response scripts (JavaScript or TypeScript) with
 * the parts of the Postman (`pm.*`) and Bruno (`bru.*`, `res`, `req`) APIs
 * that matter for chaining: reading the response, setting variables, tests.
 *
 *   // Bruno
 *   const body = res.getBody();
 *   bru.setEnvVar('accessToken', body.access_token);
 *
 *   // Postman (HTTP, and gRPC via pm.response.messages)
 *   pm.environment.set('accessToken', pm.response.json().access_token);
 *
 * Scripts run in a separate V8 context with a timeout. That keeps accidents
 * contained, but it is not a security boundary: a script can do anything the
 * collection's author could, so only run collections you trust.
 */
import * as nodeModule from 'node:module';
import { Buffer } from 'node:buffer';
import vm from 'node:vm';
import { type Segment, getAtPath, parsePath, valueToString } from './jsonpath.js';
import type { CallResult } from '../grpc/invoke.js';
import type { HttpResult } from '../http/client.js';
import type { Collection, Environment, Folder, Script, SendableRequest } from './model.js';
import { type ResolvedHttpRequest, type ResolvedRequest, buildScopes } from './resolve.js';
import { createResolver } from './vars.js';

export type ScriptPhase = 'before' | 'after';
/** Where a script's variable writes go. `local` lives for the current send only (pm.variables). */
export type ScriptScope = 'environment' | 'collection' | 'local';

export function isPhase(script: Script, phase: ScriptPhase): boolean {
  return phase === 'before' ? /before|pre/i.test(script.type) : /after|post|test/i.test(script.type);
}

export interface PlannedScript {
  script: Script;
  /** "collection", folder name or "request", for messages */
  from: string;
}

/** Scripts for a phase in run order: collection, folders (outermost first), request. */
export function scriptsFor(phase: ScriptPhase, request: SendableRequest, ancestors: Folder[], collection?: Collection): PlannedScript[] {
  const levels: Array<[string, Script[] | undefined]> = [
    ['collection', collection?.scripts],
    ...ancestors.map((f): [string, Script[] | undefined] => [`folder "${f.name}"`, f.scripts]),
    ['request', request.scripts],
  ];
  return levels.flatMap(([from, scripts]) => (scripts ?? []).filter((s) => s.code.trim() && isPhase(s, phase)).map((script) => ({ script, from })));
}

/** Variable storage the scripts read from and write to. */
export interface ScriptVars {
  /** `any` resolves like `{{name}}` does (nearest scope wins) */
  get(scope: 'environment' | 'collection' | 'any', name: string): string | undefined;
  /** persists the value; returns where it went, e.g. `environment "Dev"` */
  set(scope: 'environment' | 'collection', name: string, value: string): string | undefined;
  unset(scope: 'environment' | 'collection', name: string): void;
  environmentName?: string;
}

export interface ScriptRequestInfo {
  name: string;
  url: string;
  /** HTTP method, or the gRPC method path */
  method: string;
  headers: Array<{ key: string; value: string }>;
  body?: string;
}

export interface ScriptResponseInfo {
  headers: Array<[string, string]>;
  durationMs?: number;
  /** HTTP */
  status?: number;
  statusText?: string;
  body?: Buffer;
  /** gRPC */
  messages?: unknown[];
  trailers?: Array<[string, string]>;
  code?: number;
  codeName?: string;
  details?: string;
}

export interface ScriptTest {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ScriptOutcome {
  /** number of scripts that ran */
  ran: number;
  logs: string[];
  tests: ScriptTest[];
  /** persisted variable writes, in order (`value` undefined = unset) */
  set: Array<{ scope: 'environment' | 'collection'; name: string; value?: string; where?: string }>;
  /** pm.variables.set values, applied when resolving this request */
  locals: Record<string, string>;
  /** the first script error; later scripts still run, except before a request */
  error?: string;
}

export interface RunScriptsOptions {
  phase: ScriptPhase;
  scripts: PlannedScript[];
  request: ScriptRequestInfo;
  response?: ScriptResponseInfo;
  vars: ScriptVars;
  /** per script, default 10 s */
  timeoutMs?: number;
}

const TIMEOUT_MS = 10_000;

export async function runScripts(o: RunScriptsOptions): Promise<ScriptOutcome> {
  const outcome: ScriptOutcome = { ran: 0, logs: [], tests: [], set: [], locals: {} };
  for (const planned of o.scripts) {
    outcome.ran++;
    try {
      await runOne(planned, o, outcome);
    } catch (err) {
      outcome.error ??= `${label(planned, o.phase)}: ${errorText(err)}`;
      if (o.phase === 'before') break;
    }
  }
  return outcome;
}

function label(p: PlannedScript, phase: ScriptPhase): string {
  const kind = /test/i.test(p.script.type) ? 'tests' : phase === 'before' ? 'pre-request script' : 'post-response script';
  return p.from === 'request' ? kind : `${p.from} ${kind}`;
}

function errorText(err: unknown): string {
  if (!(err instanceof Error) && !(err && typeof err === 'object' && 'message' in err)) return String(err);
  const e = err as Error;
  // "at <file>:LINE:COL" from the script's own frame
  const line = /ferry-script:(\d+):\d+/.exec(e.stack ?? '')?.[1];
  return `${e.message}${line ? ` (line ${line})` : ''}`;
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

type Strip = (code: string, opts?: { mode?: 'strip' | 'transform' }) => string;
const stripTypes = (nodeModule as unknown as { stripTypeScriptTypes?: Strip }).stripTypeScriptTypes;

/** Node's built-in type stripping (Node 22.13+), without its ExperimentalWarning on stderr (it would garble the UI). */
function stripTypeScript(code: string): string {
  if (!stripTypes) throw new Error(`TypeScript scripts need Node 22.13 or newer (running ${process.version})`);
  const emit = process.emitWarning;
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try {
    return stripTypes(code, { mode: 'strip' });
  } finally {
    process.emitWarning = emit;
  }
}

function compile(code: string, language: string | undefined): vm.Script {
  // Wrapping in an async function allows top-level await and return.
  const make = (src: string) => new vm.Script(`(async () => {\n${src}\n})()`, { filename: 'ferry-script', lineOffset: -1 });
  if (language && /typescript|\bts\b/i.test(language)) return make(stripTypeScript(code));
  try {
    return make(code);
  } catch (err) {
    // Not valid JavaScript: maybe TypeScript saved without a language.
    if (!(err instanceof SyntaxError) || !stripTypes) throw err;
    let stripped: string;
    try {
      stripped = stripTypeScript(code);
    } catch {
      throw err;
    }
    return make(stripped);
  }
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const ALLOWED_MODULES = new Set(['crypto', 'buffer', 'url', 'querystring', 'util', 'path']);
const moduleRequire = nodeModule.createRequire(import.meta.url);

function headerGetter(headers: Array<[string, string]>) {
  const find = (name: string) => headers.filter(([k]) => k.toLowerCase() === String(name).toLowerCase()).map(([, v]) => v);
  return {
    get: (name: string) => find(name).join(', ') || undefined,
    has: (name: string) => find(name).length > 0,
    toObject: () => Object.fromEntries(headers.map(([k, v]) => [k.toLowerCase(), v])),
    all: () => headers.map(([key, value]) => ({ key, value })),
  };
}

async function runOne(planned: PlannedScript, o: RunScriptsOptions, outcome: ScriptOutcome): Promise<void> {
  const script = compile(planned.script.code, planned.script.language);
  const context = vm.createContext({});
  // Build JSON values inside the script's realm so `instanceof Array` etc. behave.
  const parseInContext = vm.runInContext('JSON.parse', context) as (text: string) => unknown;
  const local = <T>(value: T): T => (value === undefined ? value : (parseInContext(JSON.stringify(value)) as T));

  const { vars, request, response } = o;
  const log = (level: string) => (...args: unknown[]) =>
    outcome.logs.push(`${level ? `${level}: ` : ''}${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}`);

  const set = (scope: 'environment' | 'collection', name: unknown, value: unknown) => {
    const key = String(name);
    const text = value === undefined ? '' : valueToString(value);
    const where = vars.set(scope, key, text);
    outcome.set.push({ scope, name: key, value: text, where });
    delete outcome.locals[key];
  };
  const unset = (scope: 'environment' | 'collection', name: unknown) => {
    vars.unset(scope, String(name));
    outcome.set.push({ scope, name: String(name) });
  };
  const get = (scope: 'environment' | 'collection' | 'any', name: unknown) => {
    const key = String(name);
    if (scope === 'any' && key in outcome.locals) return outcome.locals[key];
    return vars.get(scope, key);
  };
  const interpolate = (text: unknown) =>
    String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, name: string) => get('any', name) ?? m);

  const scopeApi = (scope: 'environment' | 'collection') => ({
    get: (n: unknown) => get(scope, n),
    set: (n: unknown, v: unknown) => set(scope, n, v),
    unset: (n: unknown) => unset(scope, n),
    has: (n: unknown) => get(scope, n) !== undefined,
    replaceIn: interpolate,
    ...(scope === 'environment' ? { name: vars.environmentName } : {}),
  });

  // --- response views -------------------------------------------------------
  const isGrpc = response?.messages !== undefined;
  const bodyText = response?.body?.toString('utf8') ?? '';
  let bodyCache: { value: unknown } | undefined;
  const body = (): unknown => {
    if (!bodyCache) {
      if (isGrpc) {
        const msgs = response!.messages!;
        bodyCache = { value: local(msgs.length === 1 ? msgs[0] : msgs) };
      } else {
        try {
          bodyCache = { value: bodyText ? parseInContext(bodyText) : undefined };
        } catch {
          bodyCache = { value: bodyText };
        }
      }
    }
    return bodyCache.value;
  };
  const json = (): unknown => {
    const b = body();
    if (!isGrpc && typeof b === 'string') throw new Error('the response body is not JSON');
    return b;
  };
  const status = isGrpc ? response?.code : response?.status;

  const tests = (name: unknown, fn: () => unknown) => {
    const record = (err?: unknown) => outcome.tests.push({ name: String(name), passed: !err, ...(err ? { error: errorText(err) } : {}) });
    try {
      const r = fn();
      if (r && typeof (r as Promise<unknown>).then === 'function') return (r as Promise<unknown>).then(() => record(), record);
      record();
    } catch (err) {
      record(err);
    }
  };

  const pmResponse = response && {
    code: status,
    status: isGrpc ? response.codeName : response.statusText,
    statusCode: response.code,
    responseTime: response.durationMs,
    responseSize: response.body?.length,
    headers: headerGetter(response.headers),
    metadata: headerGetter(response.headers),
    trailers: headerGetter(response.trailers ?? []),
    json,
    text: () => (isGrpc ? safeJson(body()) : bodyText),
    messages: {
      idx: (i: number) => (response.messages?.[i] === undefined ? undefined : { data: local(response.messages[i]) }),
      count: () => response.messages?.length ?? 0,
      all: () => (response.messages ?? []).map((m) => ({ data: local(m) })),
      each: (fn: (m: { data: unknown }, i: number) => void) => (response.messages ?? []).forEach((m, i) => fn({ data: local(m) }, i)),
    },
    to: {
      have: {
        status: (expected: number | string) => {
          const actual = typeof expected === 'number' ? status : isGrpc ? response.codeName : response.statusText;
          if (actual !== expected) throw new Error(`expected status ${expected} but got ${actual}`);
        },
      },
    },
  };

  const pmRequestHeaders = request.headers.map(({ key, value }): [string, string] => [key, value]);
  const pm = {
    environment: scopeApi('environment'),
    collectionVariables: scopeApi('collection'),
    globals: scopeApi('environment'),
    variables: {
      get: (n: unknown) => get('any', n),
      set: (n: unknown, v: unknown) => {
        outcome.locals[String(n)] = v === undefined ? '' : valueToString(v);
      },
      has: (n: unknown) => get('any', n) !== undefined,
      unset: (n: unknown) => {
        delete outcome.locals[String(n)];
      },
      replaceIn: interpolate,
    },
    request: { url: { toString: () => request.url }, method: request.method, headers: headerGetter(pmRequestHeaders), body: { raw: request.body } },
    response: pmResponse,
    info: { requestName: request.name, eventName: o.phase === 'before' ? 'prerequest' : 'test' },
    test: tests,
    expect,
    sendRequest: () => {
      throw new Error('pm.sendRequest is not supported; chain a separate request instead');
    },
  };

  const res = response && Object.assign((path: string) => {
    const segments: Segment[] | undefined = parsePath(path);
    return segments ? getAtPath(body(), segments) : undefined;
  }, {
    get status() {
      return status;
    },
    get statusText() {
      return pmResponse?.status;
    },
    get headers() {
      return pmResponse?.headers.toObject();
    },
    get body() {
      return body();
    },
    get responseTime() {
      return response.durationMs;
    },
    getStatus: () => status,
    getStatusText: () => pmResponse?.status,
    getHeader: (n: string) => pmResponse?.headers.get(n),
    getHeaders: () => pmResponse?.headers.toObject(),
    getBody: () => body(),
    getResponseTime: () => response.durationMs,
  });

  const req = {
    getName: () => request.name,
    getUrl: () => request.url,
    getMethod: () => request.method,
    getHeader: (n: string) => headerGetter(pmRequestHeaders).get(n),
    getHeaders: () => headerGetter(pmRequestHeaders).toObject(),
    getBody: () => request.body,
  };

  const bru = {
    setEnvVar: (n: unknown, v: unknown) => set('environment', n, v),
    getEnvVar: (n: unknown) => get('environment', n),
    deleteEnvVar: (n: unknown) => unset('environment', n),
    // Bruno's runtime vars last for the session; storing them in the environment keeps chaining working across runs.
    setVar: (n: unknown, v: unknown) => set('environment', n, v),
    getVar: (n: unknown) => get('any', n),
    deleteVar: (n: unknown) => unset('environment', n),
    setGlobalEnvVar: (n: unknown, v: unknown) => set('environment', n, v),
    getGlobalEnvVar: (n: unknown) => get('environment', n),
    getCollectionVar: (n: unknown) => get('collection', n),
    getFolderVar: (n: unknown) => get('any', n),
    getRequestVar: (n: unknown) => get('any', n),
    getEnvName: () => vars.environmentName,
    getProcessEnv: (n: string) => process.env[n],
    interpolate,
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    setNextRequest: () => outcome.logs.push('bru.setNextRequest is ignored (no collection runner)'),
    runner: { skipRequest: () => {}, stopExecution: () => {} },
  };

  Object.assign(context, {
    pm,
    postman: { setEnvironmentVariable: (n: unknown, v: unknown) => set('environment', n, v), getEnvironmentVariable: (n: unknown) => get('environment', n) },
    bru,
    req,
    ...(res ? { res } : {}),
    test: tests,
    expect,
    console: { log: log(''), info: log(''), debug: log(''), warn: log('warn'), error: log('error') },
    require: (name: string) => {
      const bare = name.replace(/^node:/, '');
      if (!ALLOWED_MODULES.has(bare)) throw new Error(`require("${name}") is not available in scripts (allowed: ${[...ALLOWED_MODULES].join(', ')})`);
      return moduleRequire(`node:${bare}`);
    },
    Buffer,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    crypto: globalThis.crypto,
  });

  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const promise = script.runInContext(context, { timeout: timeoutMs }) as Promise<unknown>;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// A small chai-style expect: enough for the usual pm.test / Bruno test bodies.
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function typeOf(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

export function expect(actual: unknown): unknown {
  let negate = false;
  const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : safeJson(v));
  const assert = (ok: boolean, what: string) => {
    if (ok === negate) throw new Error(`expected ${show(actual)} ${negate ? 'not ' : ''}${what}`);
    return chain;
  };
  const size = () => (typeof actual === 'string' || Array.isArray(actual) ? actual.length : actual && typeof actual === 'object' ? Object.keys(actual).length : undefined);
  const chain: Record<string, unknown> = {};
  for (const word of ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'but', 'does', 'deep', 'still']) {
    Object.defineProperty(chain, word, { get: () => chain });
  }
  Object.defineProperty(chain, 'not', {
    get: () => {
      negate = !negate;
      return chain;
    },
  });
  const getters: Record<string, () => unknown> = {
    ok: () => assert(!!actual, 'to be truthy'),
    true: () => assert(actual === true, 'to be true'),
    false: () => assert(actual === false, 'to be false'),
    null: () => assert(actual === null, 'to be null'),
    undefined: () => assert(actual === undefined, 'to be undefined'),
    exist: () => assert(actual !== null && actual !== undefined, 'to exist'),
    empty: () => assert(size() === 0, 'to be empty'),
  };
  for (const [name, fn] of Object.entries(getters)) Object.defineProperty(chain, name, { get: fn });
  const equal = (v: unknown) => assert(Object.is(actual, v) || actual === v, `to equal ${show(v)}`);
  const eql = (v: unknown) => assert(deepEqual(actual, v), `to deeply equal ${show(v)}`);
  const a = (type: string) => assert(typeOf(actual) === String(type).toLowerCase(), `to be a${/^[aeiou]/i.test(type) ? 'n' : ''} ${type}`);
  const include = (v: unknown) =>
    assert(
      typeof actual === 'string'
        ? actual.includes(String(v))
        : Array.isArray(actual)
          ? actual.some((x) => deepEqual(x, v))
          : !!actual && typeof actual === 'object' && !!v && typeof v === 'object' && Object.entries(v).every(([k, x]) => deepEqual((actual as Record<string, unknown>)[k], x)),
      `to include ${show(v)}`,
    );
  const num = (op: (x: number, y: number) => boolean, word: string) => (n: number) => assert(typeof actual === 'number' && op(actual, n), `to be ${word} ${n}`);
  Object.assign(chain, {
    equal,
    equals: equal,
    eq: equal,
    eql,
    eqls: eql,
    a,
    an: a,
    include,
    includes: include,
    contain: include,
    contains: include,
    property: (name: string, ...value: unknown[]) => {
      const has = !!actual && typeof actual === 'object' && name in actual;
      if (!value.length) return assert(has, `to have property ${show(name)}`);
      return assert(has && deepEqual((actual as Record<string, unknown>)[name], value[0]), `to have property ${show(name)} of ${show(value[0])}`);
    },
    lengthOf: (n: number) => assert(size() === n, `to have length ${n}`),
    above: num((x, y) => x > y, 'above'),
    gt: num((x, y) => x > y, 'above'),
    greaterThan: num((x, y) => x > y, 'above'),
    below: num((x, y) => x < y, 'below'),
    lt: num((x, y) => x < y, 'below'),
    lessThan: num((x, y) => x < y, 'below'),
    least: num((x, y) => x >= y, 'at least'),
    gte: num((x, y) => x >= y, 'at least'),
    most: num((x, y) => x <= y, 'at most'),
    lte: num((x, y) => x <= y, 'at most'),
    match: (re: RegExp) => assert(typeof actual === 'string' && re.test(actual), `to match ${re}`),
    oneOf: (list: unknown[]) => assert(list.some((x) => deepEqual(x, actual)), `to be one of ${show(list)}`),
  });
  return chain;
}

// ---------------------------------------------------------------------------
// Wiring to the workspace
// ---------------------------------------------------------------------------

/** Minimal slice of Workspace the scripts need (keeps this module free of fs). */
export interface VariableStore {
  setVariable(name: string, value: string, opts: { collectionId?: string; environment?: Environment; scope?: 'environment' | 'collection' }): string | undefined;
  unsetVariable(name: string, opts: { collectionId?: string; environment?: Environment; scope?: 'environment' | 'collection' }): void;
}

export function workspaceVars(store: VariableStore, ctx: { collection?: Collection; ancestors?: Folder[]; environment?: Environment }): ScriptVars {
  const opts = { collectionId: ctx.collection?.id, environment: ctx.environment };
  const enabled = (list: Array<{ key: string; value: string; enabled?: boolean; disabled?: boolean }> | undefined, name: string) =>
    list?.find((v) => v.key === name && v.enabled !== false && !v.disabled)?.value;
  return {
    environmentName: ctx.environment?.name,
    get: (scope, name) => {
      if (scope === 'environment') return enabled(ctx.environment?.values, name);
      if (scope === 'collection') return enabled(ctx.collection?.variables, name);
      return createResolver(buildScopes(ctx.collection, ctx.ancestors ?? [], ctx.environment)).lookup(name);
    },
    set: (scope, name, value) => store.setVariable(name, value, { ...opts, scope }),
    unset: (scope, name) => store.unsetVariable(name, { ...opts, scope }),
  };
}

/** The environment to resolve the request with, including pm.variables values set by pre-request scripts. */
export function withLocals(environment: Environment | undefined, locals: Record<string, string>): Environment | undefined {
  const entries = Object.entries(locals);
  if (!entries.length) return environment;
  const values = [...(environment?.values ?? []), ...entries.map(([key, value]) => ({ key, value }))];
  return { id: environment?.id ?? 'local', name: environment?.name ?? 'local', values };
}

export function httpRequestInfo(name: string, r: ResolvedHttpRequest): ScriptRequestInfo {
  return { name, url: r.url, method: r.method, headers: r.headers, body: r.body.content };
}

export function grpcRequestInfo(name: string, r: ResolvedRequest): ScriptRequestInfo {
  return { name, url: r.url, method: r.methodPath, headers: r.metadata, body: r.message };
}

export function httpResponseInfo(res: HttpResult): ScriptResponseInfo {
  return { headers: res.headers, durationMs: res.durationMs, status: res.status, statusText: res.statusText, body: res.body };
}

export function grpcResponseInfo(res: CallResult): ScriptResponseInfo {
  return { headers: res.headers, trailers: res.trailers, messages: res.messages, code: res.code, codeName: res.codeName, details: res.details, durationMs: res.durationMs };
}

/**
 * Runs a request's scripts for one phase (collection, folder and request
 * levels). Returns undefined when there are none.
 */
export async function runPhase(
  phase: ScriptPhase,
  o: {
    store: VariableStore;
    request: SendableRequest;
    collection?: Collection;
    ancestors?: Folder[];
    environment?: Environment;
    info: ScriptRequestInfo;
    response?: ScriptResponseInfo;
  },
): Promise<ScriptOutcome | undefined> {
  const scripts = scriptsFor(phase, o.request, o.ancestors ?? [], o.collection);
  if (!scripts.length) return undefined;
  const vars = workspaceVars(o.store, o);
  return runScripts({ phase, scripts, request: o.info, response: o.response, vars });
}

/** Hides values of secret environment variables (and anything that looks like a credential) in summaries. */
export function secretMask(environment: Environment | undefined): (name: string, value: string) => string {
  return (name, value) =>
    environment?.values.some((v) => v.key === name && v.type === 'secret') || /token|secret|password|passwd|api[-_]?key/i.test(name)
      ? `${value.slice(0, 6)}…(${value.length} chars)`
      : value;
}

/** One-line summary for a toast or stderr, e.g. `script set {{accessToken}} in environment "Dev" · 2/2 tests passed`. */
export function summarizeOutcome(outcome: ScriptOutcome, mask: (name: string, value: string) => string = (_, v) => v): { text: string; ok: boolean } {
  const parts: string[] = [];
  const latest = new Map<string, ScriptOutcome['set'][number]>();
  for (const s of outcome.set) latest.set(s.name, s);
  const sets = [...latest.values()].filter((s) => s.value !== undefined);
  if (sets.length) {
    const where = [...new Set(sets.map((s) => s.where).filter(Boolean))].join(', ');
    parts.push(`script set ${sets.map((s) => `{{${s.name}}} = ${truncateMiddle(mask(s.name, s.value!), 24)}`).join(', ')}${where ? ` in ${where}` : ''}`);
    if (sets.some((s) => !s.where)) parts.push('no environment or collection to store variables in');
  }
  const failed = outcome.tests.filter((t) => !t.passed);
  if (outcome.tests.length) parts.push(`${outcome.tests.length - failed.length}/${outcome.tests.length} tests passed${failed.length ? ` (${failed.map((t) => `${t.name}: ${t.error}`).join('; ')})` : ''}`);
  if (outcome.error) parts.push(outcome.error);
  return { text: parts.join(' · '), ok: !outcome.error && !failed.length && !sets.some((s) => !s.where) };
}

function truncateMiddle(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
