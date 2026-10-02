import { performance } from 'node:perf_hooks';
import * as grpc from '@grpc/grpc-js';
import { fromBinary, fromJson, toBinary, toJson, type JsonValue } from '@bufbuild/protobuf';
import type { GrpcSettings, TlsFiles } from '../core/model.js';
import { type ConnectMarks, createClient, deadlineFrom, metadataToPairs, statusName, toMetadata } from './connection.js';
import { type MethodInfo, type Schema, isClientStreaming } from './schema.js';
import { explainTlsError } from '../core/tls.js';
import { normalizeJson } from './normalize.js';
import { type Timing, phasesFrom, serverTime } from '../core/timing.js';

export interface InvokeOptions {
  url: string;
  settings?: GrpcSettings;
  tls?: TlsFiles;
  /** directory relative TLS file paths resolve against */
  baseDir?: string;
  schema: Schema;
  method: MethodInfo;
  /** resolved JSON text; a JSON array sends multiple messages on client/bidi streams */
  message: string;
  metadata?: Array<{ key: string; value: string }>;
  /** per-call deadline in ms */
  deadlineMs?: number;
  /** print response fields as `tenant_id` rather than `tenantId` */
  protoFieldNames?: boolean;
  onUpdate?: (result: CallResult) => void;
}

export interface CallResult {
  state: 'running' | 'done' | 'error' | 'cancelled';
  code?: number;
  codeName?: string;
  details?: string;
  headers: Array<[string, string]>;
  trailers: Array<[string, string]>;
  messages: JsonValue[];
  sent: number;
  startedAt: number;
  durationMs?: number;
  /** protobuf bytes of the messages sent / received (excludes metadata and the 5-byte gRPC frame header) */
  requestBytes?: number;
  responseBytes?: number;
  /** where the time went (connection phases, wait, receive), once the call has finished */
  timing?: Timing;
  /** client-side problem (bad JSON, unknown field, connection timeout...) */
  error?: string;
}

export interface CallHandle {
  cancel(): void;
  done: Promise<CallResult>;
}

/** Parses the request JSON and converts it to protobuf messages up front, so mistakes fail fast. */
export function encodeMessages(schema: Schema, method: MethodInfo, text: string): Uint8Array[] {
  const trimmed = text.trim();
  let json: unknown;
  try {
    json = trimmed ? JSON.parse(trimmed) : {};
  } catch (err) {
    throw new Error(`Message is not valid JSON: ${(err as Error).message}`);
  }
  const input = method.desc.input;
  let values: unknown[];
  if (isClientStreaming(method.kind)) values = Array.isArray(json) ? json : [json];
  else if (Array.isArray(json)) throw new Error(`${method.kind} methods take a single message object, not an array`);
  else values = [json];

  return values.map((value, i) => {
    try {
      return toBinary(input, fromJson(input, normalizeJson(input, value) as JsonValue, { registry: schema.registry }));
    } catch (err) {
      const where = values.length > 1 ? ` (message #${i + 1})` : '';
      throw new Error(`Invalid ${input.typeName}${where}: ${(err as Error).message}`);
    }
  });
}

/**
 * Phases of one call on a fresh channel. A trailers-only response (an error status with no
 * headers) has no headers mark, so its whole wait runs to the end and there is no receive.
 */
export function callTiming(m: ConnectMarks & { kickoff?: number; headers?: number }, t0: number, end: number, headers: Array<[string, string]>): Timing {
  const at = (v?: number) => (v === undefined ? undefined : v - t0);
  return {
    phases: phasesFrom([
      ['prepare', at(m.kickoff)],
      ['dns', at(m.connectStart)],
      ['connect', at(m.tcp)],
      ['tls', at(m.tls)],
      ['http2', at(m.ready)],
      ['wait', at(m.headers ?? end)],
      ['receive', m.headers === undefined ? undefined : at(end)],
    ]),
    ...serverTime(headers),
  };
}

export function invoke(opts: InvokeOptions): CallHandle {
  const { method, schema } = opts;
  const settings = opts.settings ?? {};
  const includeDefaults = settings.includeDefaultFields ?? true;
  const result: CallResult = { state: 'running', headers: [], trailers: [], messages: [], sent: 0, startedAt: Date.now() };
  const t0 = performance.now();
  // Each call gets its own channel, so these always describe a fresh connection.
  const marks: ConnectMarks & { kickoff?: number; headers?: number } = {};
  const update = () => opts.onUpdate?.({ ...result, messages: [...result.messages] });

  let call: grpc.ClientUnaryCall | grpc.ClientReadableStream<Uint8Array> | grpc.ClientWritableStream<Uint8Array> | undefined;
  let client: grpc.Client | undefined;
  let cancelled = false;
  let settle!: (r: CallResult) => void;
  const done = new Promise<CallResult>((resolve) => (settle = resolve));

  const finish = (patch: Partial<CallResult>) => {
    if (result.state !== 'running') return;
    Object.assign(result, patch);
    const end = performance.now();
    result.durationMs = Date.now() - result.startedAt;
    if (marks.kickoff !== undefined) result.timing = callTiming(marks, t0, end, result.headers);
    client?.close();
    update();
    settle({ ...result });
  };

  const decode = (buf: Buffer): JsonValue => {
    result.responseBytes = (result.responseBytes ?? 0) + buf.length;
    const msg = fromBinary(method.desc.output, buf);
    return toJson(method.desc.output, msg, { registry: schema.registry, alwaysEmitImplicit: includeDefaults, useProtoFieldName: opts.protoFieldNames });
  };
  const serialize = (bytes: Uint8Array) => Buffer.from(bytes);

  const run = async () => {
    const payloads = encodeMessages(schema, method, opts.message);
    result.responseBytes = 0;
    client = createClient(opts.url, settings, opts.tls, opts.baseDir, marks);

    // Whichever comes first starts the connection: waitForReady here, or the call below.
    marks.kickoff = performance.now();
    if (settings.connectionTimeout && settings.connectionTimeout > 0) {
      await new Promise<void>((resolve, reject) =>
        client!.waitForReady(deadlineFrom(settings.connectionTimeout)!, (err) =>
          err ? reject(new Error(`Could not connect within ${settings.connectionTimeout}ms`)) : resolve(),
        ),
      );
    }
    if (cancelled) return;

    const md = toMetadata(opts.metadata ?? []);
    const callOpts: grpc.CallOptions = { deadline: deadlineFrom(opts.deadlineMs) };
    const onMessage = (m: JsonValue) => {
      result.messages.push(m);
      update();
    };
    const onError = (err: grpc.ServiceError) => {
      // Status (with trailers) is delivered separately; this handles failures without one.
      if (err.code === undefined) finish({ state: 'error', error: err.message });
    };

    switch (method.kind) {
      case 'unary':
        call = client.makeUnaryRequest(method.path, serialize, decode, payloads[0]!, md, callOpts, (err, value) => {
          if (!err && value !== undefined) onMessage(value);
        });
        result.sent = 1;
        break;
      case 'server_streaming': {
        const stream = client.makeServerStreamRequest(method.path, serialize, decode, payloads[0]!, md, callOpts);
        stream.on('data', onMessage);
        stream.on('error', onError);
        call = stream;
        result.sent = 1;
        break;
      }
      case 'client_streaming': {
        const stream = client.makeClientStreamRequest(method.path, serialize, decode, md, callOpts, (err, value) => {
          if (!err && value !== undefined) onMessage(value);
        });
        for (const p of payloads) stream.write(p);
        stream.end();
        result.sent = payloads.length;
        call = stream;
        break;
      }
      case 'bidi_streaming': {
        const stream = client.makeBidiStreamRequest(method.path, serialize, decode, md, callOpts);
        stream.on('data', onMessage);
        stream.on('error', onError);
        for (const p of payloads) stream.write(p);
        stream.end();
        result.sent = payloads.length;
        call = stream as unknown as grpc.ClientReadableStream<Uint8Array>;
        break;
      }
    }
    result.requestBytes = payloads.slice(0, result.sent).reduce((n, p) => n + p.length, 0);
    update();

    call.on('metadata', (m: grpc.Metadata) => {
      marks.headers ??= performance.now();
      result.headers = metadataToPairs(m);
      update();
    });
    call.on('status', (s: grpc.StatusObject) => {
      // grpc-js emits status before the unary callback; let pending data land first.
      setImmediate(() =>
        finish({
          state: cancelled ? 'cancelled' : s.code === grpc.status.OK ? 'done' : 'error',
          code: s.code,
          codeName: statusName(s.code),
          details: s.code === grpc.status.OK ? s.details : explainTlsError(s.details),
          trailers: metadataToPairs(s.metadata),
        }),
      );
    });
  };

  run().catch((err: Error) => finish({ state: 'error', error: err.message }));

  return {
    cancel() {
      cancelled = true;
      if (call) call.cancel();
      else finish({ state: 'cancelled' });
    },
    done,
  };
}
