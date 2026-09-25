import * as grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import { deadlineFrom } from './connection.js';

const REFLECTION_PROTO = (pkg: string) => `
syntax = "proto3";
package ${pkg};
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    string list_services = 7;
  }
}
message ServerReflectionResponse {
  string valid_host = 1;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`;

const VERSIONS = ['grpc.reflection.v1', 'grpc.reflection.v1alpha'] as const;

interface ReflectionResponse {
  fileDescriptorResponse?: { fileDescriptorProto: Uint8Array[] };
  listServicesResponse?: { service: Array<{ name: string }> };
  errorResponse?: { errorCode: number; errorMessage: string };
}

type ReflectionRequest = { fileByFilename: string } | { fileContainingSymbol: string } | { listServices: string };

class ReflectionStream {
  private pending: Array<{ resolve: (r: ReflectionResponse) => void; reject: (e: Error) => void }> = [];
  private failure?: Error;
  private readonly call: grpc.ClientDuplexStream<ReflectionRequest, ReflectionResponse>;

  constructor(client: grpc.Client, pkg: string, metadata: grpc.Metadata, timeoutMs: number) {
    const root = protobuf.parse(REFLECTION_PROTO(pkg)).root;
    const Req = root.lookupType(`${pkg}.ServerReflectionRequest`);
    const Res = root.lookupType(`${pkg}.ServerReflectionResponse`);
    this.call = client.makeBidiStreamRequest(
      `/${pkg}.ServerReflection/ServerReflectionInfo`,
      (req: ReflectionRequest) => Buffer.from(Req.encode(Req.fromObject(req)).finish()),
      (buf: Buffer) => Res.toObject(Res.decode(buf), { defaults: true, arrays: true }) as ReflectionResponse,
      metadata,
      { deadline: deadlineFrom(timeoutMs) },
    );
    this.call.on('data', (res: ReflectionResponse) => this.pending.shift()?.resolve(res));
    this.call.on('error', (err: Error) => this.fail(err));
    this.call.on('end', () => this.fail(new Error('reflection stream closed')));
  }

  private fail(err: Error): void {
    this.failure ??= err;
    for (const p of this.pending.splice(0)) p.reject(err);
  }

  send(req: ReflectionRequest): Promise<ReflectionResponse> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.call.write(req);
    });
  }

  close(): void {
    this.call.end();
    this.call.cancel();
  }
}

export interface ReflectionResult {
  services: string[];
  files: Uint8Array[];
  version: string;
}

/**
 * Discovers every service exposed via server reflection and downloads the
 * file descriptors (with transitive dependencies) needed to call them.
 */
export async function reflect(
  client: grpc.Client,
  metadata: grpc.Metadata = new grpc.Metadata(),
  timeoutMs = 10_000,
): Promise<ReflectionResult> {
  let lastError: unknown;
  for (const version of VERSIONS) {
    const stream = new ReflectionStream(client, version, metadata, timeoutMs);
    try {
      return await reflectWith(stream, version);
    } catch (err) {
      lastError = err;
      // Only fall back to the older API if the newer one isn't implemented.
      if ((err as grpc.ServiceError).code !== grpc.status.UNIMPLEMENTED) break;
    } finally {
      stream.close();
    }
  }
  const err = lastError as grpc.ServiceError;
  if (err?.code === grpc.status.UNIMPLEMENTED) {
    throw new Error('Server does not support gRPC reflection. Configure .proto files or a protoset for this request instead.');
  }
  throw err;
}

async function reflectWith(stream: ReflectionStream, version: string): Promise<ReflectionResult> {
  const list = await stream.send({ listServices: '' });
  checkError(list);
  const services = (list.listServicesResponse?.service ?? [])
    .map((s) => s.name)
    .filter((name) => !name.startsWith('grpc.reflection.'));

  const files = new Map<string, Uint8Array>();
  const requested = new Set<string>();
  const addFiles = async (res: ReflectionResponse) => {
    checkError(res);
    const descriptors = res.fileDescriptorResponse?.fileDescriptorProto ?? [];
    const deps: string[] = [];
    for (const bytes of descriptors) {
      const { name, dependencies } = peekFileDescriptor(bytes);
      if (!files.has(name)) {
        files.set(name, bytes);
        deps.push(...dependencies);
      }
    }
    // Some servers only return the requested file; fetch missing imports explicitly.
    for (const dep of deps) {
      if (files.has(dep) || requested.has(dep)) continue;
      requested.add(dep);
      try {
        await addFiles(await stream.send({ fileByFilename: dep }));
      } catch {
        // Well-known types are filled in locally; ignore servers that can't serve them.
      }
    }
  };

  for (const service of services) await addFiles(await stream.send({ fileContainingSymbol: service }));
  return { services, files: [...files.values()], version };
}

function checkError(res: ReflectionResponse): void {
  if (res.errorResponse && (res.errorResponse.errorCode || res.errorResponse.errorMessage)) {
    const e = new Error(`reflection error ${res.errorResponse.errorCode}: ${res.errorResponse.errorMessage}`) as grpc.ServiceError;
    e.code = res.errorResponse.errorCode;
    throw e;
  }
}

/** Reads just `name` (1) and `dependency` (3) out of a serialized FileDescriptorProto. */
function peekFileDescriptor(bytes: Uint8Array): { name: string; dependencies: string[] } {
  const reader = protobuf.Reader.create(bytes);
  let name = '';
  const dependencies: string[] = [];
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    if (field === 1) name = reader.string();
    else if (field === 3) dependencies.push(reader.string());
    else reader.skipType(tag & 7);
  }
  return { name, dependencies };
}
