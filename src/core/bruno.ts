/**
 * Bruno collection import, both formats:
 *
 *   .bru ("Bru lang")            bruno.json + collection.bru + folder.bru + *.bru, environments/*.bru
 *   OpenCollection YAML (Bruno 3) opencollection.yml + folder.yml + *.yml,       environments/*.yml
 *
 * Requests of type http and grpc are imported; graphql .bru requests become
 * HTTP requests with a GraphQL body. `vars:post-response` and capture-shaped
 * scripts become captures.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { attachHttpScriptCaptures } from './postman-v3.js';
import {
  type Auth,
  type Capture,
  type Collection,
  type Environment,
  type Folder,
  type FormEntry,
  type GrpcRequest,
  type HttpBody,
  type HttpRequest,
  type Item,
  type KV,
  type Script,
  newId,
  sortItems,
  splitQuery,
} from './model.js';

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x): x is Obj => !!x && typeof x === 'object') : []);
const listDir = (dir: string) => readdirSync(dir).sort();

export function isBruCollection(dir: string): boolean {
  return existsSync(join(dir, 'bruno.json'));
}

export function isOpenCollection(dir: string): boolean {
  return existsSync(join(dir, 'opencollection.yml')) || existsSync(join(dir, 'opencollection.yaml'));
}

// ===========================================================================
// .bru parsing
// ===========================================================================

interface BruBlock {
  name: string;
  /** inner lines, dedented by two spaces */
  lines: string[];
}

/** Splits a .bru file into top-level `name { ... }` / `name [ ... ]` blocks. */
export function parseBru(text: string): Map<string, BruBlock> {
  const blocks = new Map<string, BruBlock>();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^([A-Za-z][\w:-]*)\s*([{[])\s*$/.exec(lines[i]!);
    if (!open) continue;
    const close = open[2] === '{' ? '}' : ']';
    const inner: string[] = [];
    for (i++; i < lines.length && lines[i] !== close; i++) inner.push(lines[i]!.startsWith('  ') ? lines[i]!.slice(2) : lines[i]!);
    blocks.set(open[1]!, { name: open[1]!, lines: inner });
  }
  return blocks;
}

interface BruEntry {
  key: string;
  value: string;
  disabled: boolean;
}

/** `key: value` lines; `~key` is disabled; `'''` starts a multi-line value. */
function bruDict(block: BruBlock | undefined): BruEntry[] {
  if (!block) return [];
  const out: BruEntry[] = [];
  const lines = block.lines;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const m = /^(~?)([^:]+?)\s*:\s?(.*)$/.exec(line);
    if (!m) continue;
    let value = m[3]!;
    if (value.trim() === "'''") {
      const buf: string[] = [];
      for (i++; i < lines.length && lines[i]!.trim() !== "'''"; i++) buf.push(lines[i]!.replace(/^ {2}/, ''));
      value = buf.join('\n');
    }
    out.push({ key: m[2]!.trim().replace(/^"(.*)"$/, '$1'), value, disabled: m[1] === '~' });
  }
  return out;
}

function bruText(block: BruBlock | undefined): string | undefined {
  if (!block) return undefined;
  const lines = [...block.lines];
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.join('\n');
}

const dictKV = (entries: BruEntry[]): KV[] => entries.map((e) => ({ key: e.key, value: e.value, ...(e.disabled ? { disabled: true } : {}) }));
const dictGet = (entries: BruEntry[], key: string) => entries.find((e) => e.key === key)?.value;

function bruAuth(mode: string | undefined, blocks: Map<string, BruBlock>): Auth | undefined {
  if (!mode || mode === 'inherit') return undefined;
  if (mode === 'none') return { type: 'noauth' };
  const d = bruDict(blocks.get(`auth:${mode}`));
  const get = (k: string) => dictGet(d, k) ?? '';
  switch (mode) {
    case 'bearer':
      return { type: 'bearer', credentials: [{ key: 'token', value: get('token') }] };
    case 'basic':
      return { type: 'basic', credentials: [{ key: 'username', value: get('username') }, { key: 'password', value: get('password') }] };
    case 'apikey':
      return {
        type: 'apikey',
        credentials: [
          { key: 'key', value: get('key') },
          { key: 'value', value: get('value') },
          { key: 'in', value: /query/i.test(get('placement')) ? 'query' : 'header' },
        ],
      };
    case 'oauth2':
      return { type: 'oauth2', credentials: d.map((e) => ({ key: e.key === 'access_token' ? 'accessToken' : e.key, value: e.value })) };
    default:
      return { type: mode, credentials: d.map((e) => ({ key: e.key, value: e.value })) };
  }
}

function bruScripts(blocks: Map<string, BruBlock>): Script[] | undefined {
  const scripts: Script[] = [];
  const pre = bruText(blocks.get('script:pre-request'));
  const post = bruText(blocks.get('script:post-response'));
  const tests = bruText(blocks.get('tests'));
  if (pre?.trim()) scripts.push({ type: 'beforeRequest', code: pre, language: 'text/javascript' });
  if (post?.trim()) scripts.push({ type: 'afterResponse', code: post, language: 'text/javascript' });
  if (tests?.trim()) scripts.push({ type: 'tests', code: tests, language: 'text/javascript' });
  return scripts.length ? scripts : undefined;
}

/** `vars:post-response { token: res.body.access_token }` → captures. */
function bruPostVars(block: BruBlock | undefined, warnings: string[], where: string): Capture[] {
  const out: Capture[] = [];
  for (const e of bruDict(block)) {
    if (e.disabled) continue;
    const m = /^res\.(?:body|getBody\(\))((?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[(?:"[^"]*"|'[^']*')\])*)\s*$/.exec(e.value.trim());
    if (m) out.push({ variable: e.key, path: m[1]!.replace(/^\./, '') || '' });
    else warnings.push(`${where}: post-response var ${e.key} = ${e.value} is not a plain res.body path; skipped`);
  }
  return out.filter((c) => c.path);
}

const HTTP_BLOCKS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace', 'connect'];

function bruBody(mode: string | undefined, blocks: Map<string, BruBlock>): HttpBody {
  switch (mode) {
    case undefined:
    case 'none':
      return { type: 'none' };
    case 'json':
    case 'text':
    case 'xml':
      return { type: mode, content: bruText(blocks.get(`body:${mode}`)) ?? '' };
    case 'sparql':
      return { type: 'text', content: bruText(blocks.get('body:sparql')) ?? '' };
    case 'formUrlEncoded':
    case 'form-urlencoded':
      return { type: 'urlencoded', fields: bruDict(blocks.get('body:form-urlencoded')).map(formEntry) };
    case 'multipartForm':
    case 'multipart-form':
      return { type: 'formdata', fields: bruDict(blocks.get('body:multipart-form')).map(formEntry) };
    case 'graphql':
      return { type: 'graphql', content: bruText(blocks.get('body:graphql')) ?? '', variables: bruText(blocks.get('body:graphql:vars')) };
    case 'file': {
      const first = bruDict(blocks.get('body:file'))[0];
      return { type: 'file', content: first ? /@file\((.*)\)/.exec(first.value)?.[1] ?? first.value : '' };
    }
    default:
      return { type: 'text', content: bruText(blocks.get(`body:${mode}`)) ?? '' };
  }
}

function formEntry(e: BruEntry): FormEntry {
  const file = /^@file\((.*)\)$/.exec(e.value.trim());
  return { key: e.key, value: file ? file[1]!.split('|')[0]! : e.value, ...(file ? { type: 'file' as const } : {}), ...(e.disabled ? { disabled: true } : {}) };
}

function bruRequest(file: string, warnings: string[]): Item | undefined {
  const blocks = parseBru(readFileSync(file, 'utf8'));
  const meta = bruDict(blocks.get('meta'));
  const name = dictGet(meta, 'name') ?? basename(file, '.bru');
  const seq = Number(dictGet(meta, 'seq'));
  const order = Number.isFinite(seq) ? seq * 1000 : undefined;
  const type = dictGet(meta, 'type') ?? 'http';
  const methodBlock = HTTP_BLOCKS.find((m) => blocks.has(m));

  if (type === 'grpc' || blocks.has('grpc')) {
    warnings.push(`${file}: gRPC requests in .bru files aren't supported yet; use the OpenCollection YAML export`);
    return undefined;
  }
  if (!methodBlock) {
    warnings.push(`${file}: no request block found; skipped`);
    return undefined;
  }
  const req = bruDict(blocks.get(methodBlock));
  const split = splitQuery(dictGet(req, 'url') ?? '');
  const query = dictKV(bruDict(blocks.get('params:query') ?? blocks.get('query')));
  const http: HttpRequest = {
    type: 'http',
    id: newId(),
    name,
    order,
    method: methodBlock.toUpperCase(),
    url: split.url,
    queryParams: query.length ? query : split.query,
    pathVariables: dictKV(bruDict(blocks.get('params:path'))),
    headers: dictKV(bruDict(blocks.get('headers'))),
    body: bruBody(dictGet(req, 'body'), blocks),
    auth: bruAuth(dictGet(req, 'auth'), blocks),
    settings: {},
    scripts: bruScripts(blocks),
    description: bruText(blocks.get('docs')),
  };
  const captures = bruPostVars(blocks.get('vars:post-response'), warnings, file);
  if (captures.length) http.captures = captures;
  if (blocks.has('vars:pre-request')) warnings.push(`${file}: request-level vars:pre-request aren't supported; skipped`);
  attachHttpScriptCaptures(http);
  return http;
}

function bruFolder(dir: string, warnings: string[]): Folder {
  const blocks = existsSync(join(dir, 'folder.bru')) ? parseBru(readFileSync(join(dir, 'folder.bru'), 'utf8')) : new Map<string, BruBlock>();
  const meta = bruDict(blocks.get('meta'));
  const seq = Number(dictGet(meta, 'seq'));
  const auth = bruDict(blocks.get('auth'));
  const vars = dictKV(bruDict(blocks.get('vars:pre-request')));
  const headers = dictKV(bruDict(blocks.get('headers')));
  return {
    type: 'folder',
    id: newId(),
    name: dictGet(meta, 'name') ?? basename(dir),
    order: Number.isFinite(seq) ? seq * 1000 : undefined,
    auth: bruAuth(dictGet(auth, 'mode'), blocks),
    variables: vars.length ? vars : undefined,
    headers: headers.length ? headers : undefined,
    scripts: bruScripts(blocks),
    description: bruText(blocks.get('docs')),
    items: bruItems(dir, warnings),
  };
}

function bruItems(dir: string, warnings: string[]): Item[] {
  const items: Item[] = [];
  for (const entry of listDir(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'environments' || entry.startsWith('.') || entry === 'node_modules') continue;
      items.push(bruFolder(full, warnings));
    } else if (entry.endsWith('.bru') && entry !== 'collection.bru' && entry !== 'folder.bru') {
      const item = bruRequest(full, warnings);
      if (item) items.push(item);
    }
  }
  return sortItems(items);
}

export function importBruCollection(dir: string, warnings: string[] = []): { collection: Collection; environments: Environment[] } {
  let name = basename(dir);
  try {
    name = str((JSON.parse(readFileSync(join(dir, 'bruno.json'), 'utf8')) as Obj).name) ?? name;
  } catch {
    warnings.push(`${dir}/bruno.json: not valid JSON`);
  }
  const blocks = existsSync(join(dir, 'collection.bru')) ? parseBru(readFileSync(join(dir, 'collection.bru'), 'utf8')) : new Map<string, BruBlock>();
  const auth = bruDict(blocks.get('auth'));
  const headers = dictKV(bruDict(blocks.get('headers')));
  const collection: Collection = {
    id: newId(),
    name,
    variables: dictKV(bruDict(blocks.get('vars:pre-request'))),
    auth: bruAuth(dictGet(auth, 'mode'), blocks),
    headers: headers.length ? headers : undefined,
    scripts: bruScripts(blocks),
    description: bruText(blocks.get('docs')),
    items: bruItems(dir, warnings),
    importedFrom: dir,
  };
  const environments: Environment[] = [];
  const envDir = join(dir, 'environments');
  if (existsSync(envDir)) {
    for (const f of listDir(envDir)) {
      if (!f.endsWith('.bru')) continue;
      environments.push(bruEnvironment(join(envDir, f)));
    }
  }
  return { collection, environments };
}

export function bruEnvironment(file: string): Environment {
  const blocks = parseBru(readFileSync(file, 'utf8'));
  const values: Environment['values'] = bruDict(blocks.get('vars')).map((e) => ({ key: e.key, value: e.value, enabled: !e.disabled, type: 'default' }));
  // `vars:secret [ a, b ]` names secrets whose values Bruno keeps outside the file.
  for (const line of blocks.get('vars:secret')?.lines ?? []) {
    for (const raw of line.split(',')) {
      const key = raw.trim().replace(/^~/, '');
      if (key && !values.some((v) => v.key === key)) values.push({ key, value: '', enabled: !raw.trim().startsWith('~'), type: 'secret' });
    }
  }
  return { id: newId(), name: basename(file, '.bru'), values };
}

// ===========================================================================
// OpenCollection YAML
// ===========================================================================

function readYamlFile(file: string): Obj {
  const doc = parseYaml(readFileSync(file, 'utf8'));
  return doc && typeof doc === 'object' ? (doc as Obj) : {};
}

function ocKVs(v: unknown): KV[] {
  return arr(v).map((x) => ({
    key: String(x.name ?? x.key ?? ''),
    value: x.value === undefined || x.value === null ? '' : String(x.value),
    ...(x.disabled || x.enabled === false ? { disabled: true } : {}),
    ...(x.description ? { description: String(x.description) } : {}),
  }));
}

function ocAuth(v: unknown): Auth | undefined {
  if (v === undefined || v === null || v === 'inherit') return undefined;
  if (v === 'none') return { type: 'noauth' };
  if (typeof v !== 'object') return undefined;
  const a = v as Obj;
  const type = String(a.type ?? a.mode ?? 'none');
  if (type === 'inherit') return undefined;
  if (type === 'none') return { type: 'noauth' };
  // Credentials may be flat ({ type, token }) or nested ({ type, bearer: { token } }).
  const src = (a[type] && typeof a[type] === 'object' ? a[type] : a) as Obj;
  const get = (k: string) => str(src[k]) ?? '';
  switch (type) {
    case 'bearer':
      return { type, credentials: [{ key: 'token', value: get('token') }] };
    case 'basic':
      return { type, credentials: [{ key: 'username', value: get('username') }, { key: 'password', value: get('password') }] };
    case 'apikey':
      return { type, credentials: [{ key: 'key', value: get('key') }, { key: 'value', value: get('value') }, { key: 'in', value: /query/i.test(get('placement')) ? 'query' : 'header' }] };
    default:
      return { type, credentials: Object.entries(src).filter(([k]) => k !== 'type').map(([key, value]) => ({ key, value: String(value ?? '') })) };
  }
}

function ocScripts(runtime: unknown): Script[] | undefined {
  const scripts = arr((runtime as Obj | undefined)?.scripts)
    .map((s) => ({
      type: s.type === 'before-request' ? 'beforeRequest' : s.type === 'after-response' ? 'afterResponse' : String(s.type ?? 'tests'),
      code: String(s.code ?? ''),
      language: 'text/javascript',
    }))
    .filter((s) => s.code.trim());
  return scripts.length ? scripts : undefined;
}

function ocBody(v: unknown): HttpBody {
  if (!v || typeof v !== 'object') return { type: 'none' };
  const b = v as Obj;
  const type = String(b.type ?? 'none');
  const data = b.data;
  const fields = (): FormEntry[] =>
    arr(data).map((f) => ({
      key: String(f.name ?? f.key ?? ''),
      value: String(f.value ?? ''),
      ...(f.type === 'file' ? { type: 'file' as const } : {}),
      ...(f.disabled ? { disabled: true } : {}),
    }));
  switch (type) {
    case 'none':
      return { type: 'none' };
    case 'json':
    case 'text':
    case 'xml':
      return { type, content: typeof data === 'string' ? data : JSON.stringify(data ?? '', null, 2) };
    case 'form-urlencoded':
      return { type: 'urlencoded', fields: fields() };
    case 'multipart-form':
      return { type: 'formdata', fields: fields() };
    case 'graphql': {
      if (data && typeof data === 'object') {
        const g = data as Obj;
        return { type: 'graphql', content: str(g.query) ?? '', variables: typeof g.variables === 'string' ? g.variables : g.variables ? JSON.stringify(g.variables, null, 2) : undefined };
      }
      return { type: 'graphql', content: str(data) ?? '' };
    }
    default:
      return { type: 'text', content: str(data) ?? '' };
  }
}

function ocParams(v: unknown): { query: KV[]; path: KV[] } {
  if (Array.isArray(v)) {
    const all = arr(v);
    return { query: ocKVs(all.filter((p) => p.type !== 'path')), path: ocKVs(all.filter((p) => p.type === 'path')) };
  }
  const o = (v ?? {}) as Obj;
  return { query: ocKVs(o.query), path: ocKVs(o.path) };
}

function ocRequest(file: string, warnings: string[]): Item | undefined {
  const doc = readYamlFile(file);
  const info = (doc.info ?? {}) as Obj;
  const name = str(info.name) ?? basename(file).replace(/\.ya?ml$/, '');
  const seq = Number(info.seq);
  const order = Number.isFinite(seq) ? seq * 1000 : undefined;
  const type = str(info.type) ?? (doc.grpc ? 'grpc' : 'http');

  if (type === 'grpc') {
    const g = (doc.grpc ?? {}) as Obj;
    const messages = arr(g.message).map((m) => String(m.message ?? m.content ?? '{}'));
    const settings = (doc.settings ?? {}) as Obj;
    const req: GrpcRequest = {
      type: 'grpc',
      id: newId(),
      name,
      order,
      url: str(g.url) ?? '',
      methodPath: str(g.method) ?? '',
      // Several messages (client/bidi streams) become a JSON array.
      message: messages.length > 1 ? `[\n${messages.join(',\n')}\n]` : (messages[0] ?? '{}'),
      metadata: ocKVs(g.metadata),
      auth: ocAuth(g.auth),
      settings: /^grpcs:/i.test(str(g.url) ?? '') ? { secureConnection: true } : {},
      scripts: ocScripts(doc.runtime),
    };
    if (typeof settings.timeout === 'number' && settings.timeout > 0) req.settings.connectionTimeout = settings.timeout;
    return req;
  }
  if (type !== 'http' && type !== 'graphql') {
    warnings.push(`${file}: ${type} requests aren't supported; skipped`);
    return undefined;
  }
  const h = (doc.http ?? doc.graphql ?? {}) as Obj;
  const split = splitQuery(str(h.url) ?? '');
  const params = ocParams(h.params);
  const s = (doc.settings ?? {}) as Obj;
  const req: HttpRequest = {
    type: 'http',
    id: newId(),
    name,
    order,
    method: (str(h.method) ?? (type === 'graphql' ? 'POST' : 'GET')).toUpperCase(),
    url: split.url,
    queryParams: params.query.length ? params.query : split.query,
    pathVariables: params.path,
    headers: ocKVs(h.headers),
    body: ocBody(h.body),
    auth: ocAuth(h.auth),
    settings: {
      ...(s.followRedirects === false ? { followRedirects: false } : {}),
      ...(typeof s.maxRedirects === 'number' ? { maxRedirects: s.maxRedirects } : {}),
      ...(typeof s.timeout === 'number' && s.timeout > 0 ? { timeout: s.timeout } : {}),
    },
    scripts: ocScripts(doc.runtime),
    description: typeof doc.docs === 'string' ? doc.docs : str((doc.docs as Obj | undefined)?.content),
  };
  attachHttpScriptCaptures(req);
  return req;
}

function ocFolder(dir: string, warnings: string[]): Folder {
  const def = existsSync(join(dir, 'folder.yml')) ? readYamlFile(join(dir, 'folder.yml')) : {};
  const info = (def.info ?? {}) as Obj;
  const request = (def.request ?? {}) as Obj;
  const seq = Number(info.seq);
  const headers = ocKVs(request.headers);
  const variables = ocKVs(request.variables ?? request.vars);
  return {
    type: 'folder',
    id: newId(),
    name: str(info.name) ?? basename(dir),
    order: Number.isFinite(seq) ? seq * 1000 : undefined,
    auth: ocAuth(request.auth),
    headers: headers.length ? headers : undefined,
    variables: variables.length ? variables : undefined,
    scripts: ocScripts(def.runtime ?? request),
    description: typeof def.docs === 'string' ? def.docs : str((def.docs as Obj | undefined)?.content),
    items: ocItems(dir, warnings),
  };
}

function ocItems(dir: string, warnings: string[]): Item[] {
  const items: Item[] = [];
  for (const entry of listDir(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'environments' || entry.startsWith('.')) continue;
      items.push(ocFolder(full, warnings));
    } else if (/\.ya?ml$/.test(entry) && !/^(opencollection|folder)\.ya?ml$/.test(entry)) {
      const item = ocRequest(full, warnings);
      if (item) items.push(item);
    }
  }
  return sortItems(items);
}

export function importOpenCollection(dir: string, warnings: string[] = []): { collection: Collection; environments: Environment[] } {
  const rootFile = existsSync(join(dir, 'opencollection.yml')) ? join(dir, 'opencollection.yml') : join(dir, 'opencollection.yaml');
  const root = readYamlFile(rootFile);
  const info = (root.info ?? {}) as Obj;
  const request = (root.request ?? {}) as Obj;
  const headers = ocKVs(request.headers);
  const collection: Collection = {
    id: newId(),
    name: str(info.name) ?? basename(dir),
    description: str((root.docs as Obj | undefined)?.content) ?? (typeof root.docs === 'string' ? root.docs : undefined),
    variables: ocKVs(request.variables ?? request.vars ?? root.variables),
    auth: ocAuth(request.auth),
    headers: headers.length ? headers : undefined,
    items: ocItems(dir, warnings),
    importedFrom: dir,
  };
  const environments: Environment[] = [];
  const envDir = join(dir, 'environments');
  if (existsSync(envDir)) for (const f of listDir(envDir)) if (/\.ya?ml$/.test(f)) environments.push(ocEnvironment(join(envDir, f)));
  return { collection, environments };
}

export function ocEnvironment(file: string): Environment {
  const doc = readYamlFile(file);
  return {
    id: newId(),
    name: str(doc.name) ?? basename(file).replace(/\.ya?ml$/, ''),
    values: arr(doc.variables).map((v) => ({
      key: String(v.name ?? v.key ?? ''),
      value: v.value === undefined || v.value === null ? '' : String(v.value),
      enabled: !(v.disabled || v.enabled === false),
      type: v.secret ? 'secret' : 'default',
    })),
  };
}

/** Bruno's environment JSON export: { name, variables: [{ name, value, enabled, secret }] }. */
export function isBrunoEnvironmentJson(doc: unknown): boolean {
  const d = doc as Obj | undefined;
  return !!d && typeof d.name === 'string' && Array.isArray(d.variables) && !Array.isArray(d.values);
}

export function brunoEnvironmentJson(doc: unknown): Environment {
  const d = doc as Obj;
  return {
    id: newId(),
    name: String(d.name),
    values: arr(d.variables).map((v) => ({
      key: String(v.name ?? ''),
      value: v.value === undefined || v.value === null ? '' : String(v.value),
      enabled: v.enabled !== false,
      type: v.secret ? 'secret' : 'default',
    })),
  };
}
