import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import protobuf from 'protobufjs';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema, FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';

const require = createRequire(import.meta.url);
// Also adds toDescriptor() to protobufjs's reflection classes.
const descriptor = require('protobufjs/ext/descriptor') as { FileDescriptorProto: protobuf.Type };

// Well-known files protobufjs does not bundle itself (the same four @grpc/proto-loader registers).
for (const name of ['api', 'descriptor', 'source_context', 'type']) {
  const json = require(`protobufjs/google/protobuf/${name}.json`) as { nested: { google: { nested: { protobuf: { nested: protobuf.INamespace['nested'] } } } } };
  protobuf.common(name, json.nested.google.nested.protobuf.nested!);
}

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

interface FileDescriptor {
  name: string;
  package: string;
  syntax: string;
  messageType: unknown[];
  enumType: unknown[];
  extension: unknown[];
  service: unknown[];
}

/**
 * Splits a protobufjs root into one FileDescriptorProto per source file.
 *
 * protobufjs's own Root#toDescriptor (what @grpc/proto-loader uses) emits one synthetic file per
 * PACKAGE. Two packages whose files import each other in one direction each (tax/common.proto <-
 * sync/sync_tracking.proto <- tax/entities.proto) then import each other both ways, a cycle
 * protobuf-es refuses. Grouping on each object's `filename` keeps the real file structure, which
 * protoc guarantees acyclic. Objects with no filename (bundled well-known types) keep the
 * per-package grouping. Imports are recomputed by repairDescriptors.
 */
function fileDescriptors(root: protobuf.Root, includeDirs: string[]): FileDescriptor[] {
  const files = new Map<string, FileDescriptor>();
  const displayName = (filename: string) => {
    for (const dir of includeDirs) {
      const rel = relative(dir, filename);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
    }
    return filename;
  };
  const fileFor = (obj: protobuf.ReflectionObject, ns: protobuf.Namespace): FileDescriptor => {
    const pkg = ns instanceof protobuf.Root ? '' : ns.fullName.slice(1);
    const name = obj.filename ? displayName(obj.filename) : `${pkg.replace(/\./g, '_') || 'root'}.proto`;
    let file = files.get(name);
    if (!file) files.set(name, (file = { name, package: pkg, syntax: 'proto3', messageType: [], enumType: [], extension: [], service: [] }));
    return file;
  };
  type Describable = { toDescriptor(edition?: string): unknown };
  const walk = (ns: protobuf.Namespace) => {
    for (const nested of ns.nestedArray) {
      const d = nested as unknown as Describable;
      if (nested instanceof protobuf.Type) fileFor(nested, ns).messageType.push(d.toDescriptor('proto3'));
      else if (nested instanceof protobuf.Enum) fileFor(nested, ns).enumType.push(d.toDescriptor());
      else if (nested instanceof protobuf.Field) fileFor(nested, ns).extension.push(d.toDescriptor('proto3'));
      else if (nested instanceof protobuf.Service) fileFor(nested, ns).service.push(d.toDescriptor());
      else if (nested instanceof protobuf.Namespace) walk(nested);
    }
  };
  walk(root);
  return [...files.values()];
}

/** Parses .proto sources and returns serialized FileDescriptorProtos, one per source file. */
export async function loadProtoFiles(files: string[], importPaths: string[] = [], baseDir = process.cwd()): Promise<Uint8Array[]> {
  const protoPaths = resolvePaths(files, baseDir);
  if (!protoPaths.length) throw new Error('No .proto files configured');
  for (const f of protoPaths) if (!existsSync(f)) throw new Error(`Proto file not found: ${f}`);

  const includeDirs = [...resolvePaths(importPaths, baseDir), ...new Set(protoPaths.map((p) => dirname(p)))];
  const root = new protobuf.Root();
  const fallback = root.resolvePath.bind(root);
  root.resolvePath = (origin, target) => {
    if (isAbsolute(target)) return target;
    for (const dir of includeDirs) {
      const full = join(dir, target);
      if (existsSync(full)) return full;
    }
    return fallback(origin, target);
  };
  await root.load(protoPaths, { keepCase: true });
  root.resolveAll();

  return fileDescriptors(root, includeDirs).map((f) => descriptor.FileDescriptorProto.encode(descriptor.FileDescriptorProto.fromObject(f)).finish());
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
