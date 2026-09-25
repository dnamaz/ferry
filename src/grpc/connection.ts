import { createSecureContext } from 'node:tls';
import * as grpc from '@grpc/grpc-js';
import type { GrpcSettings, TlsFiles } from '../core/model.js';
import { loadTls } from '../core/tls.js';

export interface Target {
  address: string;
  tls: boolean;
}

/**
 * Parses a Postman-style gRPC URL. Accepts `host:port`, `grpc://host:port`,
 * `grpcs://host`, `https://host`, `dns:///host:port` and `unix:///path`.
 * A `grpcs://`/`https://` scheme forces TLS; otherwise `settings.secureConnection` decides.
 */
export function parseTarget(url: string, settings: GrpcSettings = {}): Target {
  let rest = url.trim();
  if (!rest) throw new Error('URL is empty');
  let tls = settings.secureConnection ?? false;

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest)?.[1]?.toLowerCase();
  if (scheme === 'unix' || scheme === 'dns') return { address: rest, tls };
  if (scheme) {
    rest = rest.slice(scheme.length + 3);
    if (scheme === 'grpcs' || scheme === 'https') tls = true;
    else if (scheme === 'grpc' || scheme === 'http') tls = settings.secureConnection ?? false;
  }
  rest = rest.replace(/\/+$/, '');
  if (rest.includes('/')) throw new Error(`URL must not contain a path: ${url}`);

  const hasPort = /:\d+$/.test(rest) || /^\[.*\]:\d+$/.test(rest);
  const address = hasPort ? rest : `${rest}:${tls ? 443 : 80}`;
  return { address, tls };
}

export function createCredentials(target: Target, settings: GrpcSettings = {}, files: TlsFiles = {}, baseDir?: string): grpc.ChannelCredentials {
  if (!target.tls) return grpc.credentials.createInsecure();
  const strict = settings.strictSSL ?? true;
  const verify: grpc.VerifyOptions = { rejectUnauthorized: strict, ...(strict ? {} : { checkServerIdentity: () => undefined }) };
  // A Node secure context handles PEM or PKCS#12, encrypted keys, and falls back to the system roots.
  const m = loadTls(files, baseDir);
  const context = createSecureContext({ ca: m.ca, cert: m.cert, key: m.key, pfx: m.pfx, passphrase: m.passphrase });
  return grpc.credentials.createFromSecureContext(context, verify);
}

export function createClient(url: string, settings: GrpcSettings = {}, files: TlsFiles = {}, baseDir?: string): grpc.Client {
  const target = parseTarget(url, settings);
  const options: grpc.ChannelOptions = {};
  if (settings.maxResponseMessageSize) options['grpc.max_receive_message_length'] = settings.maxResponseMessageSize;
  if (settings.serverName) {
    // Verify the certificate against, and send :authority as, this name instead of the address host.
    options['grpc.ssl_target_name_override'] = settings.serverName;
    options['grpc.default_authority'] = settings.serverName;
  }
  return new grpc.Client(target.address, createCredentials(target, settings, files, baseDir), options);
}

export function toMetadata(entries: Array<{ key: string; value: string }>): grpc.Metadata {
  const md = new grpc.Metadata();
  for (const { key, value } of entries) {
    const k = key.trim().toLowerCase();
    if (!k) continue;
    if (k.endsWith('-bin')) md.add(k, Buffer.from(value, 'base64'));
    else md.add(k, value);
  }
  return md;
}

export function metadataToPairs(md: grpc.Metadata | undefined): Array<[string, string]> {
  if (!md) return [];
  const pairs: Array<[string, string]> = [];
  for (const [key, values] of Object.entries(md.getMap())) {
    const all = md.get(key);
    for (const v of all.length ? all : [values]) pairs.push([key, Buffer.isBuffer(v) ? v.toString('base64') : String(v)]);
  }
  return pairs;
}

export function deadlineFrom(timeoutMs?: number): grpc.Deadline | undefined {
  return timeoutMs && timeoutMs > 0 ? new Date(Date.now() + timeoutMs) : undefined;
}

export const statusName = (code: number): string => grpc.status[code] ?? `CODE_${code}`;
