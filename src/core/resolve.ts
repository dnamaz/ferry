import type {
  Auth,
  CertificateEntry,
  Collection,
  Environment,
  Folder,
  FormEntry,
  GrpcRequest,
  HttpBody,
  HttpRequest,
  HttpSettings,
  KV,
  SchemaSource,
  TlsFiles,
} from './model.js';
import { certificateFor, mergeTls } from './tls.js';
import { type Resolver, type VarScope, createResolver, resolveKVs } from './vars.js';

export interface ResolveContext {
  collection?: Collection;
  ancestors?: Folder[];
  environment?: Environment;
  /** per-host client certificates (workspace settings) */
  certificates?: CertificateEntry[];
}

/** Where a header / metadata entry came from, for the preview. */
export type HeaderSource = 'request' | 'folder' | 'collection' | 'auth' | 'default';

export interface SourcedHeader {
  key: string;
  value: string;
  source: HeaderSource;
  /** folder name, or a note such as "fetched at send time" */
  from?: string;
}

/** OAuth 2.0 client-credentials settings with variables resolved; the token is fetched at send time. */
export interface OAuthConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  audience?: string;
  /** send client id/secret in the form body or as HTTP Basic */
  clientAuth: 'body' | 'header';
  headerPrefix: string;
}

/** A request with variables substituted and inherited settings applied, ready to send. */
export interface ResolvedRequest {
  url: string;
  methodPath: string;
  message: string;
  metadata: Array<{ key: string; value: string }>;
  metadataSources: SourcedHeader[];
  settings: GrpcRequest['settings'];
  schema: SchemaSource;
  tls: TlsFiles;
  auth?: Auth;
  /** token to fetch before sending (OAuth2 client credentials) */
  oauth?: OAuthConfig;
  missingVars: string[];
  warnings: string[];
  /** directory relative proto/TLS paths are resolved against */
  baseDir?: string;
}

export function buildScopes(collection: Collection | undefined, ancestors: Folder[], env: Environment | undefined): VarScope[] {
  const scopes: VarScope[] = [];
  if (collection) scopes.push({ name: 'collection', values: collection.variables });
  for (const f of ancestors) if (f.variables?.length) scopes.push({ name: f.name, values: f.variables });
  if (env) scopes.push({ name: 'environment', values: env.values });
  return scopes;
}

/** Nearest explicit auth wins; `inherit` (or no auth) defers to the parent. */
export function effectiveAuth(request: { auth?: Auth }, ancestors: Folder[], collection?: Collection): Auth | undefined {
  const chain: Array<Auth | undefined> = [request.auth, ...[...ancestors].reverse().map((f) => f.auth), collection?.auth];
  for (const auth of chain) {
    if (auth && auth.type !== 'inherit') return auth.type === 'noauth' ? undefined : auth;
  }
  return undefined;
}

function cred(auth: Auth, ...keys: string[]): string {
  for (const key of keys) {
    const v = auth.credentials?.find((c) => c.key === key)?.value;
    if (v) return v;
  }
  return '';
}

/**
 * OAuth2 credentials under the names Postman (accessTokenUrl, clientId...),
 * Bruno (access_token_url, client_id...) and ferry use.
 */
export function oauthFields(auth: Auth) {
  return {
    grantType: cred(auth, 'grant_type', 'grantType'),
    tokenUrl: cred(auth, 'accessTokenUrl', 'access_token_url', 'tokenUrl'),
    clientId: cred(auth, 'clientId', 'client_id'),
    clientSecret: cred(auth, 'clientSecret', 'client_secret'),
    scope: cred(auth, 'scope'),
    audience: cred(auth, 'audience'),
    clientAuth: cred(auth, 'client_authentication', 'credentials_placement', 'clientAuthentication'),
    headerPrefix: cred(auth, 'headerPrefix', 'token_header_prefix'),
    accessToken: cred(auth, 'accessToken', 'access_token', 'token'),
  };
}

/**
 * Auth as headers. Client-credentials OAuth2 returns no header here: its
 * settings come back in `oauth` and the token is added at send time.
 */
export function authHeaders(auth: Auth | undefined, resolver: Resolver, warnings: string[] = []): { headers: SourcedHeader[]; oauth?: OAuthConfig } {
  if (!auth) return { headers: [] };
  const h = (key: string, value: string, from?: string): SourcedHeader => ({ key, value, source: 'auth', from: from ?? auth.type });
  switch (auth.type) {
    case 'bearer': {
      // Tolerate tokens saved with the prefix ("Bearer eyJ...").
      const token = resolver.resolve(cred(auth, 'token')).trim().replace(/^bearer\s+/i, '');
      if (!token) {
        warnings.push(`Bearer token is empty (${cred(auth, 'token') || 'not set'}); no Authorization header sent`);
        return { headers: [] };
      }
      return { headers: [h('authorization', `Bearer ${token}`)] };
    }
    case 'basic': {
      const token = Buffer.from(`${resolver.resolve(cred(auth, 'username'))}:${resolver.resolve(cred(auth, 'password'))}`).toString('base64');
      return { headers: [h('authorization', `Basic ${token}`)] };
    }
    case 'apikey': {
      if (cred(auth, 'in') === 'query') return { headers: [] };
      const key = resolver.resolve(cred(auth, 'key')) || 'x-api-key';
      return { headers: [h(key, resolver.resolve(cred(auth, 'value')))] };
    }
    case 'oauth2': {
      const f = oauthFields(auth);
      const prefix = resolver.resolve(f.headerPrefix) || 'Bearer';
      const clientCredentials = f.grantType === 'client_credentials' || (!f.grantType && !f.accessToken && f.tokenUrl && f.clientId);
      if (clientCredentials) {
        const tokenUrl = resolver.resolve(f.tokenUrl);
        if (!tokenUrl) {
          warnings.push('OAuth2 client credentials: the token URL is empty');
          return { headers: [] };
        }
        return {
          headers: [h('authorization', `${prefix} <fetched at send time>`, 'oauth2 client credentials')],
          oauth: {
            tokenUrl,
            clientId: resolver.resolve(f.clientId),
            clientSecret: resolver.resolve(f.clientSecret),
            scope: resolver.resolve(f.scope) || undefined,
            audience: resolver.resolve(f.audience) || undefined,
            clientAuth: /header|basic/i.test(f.clientAuth) ? 'header' : 'body',
            headerPrefix: prefix,
          },
        };
      }
      const token = resolver.resolve(f.accessToken).trim();
      if (!token) {
        warnings.push(
          f.grantType ? `OAuth2 grant "${f.grantType}" isn't supported; paste an access token or use client credentials` : 'OAuth2 access token is empty; no Authorization header sent',
        );
        return { headers: [] };
      }
      return { headers: [h('authorization', `${prefix} ${token}`)] };
    }
    default:
      warnings.push(`Auth type "${auth.type}" isn't supported; sent without auth`);
      return { headers: [] };
  }
}

/** Collection → folders → request, nearer layers replacing same-named entries (case-insensitive). */
function layerHeaders(ctx: ResolveContext, own: KV[], resolver: Resolver): SourcedHeader[] {
  const out: SourcedHeader[] = [];
  const put = (kvs: KV[] | undefined, source: HeaderSource, from?: string) => {
    for (const { key, value } of resolveKVs(kvs ?? [], resolver)) {
      const i = out.findIndex((h) => h.key.toLowerCase() === key.toLowerCase());
      if (i >= 0) out.splice(i, 1);
      out.push({ key, value, source, from });
    }
  };
  put(ctx.collection?.headers, 'collection', ctx.collection?.name);
  for (const f of ctx.ancestors ?? []) put(f.headers, 'folder', f.name);
  put(own, 'request');
  return out;
}

/** Auth headers go first unless the request already sets the same header. */
function withAuth(headers: SourcedHeader[], auth: SourcedHeader[]): SourcedHeader[] {
  return [...auth.filter((a) => !headers.some((h) => h.key.toLowerCase() === a.key.toLowerCase())), ...headers];
}

/** host and port of a gRPC target or HTTP URL, for certificate matching. */
export function hostPort(url: string): { host: string; port?: string } {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
  const rest = scheme ? url.slice(scheme.length + 3) : url;
  const authority = rest.split(/[/?#]/)[0]!.replace(/^[^@]*@/, '');
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  const host = (m?.[1] ?? authority).replace(/^\[|\]$/g, '');
  const port = m?.[2] ?? (scheme === 'https' || scheme === 'grpcs' ? '443' : scheme === 'http' ? '80' : undefined);
  return { host, port };
}

function tlsFor(url: string, ctx: ResolveContext, own: TlsFiles | undefined, r: Resolver): TlsFiles {
  const { host, port } = hostPort(url);
  const rule = certificateFor(ctx.certificates, host, port);
  const merged = mergeTls(rule, ctx.collection?.tls, own);
  const out: TlsFiles = {};
  for (const [k, v] of Object.entries(merged)) if (v) out[k as keyof TlsFiles] = r.resolve(v);
  return out;
}

export function resolveRequest(request: GrpcRequest, ctx: ResolveContext): ResolvedRequest {
  const ancestors = ctx.ancestors ?? [];
  const resolver = createResolver(buildScopes(ctx.collection, ancestors, ctx.environment));
  const auth = effectiveAuth(request, ancestors, ctx.collection);
  const warnings: string[] = [];
  const { headers: authMd, oauth } = authHeaders(auth, resolver, warnings);
  // Collection/folder headers travel as gRPC metadata too.
  const layered = layerHeaders(ctx, request.metadata, resolver).map((h) => ({ ...h, key: h.key.toLowerCase() }));
  const sources = withAuth(layered, authMd);
  const url = resolver.resolve(request.url);
  const settings = { ...request.settings, ...(request.settings.serverName ? { serverName: resolver.resolve(request.settings.serverName) } : {}) };

  const resolved: ResolvedRequest = {
    url,
    methodPath: resolver.resolve(request.methodPath),
    message: resolver.resolve(request.message),
    metadata: sources.filter((s) => !s.value.endsWith('<fetched at send time>')).map(({ key, value }) => ({ key, value })),
    metadataSources: sources,
    settings,
    schema: resolveSchema(request.schema ?? ctx.collection?.schema ?? { type: 'reflection' }, resolver),
    tls: tlsFor(url, ctx, request.tls, resolver),
    auth,
    oauth,
    missingVars: [],
    warnings,
    baseDir: ctx.collection?.importedFrom,
  };
  resolved.missingVars = [...resolver.missing];
  return resolved;
}

function resolveSchema(source: SchemaSource, r: Resolver): SchemaSource {
  if (source.type === 'reflection') return source;
  if (source.type === 'protoset') return { type: 'protoset', files: source.files.map(r.resolve) };
  return { type: 'proto', files: source.files.map(r.resolve), importPaths: source.importPaths.map(r.resolve) };
}

export function kvSummary(kvs: KV[]): string {
  const active = kvs.filter((k) => !k.disabled && k.key);
  return active.length ? active.map((k) => k.key).join(', ') : 'none';
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface ResolvedHttpRequest {
  method: string;
  /** final URL: variables resolved, path variables substituted, query appended */
  url: string;
  headers: Array<{ key: string; value: string }>;
  headerSources: SourcedHeader[];
  body: HttpBody;
  settings: HttpSettings;
  tls: TlsFiles;
  auth?: Auth;
  oauth?: OAuthConfig;
  missingVars: string[];
  warnings: string[];
  /** directory relative file paths (formdata/file bodies, TLS files) resolve against */
  baseDir?: string;
}

function encodeQuery(pairs: Array<{ key: string; value: string }>): string {
  // Keep common readable characters unescaped, like Postman does.
  const enc = (s: string) => encodeURIComponent(s).replace(/%2C/gi, ',').replace(/%3A/gi, ':').replace(/%2F/gi, '/').replace(/%40/g, '@');
  return pairs.map(({ key, value }) => (value === '' ? enc(key) : `${enc(key)}=${enc(value)}`)).join('&');
}

export function resolveHttpRequest(request: HttpRequest, ctx: ResolveContext): ResolvedHttpRequest {
  const ancestors = ctx.ancestors ?? [];
  const resolver = createResolver(buildScopes(ctx.collection, ancestors, ctx.environment));
  const auth = effectiveAuth(request, ancestors, ctx.collection);
  const warnings: string[] = [];

  let url = resolver.resolve(request.url.trim());
  // Path variables: /users/:id → /users/42
  for (const pv of request.pathVariables) {
    if (!pv.key || pv.disabled) continue;
    const value = encodeURIComponent(resolver.resolve(pv.value)).replace(/%7B%7B/g, '{{').replace(/%7D%7D/g, '}}');
    url = url.replace(new RegExp(`/:${pv.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|$|\\?|#)`), `/${value}`);
  }
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;

  const query = resolveKVs(request.queryParams, resolver);
  if (auth?.type === 'apikey' && cred(auth, 'in') === 'query') {
    query.push({ key: resolver.resolve(cred(auth, 'key')) || 'api_key', value: resolver.resolve(cred(auth, 'value')) });
  }
  if (query.length) url += (url.includes('?') ? '&' : '?') + encodeQuery(query);

  const { headers: authHdrs, oauth } = authHeaders(auth, resolver, warnings);
  const sources = withAuth(layerHeaders(ctx, request.headers, resolver), authHdrs);

  const b = request.body;
  const fields = b.fields?.map((f): FormEntry => ({ ...f, key: resolver.resolve(f.key), value: resolver.resolve(f.value) }));
  const body: HttpBody = {
    ...b,
    content: b.content === undefined ? undefined : resolver.resolve(b.content),
    variables: b.variables === undefined ? undefined : resolver.resolve(b.variables),
    fields,
  };

  const resolved: ResolvedHttpRequest = {
    method: (request.method || 'GET').toUpperCase(),
    url,
    headers: sources.filter((s) => !s.value.endsWith('<fetched at send time>')).map(({ key, value }) => ({ key, value })),
    headerSources: sources,
    body,
    settings: request.settings,
    tls: tlsFor(url, ctx, request.tls, resolver),
    auth,
    oauth,
    missingVars: [],
    warnings,
    baseDir: ctx.collection?.importedFrom,
  };
  resolved.missingVars = [...resolver.missing];
  return resolved;
}
