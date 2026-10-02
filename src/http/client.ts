import { AsyncLocalStorage } from 'node:async_hooks';
import diagnostics from 'node:diagnostics_channel';
import { openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { Agent, type DiagnosticsChannel, FormData, buildConnector, fetch } from 'undici';
import type { TlsFiles } from '../core/model.js';
import type { ResolvedHttpRequest, SourcedHeader } from '../core/resolve.js';
import { explainTlsError, hasTls, loadTls } from '../core/tls.js';
import { type Timing, phasesFrom, serverTime } from '../core/timing.js';

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
  /** where the time went (connection phases, wait, receive), once the request has finished */
  timing?: Timing;
  error?: string;
}

export interface HttpHandle {
  cancel(): void;
  done: Promise<HttpResult>;
}

// ---------------------------------------------------------------------------
// Timing. fetch() reports none, so it is pieced together from two sources:
// - the connector (below) times each NEW socket: 'lookup' (DNS), 'connect' (TCP), 'secureConnect' (TLS);
// - undici's diagnostics channels say when OUR request was created, went out on which socket, finished
//   uploading, and got headers. Requests are told apart by an AsyncLocalStorage set around fetch().
// A socket's handshake is credited to the first request sent on it; later ones are marked reused.
// ---------------------------------------------------------------------------

/** performance.now() values */
interface SocketMarks {
  start: number;
  lookup?: number;
  tcp?: number;
  tls?: number;
  /** the connector called back: set when the events above were not seen */
  end?: number;
  claimed?: boolean;
}

interface RequestMarks {
  /** requests created so far: more than one means redirects were followed */
  requests: number;
  created?: number;
  sent?: number;
  bodySent?: number;
  headers?: number;
  socket?: SocketMarks;
  reused?: boolean;
}

const sockets = new WeakMap<Socket, SocketMarks>();
const requests = new WeakMap<object, RequestMarks>();
const current = new AsyncLocalStorage<RequestMarks>();

diagnostics.subscribe('undici:request:create', (msg) => {
  const m = current.getStore();
  if (!m) return;
  const { request } = msg as DiagnosticsChannel.RequestCreateMessage;
  requests.set(request, m);
  // A redirect starts over: only the last request's phases are kept.
  Object.assign(m, { requests: m.requests + 1, created: performance.now(), sent: undefined, bodySent: undefined, headers: undefined, socket: undefined, reused: undefined });
});
diagnostics.subscribe('undici:client:sendHeaders', (msg) => {
  const { request, socket } = msg as DiagnosticsChannel.ClientSendHeadersMessage;
  const m = requests.get(request);
  if (!m) return;
  m.sent = performance.now();
  const s = sockets.get(socket);
  if (!s) return;
  m.reused = !!s.claimed;
  if (!s.claimed) {
    s.claimed = true;
    m.socket = s;
  }
});
diagnostics.subscribe('undici:request:bodySent', (msg) => {
  const m = requests.get((msg as DiagnosticsChannel.RequestBodySentMessage).request);
  if (m) m.bodySent = performance.now();
});
diagnostics.subscribe('undici:request:headers', (msg) => {
  const m = requests.get((msg as DiagnosticsChannel.RequestHeadersMessage).request);
  if (m) m.headers ??= performance.now();
});

/** Wraps a connector so every socket it opens records its DNS/TCP/TLS milestones. */
function timedConnector(base: buildConnector.connector): buildConnector.connector {
  return (options, callback) => {
    const marks: SocketMarks = { start: performance.now() };
    const socket = (base as (...a: Parameters<buildConnector.connector>) => unknown)(options, (err, s) => {
      if (s && !sockets.has(s)) sockets.set(s, { ...marks, end: performance.now() });
      callback(...([err, s] as Parameters<buildConnector.Callback>));
    }) as Socket | undefined;
    // undici's connector returns the socket it is opening; listen before any of these can fire.
    if (socket && typeof socket.once === 'function') {
      sockets.set(socket, marks);
      socket.once('lookup', () => (marks.lookup = performance.now()));
      socket.once('connect', () => (marks.tcp = performance.now()));
      socket.once('secureConnect', () => (marks.tls = performance.now()));
    }
  };
}

/** Phases of the final request; `t0` and `end` are performance.now() values. */
function requestTiming(m: RequestMarks, t0: number, end: number, hasBody: boolean, headers: Array<[string, string]>): Timing {
  const at = (v?: number) => (v === undefined ? undefined : v - t0);
  const s = m.socket;
  return {
    phases: phasesFrom([
      [m.requests > 1 ? 'redirect' : 'prepare', at(s ? s.start : m.sent)],
      ['dns', at(s?.lookup)],
      // Without the socket's own events, the connector's callback covers dns + tcp + tls.
      ['connect', at(s?.tcp ?? s?.end)],
      ['tls', at(s?.tls)],
      ['send', hasBody ? at(m.bodySent) : undefined],
      ['wait', at(m.headers ?? end)],
      ['receive', m.headers === undefined ? undefined : at(end)],
    ]),
    reused: m.reused,
    ...serverTime(headers),
  };
}

const agents = new Map<string, Agent>();
/** One agent per distinct TLS configuration (verification + client/CA material). */
function agentFor(strict: boolean, tls: TlsFiles, baseDir?: string): Agent {
  const key = JSON.stringify([strict, tls, baseDir]);
  let a = agents.get(key);
  if (!a) {
    const m = hasTls(tls) ? loadTls(tls, baseDir) : {};
    a = new Agent({ connect: timedConnector(buildConnector({ rejectUnauthorized: strict, ...m })) });
    agents.set(key, a);
  }
  return a;
}

type ErrorCause = Error & { code?: string; errors?: Error[] };

/**
 * undici wraps network failures as "fetch failed" with the real reason in `cause`. When a host
 * resolves to several addresses and all fail, the cause is an AggregateError with an empty message,
 * so the per-address errors have to be pulled out of `errors`.
 */
export function fetchErrorMessage(err: Error): string {
  const cause = (err as Error & { cause?: ErrorCause }).cause;
  const detail = cause?.message || cause?.errors?.map((e) => e.message).join('; ') || cause?.code;
  return detail && !err.message.includes(detail) ? `${err.message}: ${detail}` : err.message;
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
  const t0 = performance.now();
  const marks: RequestMarks = { requests: 0 };
  let hasBody = false;
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
    hasBody = body !== undefined;
    // multipart/form-data gets its boundary from fetch, so don't set that one ourselves.
    const headers: Array<[string, string]> = effectiveHttpHeaders(r, opts.oauthToken)
      .filter((h) => !(h.source === 'default' && h.value.includes('<generated>')))
      .map((h) => [h.key, h.value]);

    const s = r.settings;
    const timeout = s.timeout && s.timeout > 0 ? setTimeout(() => controller.abort(new Error(`Timed out after ${s.timeout} ms`)), s.timeout) : undefined;
    try {
      const res = await current.run(marks, () =>
        fetch(parsed, {
          method: r.method,
          headers,
          body: ['GET', 'HEAD'].includes(r.method) && !body ? undefined : (body as never),
          redirect: s.followRedirects === false ? 'manual' : 'follow',
          signal: controller.signal,
          dispatcher: agentFor(s.strictSSL !== false, r.tls ?? {}, r.baseDir),
        }),
      );
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
        result.error = explainTlsError(fetchErrorMessage(err));
        if (controller.signal.aborted && controller.signal.reason instanceof Error) result.error = controller.signal.reason.message;
      }
      return result;
    })
    .then(() => {
      result.durationMs = Date.now() - result.startedAt;
      // No timing for a request that never went out (bad URL, connection refused): there is nothing to split.
      if (marks.sent !== undefined) result.timing = requestTiming(marks, t0, performance.now(), hasBody, result.headers);
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
