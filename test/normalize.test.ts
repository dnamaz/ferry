import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fromBinary, toJson } from '@bufbuild/protobuf';
import { loadProtoFiles } from '../src/grpc/proto-files.js';
import { encodeMessages } from '../src/grpc/invoke.js';
import { toGrpcurl } from '../src/grpc/grpcurl.js';
import { normalizeJson } from '../src/grpc/normalize.js';
import { Schema, type MethodInfo } from '../src/grpc/schema.js';
import type { ResolvedRequest } from '../src/core/resolve.js';

let schema: Schema;
let method: MethodInfo;
beforeAll(async () => {
  schema = new Schema(await loadProtoFiles([join(import.meta.dirname, 'fixtures', 'protos', 'compat.proto')]));
  method = schema.findMethod('compat.v1.Compat/Call')!;
});

/** Encodes `message` and decodes it back to canonical JSON. */
const roundTrip = (message: unknown) => {
  const [bytes] = encodeMessages(schema, method, JSON.stringify(message));
  return toJson(method.desc.input, fromBinary(method.desc.input, bytes!), { registry: schema.registry });
};

const CANONICAL = {
  at: '2026-01-01T00:00:00Z',
  ttl: '90.500s',
  county: 'Kings',
  validated: false,
  big: '9007199254740993',
  parameters: { pay_date_from: '2026-01-01', pay_date_to: '2026-12-31' },
  itemsById: { a: { name: 'A', createdAt: '2026-01-01T00:00:00.250Z', note: '' } },
  items: [{ name: 'B', createdAt: '2026-01-01T00:00:00Z' }],
  item: { note: 'n' },
  extra: { seconds: 1, value: 'kept as a Struct' },
};

describe('protobufjs object form (Bruno, proto-loader)', () => {
  it('encodes to the same message as canonical proto3 JSON', () => {
    const objectForm = {
      at: { seconds: '1767225600', nanos: 0 },
      ttl: { seconds: 90, nanos: 500_000_000 },
      county: { value: 'Kings' },
      validated: { value: false },
      big: { value: '9007199254740993' },
      parameters: [
        { key: 'pay_date_from', value: '2026-01-01' },
        { key: 'pay_date_to', value: '2026-12-31' },
      ],
      items_by_id: [{ key: 'a', value: { name: 'A', created_at: { seconds: '1767225600', nanos: 250_000_000 }, note: {} } }],
      items: [{ name: 'B', created_at: { seconds: 1767225600 } }],
      item: { note: { value: 'n' } },
      extra: { seconds: 1, value: 'kept as a Struct' },
    };
    expect(roundTrip(objectForm)).toEqual(roundTrip(CANONICAL));
    expect(roundTrip(objectForm)).toEqual(CANONICAL);
  });

  it('leaves canonical JSON untouched', () => {
    expect(normalizeJson(method.desc.input, CANONICAL)).toEqual(CANONICAL);
  });

  it('still reports values that fit neither form', () => {
    expect(() => encodeMessages(schema, method, '{"at": {"seconds": 1, "extra": 2}}')).toThrow(/google.protobuf.Timestamp/);
    expect(() => encodeMessages(schema, method, '{"parameters": [1, 2]}')).toThrow(/parameters/);
  });

  it('writes canonical JSON in the grpcurl command', () => {
    const r = { url: 'localhost:1', methodPath: '/compat.v1.Compat/Call', message: '{"at": {"seconds": "1767225600"}, "parameters": [{"key": "k", "value": "v"}]}', metadata: [], settings: {}, tls: {}, schema: { type: 'reflection' } } as unknown as ResolvedRequest;
    const cmd = toGrpcurl(r, { input: method.desc.input });
    expect(cmd).toContain('"at": "2026-01-01T00:00:00Z"');
    expect(cmd).toContain('"k": "v"');
  });
});
