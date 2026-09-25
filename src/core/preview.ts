/**
 * "What will actually be sent": final headers/metadata with their source,
 * TLS material in effect, and the target. Used by the UI (p) and `ferry preview`.
 */
import { effectiveHttpHeaders } from '../http/client.js';
import type { CertificateEntry, Collection, Folder, SendableRequest, TlsFiles } from './model.js';
import { type ResolvedHttpRequest, type ResolvedRequest, type SourcedHeader, hostPort } from './resolve.js';
import { certificateFor, hasTls } from './tls.js';

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$|token|secret|password|session/i;

export function maskValue(key: string, value: string): string {
  if (!SECRET_HEADER.test(key) || value.length <= 12) return value;
  const scheme = /^(Bearer|Basic|Token|Digest)\s+/i.exec(value)?.[0] ?? '';
  const rest = value.slice(scheme.length);
  return `${scheme}${rest.slice(0, 6)}…(${rest.length} chars)`;
}

/** Which level supplied the effective auth: the request, a folder (by name) or the collection. */
export function authOrigin(request: SendableRequest, ancestors: Folder[], collection?: Collection): string | undefined {
  if (request.auth && request.auth.type !== 'inherit') return 'request';
  for (const f of [...ancestors].reverse()) if (f.auth && f.auth.type !== 'inherit') return `folder ${f.name}`;
  if (collection?.auth && collection.auth.type !== 'inherit') return 'collection';
  return undefined;
}

function sourceLabel(h: SourcedHeader, authFrom?: string): string {
  switch (h.source) {
    case 'auth':
      return `auth: ${h.from ?? 'auth'}${authFrom && authFrom !== 'request' ? ` (inherited from ${authFrom})` : ''}`;
    case 'folder':
      return `folder ${h.from ?? ''}`.trim();
    case 'collection':
      return 'collection';
    case 'default':
      return h.from ? `default (${h.from})` : 'default';
    default:
      return 'request';
  }
}

function table(rows: Array<[string, string, string]>, reveal: boolean): string[] {
  const kw = Math.max(6, ...rows.map((r) => r[0].length));
  const shown = rows.map(([k, v, src]) => [k, reveal ? v : maskValue(k, v), src] as const);
  const vw = Math.min(60, Math.max(5, ...shown.map((r) => r[1].length)));
  return [`${'NAME'.padEnd(kw)}  ${'VALUE'.padEnd(vw)}  SOURCE`, ...shown.map(([k, v, src]) => `${k.padEnd(kw)}  ${v.padEnd(vw)}  ${src}`)];
}

function tlsLines(t: TlsFiles, url: string, certificates: CertificateEntry[] | undefined, verify: boolean): string[] {
  const { host, port } = hostPort(url);
  const rule = certificateFor(certificates, host, port);
  const parts: string[] = [verify ? 'verify certificates' : 'verification OFF'];
  if (t.caCert) parts.push(`CA ${t.caCert}`);
  if (t.pfx) parts.push(`client PKCS#12 ${t.pfx}`);
  else if (t.clientCert) parts.push(`client cert ${t.clientCert}${t.clientKey ? ` + key ${t.clientKey}` : ''}`);
  if (t.passphrase) parts.push('passphrase set');
  if (rule && hasTls(rule)) parts.push(`host rule "${rule.host}"`);
  return [`TLS      ${parts.join(' · ')}`];
}

export function previewHttp(
  r: ResolvedHttpRequest,
  ctx: { request: SendableRequest; ancestors: Folder[]; collection?: Collection; certificates?: CertificateEntry[]; oauthToken?: string; reveal?: boolean },
): string {
  const authFrom = authOrigin(ctx.request, ctx.ancestors, ctx.collection);
  const headers = effectiveHttpHeaders(r, ctx.oauthToken);
  const lines = [`${r.method} ${r.url}`];
  if (/^https:/i.test(r.url)) lines.push(...tlsLines(r.tls, r.url, ctx.certificates, r.settings.strictSSL !== false));
  if (r.oauth) {
    lines.push(`OAuth2   client credentials via ${r.oauth.tokenUrl} · ${ctx.oauthToken ? 'using cached token' : 'token fetched when sent'}`);
  }
  const b = r.body;
  const size = b.content !== undefined ? ` · ${Buffer.byteLength(b.content)} B` : b.fields ? ` · ${b.fields.filter((f) => !f.disabled).length} field(s)` : '';
  lines.push(`Body     ${b.type}${size}`, '');
  lines.push(...table(headers.map((h) => [h.key, h.value, sourceLabel(h, authFrom)]), !!ctx.reveal));
  if (r.warnings.length) lines.push('', ...r.warnings.map((w) => `! ${w}`));
  if (r.missingVars.length) lines.push('', `! unresolved: ${r.missingVars.map((v) => `{{${v}}}`).join(', ')}`);
  return lines.join('\n');
}

export function previewGrpc(
  r: ResolvedRequest,
  ctx: {
    request: SendableRequest;
    ancestors: Folder[];
    collection?: Collection;
    certificates?: CertificateEntry[];
    oauthToken?: string;
    reveal?: boolean;
    target: { address: string; tls: boolean };
  },
): string {
  const authFrom = authOrigin(ctx.request, ctx.ancestors, ctx.collection);
  const path = r.methodPath.startsWith('/') ? r.methodPath : `/${r.methodPath.replace(/\.(\w+)$/, '/$1')}`;
  const lines = [`gRPC ${path} → ${ctx.target.address} (${ctx.target.tls ? 'TLS' : 'plaintext'})`];
  if (ctx.target.tls) lines.push(...tlsLines(r.tls, `grpcs://${ctx.target.address}`, ctx.certificates, r.settings.strictSSL !== false));
  if (r.settings.serverName) lines.push(`Name     ${r.settings.serverName} (TLS name and :authority override)`);
  if (r.oauth) lines.push(`OAuth2   client credentials via ${r.oauth.tokenUrl} · ${ctx.oauthToken ? 'using cached token' : 'token fetched when sent'}`);
  lines.push('');
  const pseudo: SourcedHeader[] = [
    { key: ':authority', value: r.settings.serverName ?? ctx.target.address, source: 'default' },
    { key: ':path', value: path, source: 'default' },
    { key: 'content-type', value: 'application/grpc', source: 'default' },
    { key: 'te', value: 'trailers', source: 'default' },
    { key: 'user-agent', value: 'grpc-node-js', source: 'default' },
  ];
  const md = r.metadataSources.map((h) =>
    h.value.endsWith('<fetched at send time>') && ctx.oauthToken ? { ...h, value: `${r.oauth?.headerPrefix ?? 'Bearer'} ${ctx.oauthToken}` } : h,
  );
  lines.push(...table([...pseudo, ...md].map((h) => [h.key, h.value, sourceLabel(h, authFrom)]), !!ctx.reveal));
  if (r.warnings.length) lines.push('', ...r.warnings.map((w) => `! ${w}`));
  if (r.missingVars.length) lines.push('', `! unresolved: ${r.missingVars.map((v) => `{{${v}}}`).join(', ')}`);
  return lines.join('\n');
}
