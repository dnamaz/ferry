/**
 * Internal data model. Deliberately mirrors the Postman Collection v3 gRPC
 * request shape so collections round-trip through import/export without loss.
 */

export interface KV {
  key: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface Auth {
  /** inherit | noauth | bearer | basic | apikey | <anything Postman emits> */
  type: string;
  credentials?: KV[];
  [extra: string]: unknown;
}

export interface Script {
  type: string;
  code: string;
  language?: string;
}

/** Copies a value from each successful response into a variable. */
export interface Capture {
  variable: string;
  /** gRPC: message index then field path, e.g. [0].addressId; HTTP: path into the JSON body */
  path: string;
  /** derived from an imported script, which is kept and exported instead */
  source?: 'script';
}

export interface GrpcSettings {
  secureConnection?: boolean;
  strictSSL?: boolean;
  maxResponseMessageSize?: number;
  includeDefaultFields?: boolean;
  /** milliseconds */
  connectionTimeout?: number;
  /** TLS server name and :authority to use instead of the address host (tunnels, proxies) */
  serverName?: string;
}

/** Where the service schema comes from. Not part of the Postman format. */
export type SchemaSource =
  | { type: 'reflection' }
  | { type: 'proto'; files: string[]; importPaths: string[] }
  | { type: 'protoset'; files: string[] };

/** Client TLS material (file paths). Not part of the Postman format. */
export interface TlsFiles {
  /** PEM file with CA certificate(s) to trust instead of the system roots */
  caCert?: string;
  /** PEM client certificate (mTLS) */
  clientCert?: string;
  /** PEM client key (mTLS); may be encrypted, see passphrase */
  clientKey?: string;
  /** PKCS#12 bundle (.p12/.pfx) holding the client cert and key */
  pfx?: string;
  /** passphrase for clientKey or pfx; {{vars}} allowed */
  passphrase?: string;
}

/** Client TLS material applied to every request whose host matches (Postman's "Certificates"). */
export interface CertificateEntry extends TlsFiles {
  id: string;
  /** host, host:port, or *.domain (optionally :port) */
  host: string;
  disabled?: boolean;
}

export interface GrpcRequest {
  type: 'grpc';
  id: string;
  name: string;
  order?: number;
  url: string;
  /** e.g. /helloworld.Greeter/SayHello */
  methodPath: string;
  /** opaque value preserved from Postman */
  methodDescriptor?: string;
  /** JSON text. For client/bidi streaming this may be a JSON array of messages. */
  message: string;
  metadata: KV[];
  auth?: Auth;
  settings: GrpcSettings;
  scripts?: Script[];
  captures?: Capture[];
  schema?: SchemaSource;
  tls?: TlsFiles;
  /** unknown fields from the source file, written back on export */
  extra?: Record<string, unknown>;
}

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export type HttpBodyType = 'none' | 'json' | 'text' | 'xml' | 'html' | 'javascript' | 'urlencoded' | 'formdata' | 'graphql' | 'file';

export interface FormEntry {
  key: string;
  value: string;
  /** formdata only: `file` entries send the file at `value` (a path) */
  type?: 'text' | 'file';
  disabled?: boolean;
  description?: string;
}

export interface HttpBody {
  type: HttpBodyType;
  /** json/text/xml/html/javascript/graphql query; file path for `file` */
  content?: string;
  /** urlencoded / formdata fields */
  fields?: FormEntry[];
  /** graphql variables (JSON text) */
  variables?: string;
}

export interface HttpSettings {
  followRedirects?: boolean;
  maxRedirects?: number;
  strictSSL?: boolean;
  /** milliseconds; 0 or unset = no timeout */
  timeout?: number;
}

export interface HttpRequest {
  type: 'http';
  id: string;
  name: string;
  order?: number;
  method: string;
  /** without the query string; `:name` segments are path variables */
  url: string;
  queryParams: KV[];
  pathVariables: KV[];
  headers: KV[];
  body: HttpBody;
  auth?: Auth;
  settings: HttpSettings;
  /** client TLS material (merged over per-host certificates and the collection's) */
  tls?: TlsFiles;
  scripts?: Script[];
  /** paths are into the JSON response body, e.g. access_token or items[0].id */
  captures?: Capture[];
  description?: string;
  /** saved example responses (Postman v2.1), kept for v2.1 export */
  examples?: unknown[];
  extra?: Record<string, unknown>;
}

/** A request of an unsupported protocol (GraphQL over WS, MQTT, ...) kept verbatim so exports are lossless. */
export interface OtherRequest {
  type: 'other';
  id: string;
  name: string;
  order?: number;
  kind: string;
  raw: Record<string, unknown>;
}

export interface Folder {
  type: 'folder';
  id: string;
  name: string;
  order?: number;
  description?: string;
  variables?: KV[];
  auth?: Auth;
  /** HTTP headers sent by every request inside (Bruno folder headers) */
  headers?: KV[];
  scripts?: Script[];
  items: Item[];
  extra?: Record<string, unknown>;
}

export type Request = GrpcRequest | HttpRequest | OtherRequest;
export type Item = GrpcRequest | HttpRequest | OtherRequest | Folder;
/** Requests this app can send. */
export type SendableRequest = GrpcRequest | HttpRequest;

export function isSendable(item: Item | undefined): item is SendableRequest {
  return item?.type === 'grpc' || item?.type === 'http';
}

export interface Collection {
  id: string;
  name: string;
  description?: string;
  variables: KV[];
  auth?: Auth;
  /** HTTP headers sent by every request (Bruno collection headers) */
  headers?: KV[];
  scripts?: Script[];
  /** default schema source for requests that don't set one */
  schema?: SchemaSource;
  tls?: TlsFiles;
  /** gRPC JSON field names in responses and templates: `proto` (tenant_id) or `json` (tenantId, the default). Not part of the Postman format. */
  fieldNames?: 'proto' | 'json';
  items: Item[];
  extra?: Record<string, unknown>;
  importedFrom?: string;
}

export interface EnvValue {
  key: string;
  value: string;
  enabled?: boolean;
  type?: string;
  description?: string;
}

export interface Environment {
  id: string;
  name: string;
  values: EnvValue[];
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function newGrpcRequest(partial: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    type: 'grpc',
    id: newId(),
    name: 'New request',
    url: '',
    methodPath: '',
    message: '{}',
    metadata: [],
    settings: {},
    ...partial,
  };
}

export function newHttpRequest(partial: Partial<HttpRequest> = {}): HttpRequest {
  return {
    type: 'http',
    id: newId(),
    name: 'New request',
    method: 'GET',
    url: '',
    queryParams: [],
    pathVariables: [],
    headers: [],
    body: { type: 'none' },
    settings: {},
    ...partial,
  };
}

/** Splits `?a=1&b=2` off a URL into query params (keeps {{vars}} intact). */
export function splitQuery(url: string): { url: string; query: KV[] } {
  const i = url.indexOf('?');
  if (i < 0) return { url, query: [] };
  const query = url
    .slice(i + 1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      const [k, v] = eq < 0 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
      const decode = (x: string) => {
        try {
          return decodeURIComponent(x.replace(/\+/g, ' '));
        } catch {
          return x;
        }
      };
      return { key: decode(k), value: decode(v) };
    });
  return { url: url.slice(0, i), query };
}

/** `:name` path segments in a URL (Postman/Bruno path variables). */
export function pathVariableNames(url: string): string[] {
  const path = url.replace(/^[a-z]+:\/\/[^/]*/i, '');
  return [...path.matchAll(/\/:([A-Za-z_][\w-]*)/g)].map((m) => m[1]!);
}

export function newFolder(name: string): Folder {
  return { type: 'folder', id: newId(), name, items: [] };
}

export function newCollection(name: string): Collection {
  return { id: newId(), name, variables: [], items: [] };
}

/** Depth-first walk yielding every item plus its ancestor folders. */
export function* walkItems(
  items: Item[],
  ancestors: Folder[] = [],
): Generator<{ item: Item; ancestors: Folder[] }> {
  for (const item of items) {
    yield { item, ancestors };
    if (item.type === 'folder') yield* walkItems(item.items, [...ancestors, item]);
  }
}

export function findItem(
  collection: Collection,
  id: string,
): { item: Item; parent: Item[]; ancestors: Folder[] } | undefined {
  const visit = (items: Item[], ancestors: Folder[]): ReturnType<typeof findItem> => {
    for (const item of items) {
      if (item.id === id) return { item, parent: items, ancestors };
      if (item.type === 'folder') {
        const found = visit(item.items, [...ancestors, item]);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(collection.items, []);
}

export function sortItems(items: Item[]): Item[] {
  return [...items].sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
}

/** Re-space `order` values (1000, 2000, ...) after a reorder. */
export function renumber(items: Item[]): void {
  items.forEach((item, i) => {
    item.order = (i + 1) * 1000;
  });
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
