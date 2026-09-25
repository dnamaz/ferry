import { openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { Agent, FormData, fetch } from 'undici';
import type { TlsFiles } from '../core/model.js';
import type { ResolvedHttpRequest, SourcedHeader } from '../core/resolve.js';
import { explainTlsError, hasTls, loadTls } from '../core/tls.js';

export interface HttpResult {
  kind: 'http';
  state: 'running' | 'done' | 'error' | 'cancelled';
  status?: number;
  statusText?: string;
  headers: Array<[string, string]>;
  /** response body so far (the whole body once done) */
  body: Buffer;
  contentType?: string;
  /** final URL after redirects */
  url?: string;
  startedAt: number;
  durationMs?: number;
  /** time to response headers */
  ttfbMs?: number;
  error?: string;
}

export interface HttpHandle {
  cancel(): void;
  done: Promise<HttpResult>;
}

const agents = new Map<string, Agent>();
/** One agent per distinct TLS configuration (verification + client/CA material). */
function agentFor(strict: boolean, tls: TlsFiles, baseDir?: string): Agent {
  const key = JSON.stringify([strict, tls, baseDir]);
  let a = agents.get(key);
  if (!a) {
    const m = hasTls(tls) ? loadTls(tls, baseDir) : {};
    a = new Agent({ connect: { rejectUnauthorized: strict, ...m } });
    agents.set(key, a);
  }
  return a;
}

const IMPLIED_CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  text: 'text/plain',
  graphql: 'application/json',
  urlencoded: 'application/x-www-form-urlencoded',
  formdata: 'multipart/form-data; boundary=<generated>',
  file: 'application/octet-stream',
};

/**
 * Every header that will go on the wire, with where it came from: auth,
 * collection/folder/request headers, and the defaults added here.
 */
export function effectiveHttpHeaders(r: ResolvedHttpRequest, oauthToken?: string): SourcedHeader[] {
  let out: SourcedHeader[] = r.headerSources.map((h) =>
    h.value.endsWith('<fetched at send time>') && oauthToken !== undefined ? { ...h, value: `${r.oauth?.headerPrefix ?? 'Bearer'} ${oauthToken}` } : h,
  );
  const has = (name: string) => out.some((h) => h.key.toLowerCase() === name);
  const implied = r.body.type === 'file' && !r.body.content ? undefined : IMPLIED_CONTENT_TYPES[r.body.type];
  if (implied && !has('content-type')) out = [...out, { key: 'Content-Type', value: implied, source: 'default', from: `${r.body.type} body` }];
  if (!has('user-agent')) out = [...out, { key: 'User-Agent', value: 'ferry', source: 'default' }];
  if (!has('accept')) out = [...out, { key: 'Accept', value: '*/*', source: 'default' }];
  return out;
}

function hasHeader(headers: Array<{ key: string }>, name: string): boolean {
  return headers.some((h) => h.key.toLowerCase() === name.toLowerCase());
}

function filePath(p: string, baseDir?: string): string {
  const expanded = p.startsWith('~/') ? resolve(process.env.HOME ?? '', p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : resolve(baseDir ?? process.cwd(), expanded);
}

/** Builds the request body and any implied Content-Type. */
async function buildBody(r: ResolvedHttpRequest): Promise<{ body?: string | Buffer | FormData | URLSearchParams; contentType?: string }> {
  const b = r.body;
  switch (b.type) {
    case 'none':
      return {};
    case 'json':
      return { body: b.content ?? '', contentType: 'application/json' };
    case 'xml':
      return { body: b.content ?? '', contentType: 'application/xml' };
    case 'html':
      return { body: b.content ?? '', contentType: 'text/html' };
    case 'javascript':
      return { body: b.content ?? '', contentType: 'application/javascript' };
    case 'text':
      return { body: b.content ?? '', contentType: 'text/plain' };
    case 'graphql': {
      let variables: unknown;
      if (b.variables?.trim()) {
        try {
          variables = JSON.parse(b.variables);
        } catch (err) {
          throw new Error(`GraphQL variables are not valid JSON: ${(err as Error).message}`);
        }
      }
      return { body: JSON.stringify({ query: b.content ?? '', ...(variables === undefined ? {} : { variables }) }), contentType: 'application/json' };
    }
    case 'urlencoded': {
      const params = new URLSearchParams();
      for (const f of b.fields ?? []) if (!f.disabled && f.key) params.append(f.key, f.value);
      return { body: params, contentType: 'application/x-www-form-urlencoded' };
    }
    case 'formdata': {
      const form = new FormData();
      for (const f of b.fields ?? []) {
        if (f.disabled || !f.key) continue;
        if (f.type === 'file') {
          const path = filePath(f.value, r.baseDir);
          form.append(f.key, await openAsBlob(path), basename(path));
        } else form.append(f.key, f.value);
      }
      return { body: form }; // fetch sets the multipart boundary
    }
    case 'file':
      if (!b.content) return {};
      return { body: await readFile(filePath(b.content, r.baseDir)), contentType: 'application/octet-stream' };
  }
}

export function sendHttp(r: ResolvedHttpRequest, onUpdate?: (res: HttpResult) => void, opts: { oauthToken?: string } = {}): HttpHandle {
  const result: HttpResult = { kind: 'http', state: 'running', headers: [], body: Buffer.alloc(0), startedAt: Date.now() };
  const controller = new AbortController();
  let cancelled = false;
  let lastUpdate = 0;
  const update = (force = false) => {
    // Throttle progress updates for large/streamed bodies.
    const now = Date.now();
    if (!force && now - lastUpdate < 50) return;
    lastUpdate = now;
    onUpdate?.({ ...result });
  };

  const run = async (): Promise<HttpResult> => {
    if (!r.url || r.url === 'http://') throw new Error('URL is empty');
    let parsed: URL;
    try {
      parsed = new URL(r.url);
    } catch {
      throw new Error(`Invalid URL: ${r.url}`);
    }
    if (r.oauth && opts.oauthToken === undefined) throw new Error('OAuth2 token was not fetched before sending');
    const { body } = await buildBody(r);
    // multipart/form-data gets its boundary from fetch, so don't set that one ourselves.
    const headers: Array<[string, string]> = effectiveHttpHeaders(r, opts.oauthToken)
      .filter((h) => !(h.source === 'default' && h.value.includes('<generated>')))
      .map((h) => [h.key, h.value]);

    const s = r.settings;
    const timeout = s.timeout && s.timeout > 0 ? setTimeout(() => controller.abort(new Error(`Timed out after ${s.timeout} ms`)), s.timeout) : undefined;
    try {
      const res = await fetch(parsed, {
        method: r.method,
        headers,
        body: ['GET', 'HEAD'].includes(r.method) && !body ? undefined : (body as never),
        redirect: s.followRedirects === false ? 'manual' : 'follow',
        signal: controller.signal,
        dispatcher: agentFor(s.strictSSL !== false, r.tls ?? {}, r.baseDir),
      });
      result.ttfbMs = Date.now() - result.startedAt;
      result.status = res.status;
      result.statusText = res.statusText;
      result.url = res.url || r.url;
      result.headers = [...res.headers.entries()];
      result.contentType = res.headers.get('content-type') ?? undefined;
      update(true);

      const chunks: Buffer[] = [];
      if (res.body) {
        for await (const chunk of res.body) {
          chunks.push(Buffer.from(chunk));
          result.body = Buffer.concat(chunks);
          update();
        }
      }
      result.body = Buffer.concat(chunks);
      result.state = 'done';
    } finally {
      clearTimeout(timeout);
    }
    return result;
  };

  const done = run()
    .catch((err: Error) => {
      if (cancelled) result.state = 'cancelled';
      else {
        result.state = 'error';
        const cause = (err as Error & { cause?: Error }).cause;
        result.error = explainTlsError(cause?.message && !err.message.includes(cause.message) ? `${err.message}: ${cause.message}` : err.message);
        if (controller.signal.aborted && controller.signal.reason instanceof Error) result.error = controller.signal.reason.message;
      }
      return result;
    })
    .then(() => {
      result.durationMs = Date.now() - result.startedAt;
      update(true);
      return { ...result };
    });

  return {
    cancel() {
      cancelled = true;
      controller.abort();
    },
    done,
  };
}

// ---------------------------------------------------------------------------
// Response body helpers
// ---------------------------------------------------------------------------

export function isJsonType(ct?: string): boolean {
  return !!ct && /[/+]json\b|^application\/json/i.test(ct);
}

export function isTextType(ct?: string): boolean {
  if (!ct) return true;
  return /^text\/|[/+](json|xml|javascript|x-www-form-urlencoded|yaml|graphql)\b|event-stream/i.test(ct);
}

/** Parsed JSON body, or undefined when the body isn't JSON. */
export function jsonBody(res: HttpResult): unknown {
  if (!res.body.length) return undefined;
  const text = res.body.toString('utf8');
  if (!isJsonType(res.contentType) && !/^\s*[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Heuristic: body looks binary (NUL bytes or mostly non-printable). */
export function looksBinary(buf: Buffer, ct?: string): boolean {
  if (ct && isTextType(ct)) return false;
  const sample = buf.subarray(0, 1024);
  let odd = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) odd++;
  }
  return sample.length > 0 && odd / sample.length > 0.1;
}
