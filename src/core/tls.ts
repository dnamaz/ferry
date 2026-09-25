/**
 * Client TLS material shared by gRPC and HTTP: per-host certificate matching,
 * merging (host rule < collection < request), and loading files into options
 * accepted by both `tls.createSecureContext` and undici.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { CertificateEntry, TlsFiles } from './model.js';

export interface TlsMaterial {
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  pfx?: Buffer;
  passphrase?: string;
}

const FILE_KEYS = ['caCert', 'clientCert', 'clientKey', 'pfx'] as const;

export function hasTls(files: TlsFiles | undefined): boolean {
  return !!files && FILE_KEYS.some((k) => files[k]);
}

/** Specificity of a host rule match, or -1: host:port > host > *.domain:port > *.domain. */
export function matchHost(pattern: string, host: string, port?: string): number {
  const m = /^(.*?)(?::(\d+))?$/.exec(pattern.trim().toLowerCase())!;
  const pHost = m[1]!;
  const pPort = m[2];
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (pPort && pPort !== port) return -1;
  if (pHost.startsWith('*.')) {
    const suffix = pHost.slice(1); // ".example.com"
    if (!h.endsWith(suffix) || h.length === suffix.length) return -1;
    return pPort ? 2 : 1;
  }
  if (pHost !== h) return -1;
  return pPort ? 4 : 3;
}

/** Best matching, enabled certificate rule for a host. */
export function certificateFor(certs: CertificateEntry[] | undefined, host: string, port?: string): CertificateEntry | undefined {
  let best: CertificateEntry | undefined;
  let score = -1;
  for (const c of certs ?? []) {
    if (c.disabled) continue;
    const s = matchHost(c.host, host, port);
    if (s > score) {
      score = s;
      best = c;
    }
  }
  return best;
}

/** Later layers override earlier ones field by field; a layer with client material replaces the other client fields. */
export function mergeTls(...layers: Array<TlsFiles | undefined>): TlsFiles {
  const out: TlsFiles = {};
  for (const layer of layers) {
    if (!layer) continue;
    const clientSet = layer.clientCert || layer.clientKey || layer.pfx;
    if (clientSet) {
      delete out.clientCert;
      delete out.clientKey;
      delete out.pfx;
      delete out.passphrase;
    }
    for (const k of [...FILE_KEYS, 'passphrase'] as const) if (layer[k]) out[k] = layer[k];
  }
  return out;
}

export function loadTls(files: TlsFiles, baseDir?: string): TlsMaterial {
  const read = (p?: string) => {
    if (!p) return undefined;
    const expanded = p.startsWith('~/') ? resolve(process.env.HOME ?? '', p.slice(2)) : p;
    const full = isAbsolute(expanded) ? expanded : resolve(baseDir ?? process.cwd(), expanded);
    try {
      return readFileSync(full);
    } catch (err) {
      throw new Error(`Cannot read TLS file ${full}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
  };
  return {
    ca: read(files.caCert),
    cert: read(files.clientCert),
    key: read(files.clientKey),
    pfx: read(files.pfx),
    passphrase: files.passphrase || undefined,
  };
}

/** Friendlier messages for the TLS failures people actually hit. */
export function explainTlsError(message: string): string {
  if (/self[- ]signed|unable to (get|verify) (local )?issuer|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED/i.test(message)) {
    return `${message} — the server's certificate isn't trusted: set a CA certificate (settings or P → certificates) or turn off verification`;
  }
  if (/altnames|Hostname\/IP does not match|ERR_TLS_CERT_ALTNAME_INVALID/i.test(message)) {
    return `${message} — the certificate is for a different name: set a server name override (gRPC) or use the certificate's host name`;
  }
  if (/mac verify failure|bad decrypt|wrong password|passphrase/i.test(message)) return `${message} — check the certificate/key passphrase`;
  if (/certificate required|alert (number )?116|handshake failure|bad certificate/i.test(message)) {
    return `${message} — the server wants a client certificate (mTLS): set one in settings or P → certificates`;
  }
  return message;
}
