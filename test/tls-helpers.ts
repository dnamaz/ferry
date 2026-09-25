import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestPki {
  dir: string;
  ca: string;
  /** server cert valid for localhost */
  serverCert: string;
  serverKey: string;
  /** server cert valid only for demo.internal */
  internalCert: string;
  internalKey: string;
  clientCert: string;
  clientKey: string;
  /** client.p12, passphrase "p12-pass" */
  clientP12: string;
}

/** Throwaway CA + server/client certificates for TLS tests (needs openssl on PATH). */
export function makeTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-pki-'));
  const f = (name: string) => join(dir, name);
  const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=ferry test CA');
  const leaf = (name: string, cn: string, ext: string) => {
    writeFileSync(f(`${name}.ext`), ext);
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`);
    ssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', '2', '-extfile', `${name}.ext`);
  };
  leaf('server', 'localhost', 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  leaf('internal', 'demo.internal', 'subjectAltName=DNS:demo.internal\nextendedKeyUsage=serverAuth\n');
  leaf('client', 'ferry-test-client', 'extendedKeyUsage=clientAuth\n');
  ssl('pkcs12', '-export', '-out', 'client.p12', '-inkey', 'client.key', '-in', 'client.pem', '-passout', 'pass:p12-pass', '-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-macalg', 'sha256');
  return {
    dir,
    ca: f('ca.pem'),
    serverCert: f('server.pem'),
    serverKey: f('server.key'),
    internalCert: f('internal.pem'),
    internalKey: f('internal.key'),
    clientCert: f('client.pem'),
    clientKey: f('client.key'),
    clientP12: f('client.p12'),
  };
}
