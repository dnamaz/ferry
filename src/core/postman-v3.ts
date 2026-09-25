/**
 * Postman Collection v3 ("git-native" YAML) reader/writer.
 *
 *   postman/collections/<collection>/
 *     .resources/definition.yaml      ($kind: collection — metadata, variables, auth)
 *     <request>.request.yaml          ($kind: grpc-request | http-request | ...)
 *     <folder>/
 *       .resources/definition.yaml
 *       <request>.request.yaml
 *   postman/environments/<name>.environment.yaml
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Document, parse, visit, Scalar } from 'yaml';
import {
  type Auth,
  type Collection,
  type Environment,
  type Folder,
  type GrpcRequest,
  type Item,
  type KV,
  type Script,
  newId,
  sortItems,
} from './model.js';
import { capturesToScript, httpCapturesToScript, httpScriptCaptures, scriptToCaptures } from './captures.js';
import { type FormEntry, type HttpBody, type HttpRequest, splitQuery } from './model.js';
export { normalizeMethodPath } from '../grpc/schema.js';

const REQUEST_RE = /\.request\.ya?ml$/i;
const ENV_RE = /\.environment\.ya?ml$/i;

export interface ImportResult {
  collections: Collection[];
  environments: Environment[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Accepts any of:
 *   - a workspace root containing postman/collections and/or postman/environments
 *   - a `collections` directory (each subdirectory is a collection)
 *   - a single collection directory
 *   - a single *.environment.yaml file
 */
export function importV3(path: string): ImportResult {
  const result: ImportResult = { collections: [], environments: [], warnings: [] };
  if (!existsSync(path)) throw new Error(`Path not found: ${path}`);

  if (statSync(path).isFile()) {
    if (ENV_RE.test(path)) {
      result.environments.push(readEnvironment(path));
      return result;
    }
    if (REQUEST_RE.test(path)) {
      // A lone request: wrap it in a collection named after its directory.
      const col: Collection = { id: newId(), name: basename(dirname(path)), variables: [], items: [] };
      col.items.push(readRequest(path, result.warnings));
      col.importedFrom = path;
      result.collections.push(col);
      return result;
    }
    throw new Error(`Not a v3 request or environment file: ${path}`);
  }

  const postmanDir = existsSync(join(path, 'postman')) ? join(path, 'postman') : undefined;
  let collectionsDir: string | undefined;
  let environmentsDir: string | undefined;

  if (postmanDir) {
    collectionsDir = join(postmanDir, 'collections');
    environmentsDir = join(postmanDir, 'environments');
  } else if (basename(path) === 'postman') {
    collectionsDir = join(path, 'collections');
    environmentsDir = join(path, 'environments');
  } else if (basename(path) === 'environments') {
    environmentsDir = path;
  } else if (isCollectionRoot(path)) {
    result.collections.push(readCollection(path, result.warnings));
    const siblingEnvs = join(dirname(path), '..', 'environments');
    if (basename(dirname(path)) === 'collections' && existsSync(siblingEnvs)) environmentsDir = siblingEnvs;
  } else {
    collectionsDir = path;
    const siblingEnvs = join(path, '..', 'environments');
    if (existsSync(siblingEnvs)) environmentsDir = siblingEnvs;
  }

  if (collectionsDir && existsSync(collectionsDir)) {
    for (const entry of listDir(collectionsDir)) {
      const full = join(collectionsDir, entry);
      if (entry.startsWith('.') || !statSync(full).isDirectory()) continue;
      result.collections.push(readCollection(full, result.warnings));
    }
  }
  if (environmentsDir && existsSync(environmentsDir)) {
    for (const entry of listDir(environmentsDir)) {
      if (ENV_RE.test(entry)) {
        try {
          result.environments.push(readEnvironment(join(environmentsDir, entry)));
        } catch (err) {
          result.warnings.push(`${entry}: ${(err as Error).message}`);
        }
      }
    }
  }

  if (result.collections.length === 0 && result.environments.length === 0) {
    throw new Error(`No v3 collections or environments found under ${path}`);
  }
  return result;
}

function listDir(dir: string): string[] {
  return readdirSync(dir).sort();
}

function isCollectionRoot(dir: string): boolean {
  if (existsSync(join(dir, '.resources', 'definition.yaml')) || existsSync(join(dir, '.resources', 'definition.yml'))) {
    return true;
  }
  return listDir(dir).some((f) => REQUEST_RE.test(f));
}

function readYaml(file: string): Record<string, unknown> {
  const doc = parse(readFileSync(file, 'utf8'));
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('expected a YAML mapping');
  return doc as Record<string, unknown>;
}

function readDefinition(dir: string): Record<string, unknown> {
  for (const name of ['definition.yaml', 'definition.yml']) {
    const file = join(dir, '.resources', name);
    if (existsSync(file)) return readYaml(file);
  }
  return {};
}

function readCollection(dir: string, warnings: string[]): Collection {
  const def = readDefinition(dir);
  const { $kind: _kind, name, description, variables, auth, scripts, order: _order, ...extra } = def;
  return {
    id: newId(),
    name: str(name) ?? basename(dir),
    description: str(description),
    variables: kvs(variables),
    auth: authOf(auth),
    scripts: scriptsOf(scripts),
    items: readItems(dir, warnings),
    extra: nonEmpty(extra),
    importedFrom: dir,
  };
}

function readItems(dir: string, warnings: string[]): Item[] {
  const items: Item[] = [];
  for (const entry of listDir(dir)) {
    const full = join(dir, entry);
    if (entry === '.resources' || entry.endsWith('.resources')) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry.startsWith('.')) continue;
      items.push(readFolder(full, warnings));
    } else if (REQUEST_RE.test(entry)) {
      try {
        items.push(readRequest(full, warnings));
      } catch (err) {
        warnings.push(`${full}: ${(err as Error).message}`);
      }
    }
  }
  return sortItems(items);
}

function readFolder(dir: string, warnings: string[]): Folder {
  const def = readDefinition(dir);
  const { $kind: _kind, name, description, variables, auth, scripts, order, ...extra } = def;
  return {
    type: 'folder',
    id: newId(),
    name: str(name) ?? basename(dir),
    order: num(order),
    description: str(description),
    variables: variables ? kvs(variables) : undefined,
    auth: authOf(auth),
    scripts: scriptsOf(scripts),
    items: readItems(dir, warnings),
    extra: nonEmpty(extra),
  };
}

function readRequest(file: string, warnings: string[]): Item {
  const doc = readYaml(file);
  const stem = basename(file).replace(REQUEST_RE, '');
  const kind = str(doc.$kind);
  const name = str(doc.name) ?? stem;
  const order = num(doc.order);

  if (kind === 'http-request') return readHttpRequest(doc, name, order);
  if (kind !== 'grpc-request') {
    if (!kind) warnings.push(`${file}: missing $kind, kept as-is`);
    return { type: 'other', id: newId(), name, order, kind: kind ?? 'unknown', raw: doc };
  }

  const {
    $kind: _k,
    name: _n,
    order: _o,
    url,
    methodPath,
    methodDescriptor,
    message,
    metadata,
    auth,
    settings,
    scripts,
    ...extra
  } = doc;

  const req: GrpcRequest = {
    type: 'grpc',
    id: newId(),
    name,
    order,
    url: str(url) ?? '',
    methodPath: str(methodPath) ?? methodPathFromDescriptor(methodDescriptor) ?? '',
    methodDescriptor: methodDescriptor === undefined ? undefined : typeof methodDescriptor === 'string' ? methodDescriptor : JSON.stringify(methodDescriptor),
    message: messageContent(message),
    metadata: kvs(metadata),
    auth: authOf(auth),
    settings: (settings && typeof settings === 'object' ? settings : {}) as GrpcRequest['settings'],
    scripts: scriptsOf(scripts),
    extra: nonEmpty(extra),
  };
  // Pure `pm.environment.set(..., pm.response.messages.idx(n).data...)` scripts become captures.
  if (req.scripts) {
    const kept: Script[] = [];
    for (const script of req.scripts) {
      const captures = scriptToCaptures(script);
      if (captures) req.captures = [...(req.captures ?? []), ...captures];
      else kept.push(script);
    }
    req.scripts = kept.length ? kept : undefined;
  }
  return req;
}

function readHttpRequest(doc: Record<string, unknown>, name: string, order: number | undefined): HttpRequest {
  const { $kind: _k, name: _n, order: _o, url, method, headers, queryParams, pathVariables, body, auth, settings, scripts, description, ...extra } = doc;
  const split = splitQuery(str(url) ?? '');
  const query = kvs(queryParams);
  const req: HttpRequest = {
    type: 'http',
    id: newId(),
    name,
    order,
    method: (str(method) ?? 'GET').toUpperCase(),
    url: split.url,
    // Params listed separately win over a query string embedded in the URL.
    queryParams: query.length ? query : split.query,
    pathVariables: kvs(pathVariables),
    headers: kvs(headers),
    body: v3Body(body),
    auth: authOf(auth),
    settings: settings && typeof settings === 'object' ? (settings as HttpRequest['settings']) : {},
    scripts: scriptsOf(scripts),
    description: str(description),
    extra: nonEmpty(extra),
  };
  attachHttpScriptCaptures(req);
  return req;
}

/** Turns capture-shaped post-response scripts into captures (see httpScriptCaptures). */
export function attachHttpScriptCaptures(req: HttpRequest): void {
  if (!req.scripts) return;
  const kept: Script[] = [];
  for (const script of req.scripts) {
    if (!/after-?response|^test$|tests/i.test(script.type)) {
      kept.push(script);
      continue;
    }
    const { captures, exact } = httpScriptCaptures(script.code);
    if (exact) req.captures = [...(req.captures ?? []), ...captures];
    else {
      if (captures.length) req.captures = [...(req.captures ?? []), ...captures.map((c) => ({ ...c, source: 'script' as const }))];
      kept.push(script);
    }
  }
  req.scripts = kept.length ? kept : undefined;
}

function v3Body(v: unknown): HttpBody {
  if (!v || typeof v !== 'object') return { type: 'none' };
  const b = v as Record<string, unknown>;
  const type = String(b.type ?? 'none');
  const content = b.content;
  if (type === 'formdata' || type === 'urlencoded') {
    const fields: FormEntry[] = (Array.isArray(content) ? content : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({
        key: String(x.key ?? ''),
        value: String(x.type === 'file' ? (x.src ?? x.value ?? '') : (x.value ?? '')),
        ...(x.type === 'file' ? { type: 'file' as const } : {}),
        ...(x.disabled ? { disabled: true } : {}),
        ...(x.description ? { description: String(x.description) } : {}),
      }));
    return { type, fields };
  }
  const known = ['none', 'json', 'text', 'xml', 'html', 'javascript', 'file', 'graphql'];
  return { type: (known.includes(type) ? type : 'text') as HttpBody['type'], content: typeof content === 'string' ? content : content === undefined ? undefined : JSON.stringify(content, null, 2) };
}

/** Best effort: methodDescriptor is opaque, but often carries the full method name. */
function methodPathFromDescriptor(descriptor: unknown): string | undefined {
  if (!descriptor) return undefined;
  let value: unknown = descriptor;
  if (typeof descriptor === 'string') {
    try {
      value = JSON.parse(descriptor);
    } catch {
      return /^[\w.]+[/.]\w+$/.test(descriptor) ? descriptor : undefined;
    }
  }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const path = str(v.path) ?? str(v.methodPath) ?? str(v.fullName) ?? str(v.name);
    if (path) return path;
    const service = str(v.service) ?? str(v.serviceName);
    const method = str(v.method) ?? str(v.methodName);
    if (service && method) return `${service}/${method}`;
  }
  return undefined;
}

function messageContent(message: unknown): string {
  if (message === undefined || message === null) return '{}';
  if (typeof message === 'string') return message;
  if (typeof message === 'object' && 'content' in (message as object)) {
    const content = (message as { content: unknown }).content;
    if (typeof content === 'string') return content;
    return JSON.stringify(content, null, 2);
  }
  return JSON.stringify(message, null, 2);
}

function readEnvironment(file: string): Environment {
  const doc = readYaml(file);
  const values = Array.isArray(doc.values) ? doc.values : [];
  return {
    id: newId(),
    name: str(doc.name) ?? basename(file).replace(ENV_RE, ''),
    values: values
      .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
      .map((v) => ({
        key: String(v.key ?? ''),
        value: v.value === undefined || v.value === null ? '' : String(v.value),
        enabled: v.enabled === undefined ? true : Boolean(v.enabled),
        type: str(v.type),
        description: str(v.description),
      })),
  };
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function kvs(v: unknown): KV[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => {
      const kv: KV = { key: String(x.key ?? ''), value: x.value === undefined || x.value === null ? '' : String(x.value) };
      if (x.description !== undefined) kv.description = String(x.description);
      if (x.disabled !== undefined) kv.disabled = Boolean(x.disabled);
      return kv;
    });
}

function authOf(v: unknown): Auth | undefined {
  if (!v || typeof v !== 'object') return undefined;
  // multiAuth arrays: use the first entry, keep the rest in `extra`.
  if (Array.isArray(v)) {
    const [first, ...rest] = v as Array<Record<string, unknown>>;
    if (!first) return undefined;
    const auth = authOf(first)!;
    if (rest.length) auth.alternatives = rest;
    return auth;
  }
  const a = v as Record<string, unknown>;
  return { ...a, type: String(a.type ?? 'noauth'), credentials: kvs(a.credentials) };
}

function scriptsOf(v: unknown): Script[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ type: String(x.type ?? ''), code: String(x.code ?? ''), language: str(x.language) }));
}

function nonEmpty(o: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(o).length ? o : undefined;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Characters not allowed in v3 filenames. */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '-').trim();
  return cleaned || 'untitled';
}

/**
 * Writes `collection` to `<root>/postman/collections/<name>/`.
 * Returns the collection directory.
 */
export function collectionExportDir(collection: Collection, root: string): string {
  return join(root, 'postman', 'collections', sanitizeFileName(collection.name));
}

export function exportCollectionV3(collection: Collection, root: string): string {
  const dir = collectionExportDir(collection, root);
  mkdirSync(dir, { recursive: true });

  const definition: Record<string, unknown> = { $kind: 'collection', name: collection.name };
  if (collection.description) definition.description = collection.description;
  if (collection.variables.length) definition.variables = collection.variables.map(cleanKV);
  if (collection.auth) definition.auth = cleanAuth(collection.auth);
  if (collection.scripts?.length) definition.scripts = collection.scripts;
  Object.assign(definition, collection.extra);
  writeDefinition(dir, definition);
  writeItems(dir, collection.items);
  return dir;
}

/**
 * Writes `<root>/postman/environments/<name>.environment.yaml`. Values typed
 * `secret` are blanked unless `includeSecrets` is set, since exports usually
 * end up in git.
 */
export function exportEnvironmentV3(env: Environment, root: string, includeSecrets = false): string {
  const dir = join(root, 'postman', 'environments');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sanitizeFileName(env.name)}.environment.yaml`);
  writeYaml(file, {
    name: env.name,
    values: env.values.map((v) => {
      const value = v.type === 'secret' && !includeSecrets ? '' : v.value;
      const out: Record<string, unknown> = { key: v.key, value, enabled: v.enabled ?? true };
      if (v.type) out.type = v.type;
      if (v.description) out.description = v.description;
      return out;
    }),
  });
  return file;
}

function writeDefinition(dir: string, definition: Record<string, unknown>): void {
  mkdirSync(join(dir, '.resources'), { recursive: true });
  writeYaml(join(dir, '.resources', 'definition.yaml'), definition);
}

function writeItems(dir: string, items: Item[]): void {
  const used = new Set<string>();
  const unique = (name: string): string => {
    let candidate = sanitizeFileName(name);
    for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${sanitizeFileName(name)} ${i}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };

  for (const item of sortItems(items)) {
    const order = item.order;
    const stem = unique(item.name);
    if (item.type === 'folder') {
      const sub = join(dir, stem);
      mkdirSync(sub, { recursive: true });
      const def: Record<string, unknown> = { $kind: 'collection' };
      if (stem !== item.name) def.name = item.name;
      if (item.description) def.description = item.description;
      if (item.variables?.length) def.variables = item.variables.map(cleanKV);
      if (item.auth) def.auth = cleanAuth(item.auth);
      if (item.scripts?.length) def.scripts = item.scripts;
      if (order !== undefined) def.order = order;
      Object.assign(def, item.extra);
      writeDefinition(sub, def);
      writeItems(sub, item.items);
      continue;
    }
    const file = join(dir, `${stem}.request.yaml`);
    if (item.type === 'other') {
      writeYaml(file, order === undefined ? item.raw : { ...item.raw, order });
      continue;
    }
    if (item.type === 'http') {
      writeYaml(file, httpToV3(item, stem, order));
      continue;
    }
    const doc: Record<string, unknown> = { $kind: 'grpc-request' };
    if (stem !== item.name) doc.name = item.name;
    doc.url = item.url;
    doc.methodPath = item.methodPath;
    if (item.methodDescriptor !== undefined) doc.methodDescriptor = item.methodDescriptor;
    if (order !== undefined) doc.order = order;
    doc.message = { content: item.message };
    if (item.metadata.length) doc.metadata = item.metadata.map(cleanKV);
    if (item.auth) doc.auth = cleanAuth(item.auth);
    if (Object.keys(item.settings).length) doc.settings = item.settings;
    const own = item.captures?.filter((c) => c.source !== 'script') ?? [];
    const scripts = [...(item.scripts ?? []), ...(own.length ? [capturesToScript(own)] : [])];
    if (scripts.length) doc.scripts = scripts;
    Object.assign(doc, item.extra);
    writeYaml(file, doc);
  }
}

function httpToV3(item: HttpRequest, stem: string, order: number | undefined): Record<string, unknown> {
  const doc: Record<string, unknown> = { $kind: 'http-request' };
  if (stem !== item.name) doc.name = item.name;
  doc.method = item.method;
  doc.url = item.url;
  if (order !== undefined) doc.order = order;
  if (item.description) doc.description = item.description;
  if (item.headers.length) doc.headers = item.headers.map(cleanKV);
  if (item.queryParams.length) doc.queryParams = item.queryParams.map(cleanKV);
  if (item.pathVariables.length) doc.pathVariables = item.pathVariables.map(({ key, value, description }) => ({ key, value, ...(description ? { description } : {}) }));
  const b = item.body;
  if (b.type === 'formdata') {
    doc.body = {
      type: 'formdata',
      content: (b.fields ?? []).map((f) =>
        f.type === 'file' ? { key: f.key, type: 'file', src: f.value } : { key: f.key, type: 'text', value: f.value, ...(f.description ? { description: f.description } : {}) },
      ),
    };
  } else if (b.type === 'urlencoded') {
    doc.body = { type: 'urlencoded', content: (b.fields ?? []).map((f) => ({ key: f.key, value: f.value, ...(f.description ? { description: f.description } : {}) })) };
  } else if (b.type === 'graphql') {
    // v3 models GraphQL as its own request kind; keep the payload as JSON here.
    doc.body = { type: 'json', content: JSON.stringify({ query: b.content ?? '', variables: b.variables ? safeJson(b.variables) : undefined }, null, 2) };
  } else if (b.type !== 'none') {
    doc.body = { type: b.type, content: b.content ?? '' };
  }
  if (item.auth) doc.auth = cleanAuth(item.auth);
  const { timeout: _t, ...settings } = item.settings; // timeout is local-only
  if (Object.keys(settings).length) doc.settings = settings;
  const own = item.captures?.filter((c) => c.source !== 'script') ?? [];
  const scripts = [...(item.scripts ?? []), ...(own.length ? [httpCapturesToScript(own)] : [])];
  if (scripts.length) doc.scripts = scripts;
  Object.assign(doc, item.extra);
  return doc;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function cleanKV(kv: KV): KV {
  const out: KV = { key: kv.key, value: kv.value };
  if (kv.description) out.description = kv.description;
  if (kv.disabled) out.disabled = true;
  return out;
}

function cleanAuth(auth: Auth): Record<string, unknown> {
  const { alternatives, ...rest } = auth;
  const main = { ...rest, credentials: (auth.credentials ?? []).map((c) => ({ key: c.key, value: c.value })) };
  return Array.isArray(alternatives) && alternatives.length ? ([main, ...alternatives] as never) : main;
}

/** Serializes following the v3 quoting rules: single-quote risky strings, `|-` for multi-line. */
export function toV3Yaml(value: unknown): string {
  const doc = new Document(value);
  visit(doc, {
    Scalar(key, node: Scalar) {
      if (key === 'key' || typeof node.value !== 'string') return;
      const s = node.value;
      if (s.includes('\n')) node.type = Scalar.BLOCK_LITERAL;
      else if (s === '' || /[{}:#&*!\[\]>|'"%@`,]/.test(s) || /^(true|false|yes|no|null|~|[-+]?[\d.]+(e[-+]?\d+)?)$/i.test(s) || /^\s|\s$/.test(s)) {
        node.type = Scalar.QUOTE_SINGLE;
      }
    },
  });
  return doc.toString({ lineWidth: 0 });
}

function writeYaml(file: string, value: unknown): void {
  writeFileSync(file, toV3Yaml(value));
}

