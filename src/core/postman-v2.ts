/**
 * Postman Collection v2.0 / v2.1 JSON (`*.postman_collection.json`) and
 * environment JSON (`*.postman_environment.json`) import/export.
 *
 * v2.x has no gRPC request type, so gRPC requests are skipped on export.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Auth,
  type Collection,
  type Environment,
  type Folder,
  type FormEntry,
  type HttpBody,
  type HttpRequest,
  type Item,
  type KV,
  type Script,
  newId,
  splitQuery,
} from './model.js';
import { attachHttpScriptCaptures, sanitizeFileName } from './postman-v3.js';
import { httpCapturesToScript } from './captures.js';

type Obj = Record<string, unknown>;

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x): x is Obj => !!x && typeof x === 'object') : []);

/** v2 descriptions are either strings or { content, type }. */
function description(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return v || undefined;
  return str((v as Obj).content);
}

export function isPostmanV2Collection(doc: unknown): boolean {
  const d = doc as Obj | undefined;
  const schema = str((d?.info as Obj | undefined)?.schema) ?? '';
  return !!d && Array.isArray(d.item) && (/collection\/v2/.test(schema) || !!(d.info as Obj | undefined)?.name);
}

export function isPostmanV2Environment(doc: unknown): boolean {
  const d = doc as Obj | undefined;
  return !!d && Array.isArray(d.values) && (d._postman_variable_scope === 'environment' || typeof d.name === 'string');
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function kvs(v: unknown): KV[] {
  return arr(v).map((x) => {
    const kv: KV = { key: String(x.key ?? ''), value: x.value === undefined || x.value === null ? '' : String(x.value) };
    const d = description(x.description);
    if (d) kv.description = d;
    if (x.disabled) kv.disabled = true;
    return kv;
  });
}

/** { type: 'bearer', bearer: [{ key: 'token', value }] } → { type, credentials } */
export function v2Auth(v: unknown): Auth | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const a = v as Obj;
  const type = str(a.type);
  if (!type) return undefined;
  const params = a[type];
  const credentials = arr(params).map((p) => ({ key: String(p.key ?? ''), value: p.value === undefined || p.value === null ? '' : typeof p.value === 'string' ? p.value : JSON.stringify(p.value) }));
  return { type, credentials };
}

function v2Scripts(events: unknown): Script[] | undefined {
  const scripts = arr(events)
    .map((e) => {
      const script = (e.script ?? {}) as Obj;
      const exec = script.exec;
      const code = Array.isArray(exec) ? exec.join('\n') : String(exec ?? '');
      return { type: e.listen === 'prerequest' ? 'beforeRequest' : 'afterResponse', code, language: 'text/javascript' };
    })
    .filter((s) => s.code.trim());
  return scripts.length ? scripts : undefined;
}

function v2Body(v: unknown): HttpBody {
  if (!v || typeof v !== 'object') return { type: 'none' };
  const b = v as Obj;
  if (b.disabled) return { type: 'none' };
  switch (b.mode) {
    case 'raw': {
      const lang = str(((b.options as Obj | undefined)?.raw as Obj | undefined)?.language) ?? 'text';
      const type = (['json', 'xml', 'html', 'javascript'].includes(lang) ? lang : 'text') as HttpBody['type'];
      return { type, content: str(b.raw) ?? '' };
    }
    case 'urlencoded':
    case 'formdata': {
      const fields: FormEntry[] = arr(b[b.mode as string]).map((f) => ({
        key: String(f.key ?? ''),
        value: String(f.type === 'file' ? (Array.isArray(f.src) ? f.src[0] ?? '' : (f.src ?? '')) : (f.value ?? '')),
        ...(f.type === 'file' ? { type: 'file' as const } : {}),
        ...(f.disabled ? { disabled: true } : {}),
        ...(description(f.description) ? { description: description(f.description) } : {}),
      }));
      return { type: b.mode, fields };
    }
    case 'file':
      return { type: 'file', content: str((b.file as Obj | undefined)?.src) ?? '' };
    case 'graphql': {
      const g = (b.graphql ?? {}) as Obj;
      return { type: 'graphql', content: str(g.query) ?? '', variables: str(g.variables) };
    }
    default:
      return { type: 'none' };
  }
}

function v2Url(v: unknown): { url: string; query: KV[]; pathVariables: KV[] } {
  if (typeof v === 'string') {
    const s = splitQuery(v);
    return { url: s.url, query: s.query, pathVariables: [] };
  }
  const u = (v ?? {}) as Obj;
  let raw = str(u.raw);
  if (!raw) {
    // Rebuild from parts when `raw` is missing.
    const host = Array.isArray(u.host) ? u.host.join('.') : (str(u.host) ?? '');
    const path = Array.isArray(u.path) ? u.path.join('/') : (str(u.path) ?? '');
    raw = `${u.protocol ? `${u.protocol}://` : ''}${host}${u.port ? `:${u.port}` : ''}${path ? `/${path}` : ''}`;
  }
  const s = splitQuery(raw);
  // The structured list also carries disabled params, which `raw` omits.
  const query = Array.isArray(u.query) ? kvs(u.query) : s.query;
  return { url: s.url, query, pathVariables: kvs(u.variable) };
}

function v2Request(item: Obj): HttpRequest {
  const r = (typeof item.request === 'string' ? { url: item.request, method: 'GET' } : (item.request ?? {})) as Obj;
  const { url, query, pathVariables } = v2Url(r.url);
  const req: HttpRequest = {
    type: 'http',
    id: newId(),
    name: str(item.name) ?? 'request',
    method: (str(r.method) ?? 'GET').toUpperCase(),
    url,
    queryParams: query,
    pathVariables,
    headers: kvs(r.header),
    body: v2Body(r.body),
    auth: v2Auth(r.auth),
    settings: {},
    scripts: v2Scripts(item.event),
    description: description(r.description) ?? description(item.description),
  };
  const po = item.protocolProfileBehavior as Obj | undefined;
  if (po) {
    if (po.followRedirects === false) req.settings.followRedirects = false;
    if (typeof po.maxRedirects === 'number') req.settings.maxRedirects = po.maxRedirects;
    if (po.strictSSL === false) req.settings.strictSSL = false;
  }
  if (Array.isArray(item.response) && item.response.length) req.examples = item.response;
  attachHttpScriptCaptures(req);
  return req;
}

function v2Items(items: unknown, warnings: string[]): Item[] {
  return arr(items).map((it, i): Item => {
    const order = (i + 1) * 1000;
    if (Array.isArray(it.item)) {
      const folder: Folder = {
        type: 'folder',
        id: newId(),
        name: str(it.name) ?? 'folder',
        order,
        description: description(it.description),
        variables: it.variable ? kvs(it.variable) : undefined,
        auth: v2Auth(it.auth),
        scripts: v2Scripts(it.event),
        items: v2Items(it.item, warnings),
      };
      return folder;
    }
    return { ...v2Request(it), order };
  });
}

export function importPostmanV2Collection(doc: unknown, source: string, warnings: string[] = []): Collection {
  const d = doc as Obj;
  const info = (d.info ?? {}) as Obj;
  const variables = kvs(d.variable);
  const seen = new Map<string, number>();
  for (const v of variables) seen.set(v.key, (seen.get(v.key) ?? 0) + 1);
  for (const [k, n] of seen) if (n > 1) warnings.push(`collection variable "${k}" is defined ${n} times; the last one wins`);
  return {
    id: newId(),
    name: str(info.name) ?? 'Postman collection',
    description: description(info.description),
    variables,
    auth: v2Auth(d.auth),
    scripts: v2Scripts(d.event),
    items: v2Items(d.item, warnings),
    importedFrom: source,
    extra: { postmanId: info._postman_id },
  };
}

export function importPostmanV2Environment(doc: unknown): Environment {
  const d = doc as Obj;
  return {
    id: newId(),
    name: str(d.name) ?? 'environment',
    values: arr(d.values).map((v) => ({
      key: String(v.key ?? ''),
      value: v.value === undefined || v.value === null ? '' : String(v.value),
      enabled: v.enabled === undefined ? true : Boolean(v.enabled),
      type: str(v.type) ?? 'default',
    })),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function kvOut(kv: KV): Obj {
  return { key: kv.key, value: kv.value, ...(kv.disabled ? { disabled: true } : {}), ...(kv.description ? { description: kv.description } : {}) };
}

function authOut(a: Auth | undefined): Obj | undefined {
  if (!a) return undefined;
  if (a.type === 'inherit') return undefined;
  return { type: a.type, [a.type]: (a.credentials ?? []).map((c) => ({ key: c.key, value: c.value, type: 'string' })) };
}

function scriptsOut(scripts: Script[] | undefined): Obj[] | undefined {
  if (!scripts?.length) return undefined;
  return scripts.map((s) => ({
    listen: /before|pre/i.test(s.type) ? 'prerequest' : 'test',
    script: { type: 'text/javascript', exec: s.code.split('\n') },
  }));
}

function urlOut(r: HttpRequest): Obj {
  const enabled = r.queryParams.filter((q) => !q.disabled && q.key);
  const raw = r.url + (enabled.length ? `?${enabled.map((q) => (q.value ? `${q.key}=${q.value}` : q.key)).join('&')}` : '');
  const out: Obj = { raw };
  const m = /^([a-z]+):\/\/([^/]*)(\/.*)?$/i.exec(r.url) ?? /^()([^/]*)(\/.*)?$/.exec(r.url);
  if (m) {
    if (m[1]) out.protocol = m[1];
    out.host = m[2]!.split('.');
    if (m[3]) out.path = m[3].replace(/^\//, '').split('/');
  }
  if (r.queryParams.length) out.query = r.queryParams.map(kvOut);
  if (r.pathVariables.length) out.variable = r.pathVariables.map(kvOut);
  return out;
}

function bodyOut(b: HttpBody): Obj | undefined {
  switch (b.type) {
    case 'none':
      return undefined;
    case 'urlencoded':
    case 'formdata':
      return {
        mode: b.type,
        [b.type]: (b.fields ?? []).map((f) =>
          f.type === 'file'
            ? { key: f.key, type: 'file', src: f.value, ...(f.disabled ? { disabled: true } : {}) }
            : { key: f.key, value: f.value, type: 'text', ...(f.disabled ? { disabled: true } : {}) },
        ),
      };
    case 'file':
      return { mode: 'file', file: { src: b.content ?? '' } };
    case 'graphql':
      return { mode: 'graphql', graphql: { query: b.content ?? '', variables: b.variables ?? '' } };
    default:
      return { mode: 'raw', raw: b.content ?? '', options: { raw: { language: b.type } } };
  }
}

function itemsOut(items: Item[], skipped: string[], path: string[]): Obj[] {
  const out: Obj[] = [];
  for (const it of [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (it.type === 'folder') {
      out.push({
        name: it.name,
        ...(it.description ? { description: it.description } : {}),
        ...(it.variables?.length ? { variable: it.variables.map(kvOut) } : {}),
        ...(authOut(it.auth) ? { auth: authOut(it.auth) } : {}),
        ...(scriptsOut(it.scripts) ? { event: scriptsOut(it.scripts) } : {}),
        item: itemsOut(it.items, skipped, [...path, it.name]),
      });
      continue;
    }
    if (it.type !== 'http') {
      skipped.push([...path, it.name].join('/'));
      continue;
    }
    const own = it.captures?.filter((c) => c.source !== 'script') ?? [];
    const scripts = [...(it.scripts ?? []), ...(own.length ? [httpCapturesToScript(own)] : [])];
    const behavior: Obj = {};
    if (it.settings.followRedirects === false) behavior.followRedirects = false;
    if (it.settings.maxRedirects !== undefined) behavior.maxRedirects = it.settings.maxRedirects;
    if (it.settings.strictSSL === false) behavior.strictSSL = false;
    out.push({
      name: it.name,
      ...(scriptsOut(scripts) ? { event: scriptsOut(scripts) } : {}),
      ...(Object.keys(behavior).length ? { protocolProfileBehavior: behavior } : {}),
      request: {
        method: it.method,
        header: it.headers.map(kvOut),
        ...(bodyOut(it.body) ? { body: bodyOut(it.body) } : {}),
        url: urlOut(it),
        ...(authOut(it.auth) ? { auth: authOut(it.auth) } : {}),
        ...(it.description ? { description: it.description } : {}),
      },
      response: it.examples ?? [],
    });
  }
  return out;
}

/** Writes `<dir>/<name>.postman_collection.json`; returns the file and the gRPC/other requests left out. */
export function exportPostmanV2Collection(c: Collection, dir: string): { file: string; skipped: string[] } {
  const skipped: string[] = [];
  const doc = {
    info: {
      ...(typeof c.extra?.postmanId === 'string' ? { _postman_id: c.extra.postmanId } : {}),
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: itemsOut(c.items, skipped, []),
    ...(authOut(c.auth) ? { auth: authOut(c.auth) } : {}),
    ...(scriptsOut(c.scripts) ? { event: scriptsOut(c.scripts) } : {}),
    variable: c.variables.map((v) => ({ key: v.key, value: v.value, ...(v.disabled ? { disabled: true } : {}) })),
  };
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sanitizeFileName(c.name)}.postman_collection.json`);
  writeFileSync(file, `${JSON.stringify(doc, null, '\t')}\n`);
  return { file, skipped };
}

export function exportPostmanV2Environment(e: Environment, dir: string, includeSecrets = false): string {
  const doc = {
    name: e.name,
    values: e.values.map((v) => ({
      key: v.key,
      value: v.type === 'secret' && !includeSecrets ? '' : v.value,
      type: v.type ?? 'default',
      enabled: v.enabled ?? true,
    })),
    _postman_variable_scope: 'environment',
  };
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sanitizeFileName(e.name)}.postman_environment.json`);
  writeFileSync(file, `${JSON.stringify(doc, null, '\t')}\n`);
  return file;
}
