import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as protoLoader from '@grpc/proto-loader';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema, FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';

export function expandHome(p: string): string {
  return p.startsWith('~/') ? resolve(process.env.HOME ?? '', p.slice(2)) : p;
}

function resolvePaths(paths: string[], baseDir: string): string[] {
  return paths
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const expanded = expandHome(p);
      return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
    });
}

/** Parses .proto sources and returns serialized FileDescriptorProtos. */
export async function loadProtoFiles(files: string[], importPaths: string[] = [], baseDir = process.cwd()): Promise<Uint8Array[]> {
  const protoPaths = resolvePaths(files, baseDir);
  if (!protoPaths.length) throw new Error('No .proto files configured');
  for (const f of protoPaths) if (!existsSync(f)) throw new Error(`Proto file not found: ${f}`);

  const includeDirs = [...resolvePaths(importPaths, baseDir), ...new Set(protoPaths.map((p) => dirname(p)))];
  const definition = await protoLoader.load(protoPaths, {
    includeDirs,
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  });

  // Every message/enum/method definition carries the serialized descriptors of the whole file set.
  const byContent = new Map<string, Uint8Array>();
  for (const value of Object.values(definition)) {
    const candidates: unknown[] = [];
    if ('fileDescriptorProtos' in value) candidates.push(value);
    else for (const m of Object.values(value as Record<string, unknown>)) candidates.push((m as { requestType?: unknown }).requestType);
    for (const c of candidates) {
      const fdps = (c as { fileDescriptorProtos?: Buffer[] } | undefined)?.fileDescriptorProtos;
      for (const buf of fdps ?? []) byContent.set(buf.toString('base64'), new Uint8Array(buf));
    }
  }
  return [...byContent.values()];
}

/** Reads `protoc -o` / `buf build -o` FileDescriptorSet files. */
export function loadProtosets(files: string[], baseDir = process.cwd()): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const file of resolvePaths(files, baseDir)) {
    const set = fromBinary(FileDescriptorSetSchema, readFileSync(file));
    for (const f of set.file) out.push(toBinary(FileDescriptorProtoSchema, f));
  }
  return out;
}
