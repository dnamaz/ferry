import type { ResolvedRequest } from '../core/resolve.js';
import { parseTarget } from './connection.js';
import type { DescMessage } from '@bufbuild/protobuf';
import { normalizeJson } from './normalize.js';
import { normalizeMethodPath } from './schema.js';

/** POSIX single-quote escaping. */
export function shellQuote(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds an equivalent grpcurl command for a resolved request.
 * grpcurl reads client-stream input as a sequence of JSON objects rather than
 * an array, so arrays on streaming methods are unrolled. With the method's `input` type,
 * the body is rewritten to canonical proto3 JSON (see normalizeJson), which is all grpcurl accepts.
 */
export function toGrpcurl(r: ResolvedRequest, opts: { clientStreaming?: boolean; oauthToken?: string; input?: DescMessage } = {}): string {
  const s = r.settings;
  const flags: string[][] = [];
  const flag = (...parts: string[]) => flags.push(parts);

  let address = r.url;
  let tls = s.secureConnection ?? false;
  try {
    const t = parseTarget(r.url, s);
    address = t.address;
    tls = t.tls;
  } catch {
    // keep the raw URL so the problem is visible
  }

  if (!tls) flag('-plaintext');
  else if (s.strictSSL === false) flag('-insecure');
  if (tls && r.tls.caCert) flag('-cacert', shellQuote(r.tls.caCert));
  if (tls && r.tls.clientCert) flag('-cert', shellQuote(r.tls.clientCert));
  if (tls && r.tls.clientKey) flag('-key', shellQuote(r.tls.clientKey));
  const notes: string[] = [];
  if (tls && r.tls.pfx) notes.push(`# grpcurl needs PEM files: openssl pkcs12 -in ${shellQuote(r.tls.pfx)} -nodes, then pass -cert/-key`);
  if (s.serverName) {
    if (tls) flag('-servername', shellQuote(s.serverName));
    flag('-authority', shellQuote(s.serverName));
  }

  if (r.schema.type === 'proto') {
    for (const p of r.schema.importPaths) flag('-import-path', shellQuote(p));
    for (const f of r.schema.files) flag('-proto', shellQuote(f));
  } else if (r.schema.type === 'protoset') {
    for (const f of r.schema.files) flag('-protoset', shellQuote(f));
  }

  if (s.includeDefaultFields !== false) flag('-emit-defaults');
  if (s.connectionTimeout) flag('-connect-timeout', String(s.connectionTimeout / 1000));
  if (s.maxResponseMessageSize) flag('-max-msg-sz', String(s.maxResponseMessageSize));

  for (const h of r.metadataSources ?? r.metadata.map((m) => ({ ...m, source: 'request' as const }))) {
    const value = h.value.endsWith('<fetched at send time>') ? `${r.oauth?.headerPrefix ?? 'Bearer'} ${opts.oauthToken ?? '$OAUTH_TOKEN'}` : h.value;
    if (value.includes('$OAUTH_TOKEN')) flag('-H', `"${h.key}: ${value}"`);
    else flag('-H', shellQuote(`${h.key}: ${value}`));
  }

  const body = grpcurlBody(r.message, opts.clientStreaming ?? true, opts.input);
  if (body !== undefined) flag('-d', shellQuote(body));

  const method = normalizeMethodPath(r.methodPath).replace(/^\//, '');
  // One flag per line, like Postman's code snippets.
  const [first, ...rest] = flags;
  const lines = [['grpcurl', ...(first ?? [])].join(' '), ...rest.map((f) => `  ${f.join(' ')}`), `  ${shellQuote(address)} ${shellQuote(method)}`];
  return [...notes, lines.join(' \\\n')].join('\n');
}

function grpcurlBody(message: string, clientStreaming: boolean, input?: DescMessage): string | undefined {
  const text = message.trim();
  if (!text || text === '{}') return undefined;
  try {
    const parsed = JSON.parse(text);
    const canonical = (m: unknown) => (input ? normalizeJson(input, m) : m);
    const json = Array.isArray(parsed) ? parsed.map(canonical) : canonical(parsed);
    if (clientStreaming && Array.isArray(json)) return json.map((m) => JSON.stringify(m, null, 2)).join('\n');
    return JSON.stringify(json, null, 2);
  } catch {
    return text; // invalid JSON: show it verbatim
  }
}
