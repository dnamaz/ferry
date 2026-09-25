import { describe, expect, it } from 'vitest';
import type { ResolvedRequest } from '../src/core/resolve.js';
import { shellQuote, toGrpcurl } from '../src/grpc/grpcurl.js';

const base: ResolvedRequest = {
  url: 'localhost:9093',
  methodPath: 'pkg.Svc/Method',
  message: '{"name":"it\'s"}',
  metadata: [{ key: 'authorization', value: 'Bearer abc' }],
  settings: {},
  schema: { type: 'reflection' },
  tls: {},
  missingVars: [],
};

describe('grpcurl', () => {
  it('quotes for POSIX shells', () => {
    expect(shellQuote('localhost:9093')).toBe('localhost:9093');
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('builds a plaintext reflection command', () => {
    expect(toGrpcurl(base)).toBe(
      [
        'grpcurl -plaintext',
        '  -emit-defaults',
        `  -H 'authorization: Bearer abc'`,
        `  -d '{\n  "name": "it'\\''s"\n}'`,
        '  localhost:9093 pkg.Svc/Method',
      ].join(' \\\n'),
    );
  });

  it('maps TLS, proto sources and settings', () => {
    const cmd = toGrpcurl({
      ...base,
      url: 'grpcs://api.example.com',
      methodPath: '/pkg.Svc/Method',
      settings: { strictSSL: false, includeDefaultFields: false, connectionTimeout: 2500 },
      schema: { type: 'proto', files: ['a.proto'], importPaths: ['./protos'] },
      tls: { caCert: 'ca.pem' },
      metadata: [],
      message: '{}',
    });
    expect(cmd).toContain('grpcurl -insecure');
    expect(cmd).toContain('-cacert ca.pem');
    expect(cmd).toContain('-import-path ./protos');
    expect(cmd).toContain('-proto a.proto');
    expect(cmd).toContain('-connect-timeout 2.5');
    expect(cmd).not.toContain('-emit-defaults');
    expect(cmd).not.toContain('-d ');
    expect(cmd.endsWith('api.example.com:443 pkg.Svc/Method')).toBe(true);
  });

  it('unrolls JSON arrays into a message stream', () => {
    const cmd = toGrpcurl({ ...base, message: '[{"a":1},{"a":2}]' }, { clientStreaming: true });
    expect(cmd).toContain(`-d '{\n  "a": 1\n}\n{\n  "a": 2\n}'`);
  });
});
