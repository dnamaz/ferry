import {
  type DescEnum,
  type DescField,
  type DescMessage,
  type DescMethod,
  type DescService,
  type FileRegistry,
  ScalarType,
  create,
  createFileRegistry,
  fromBinary,
} from '@bufbuild/protobuf';
import {
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
  file_google_protobuf_any,
  file_google_protobuf_api,
  file_google_protobuf_descriptor,
  file_google_protobuf_duration,
  file_google_protobuf_empty,
  file_google_protobuf_field_mask,
  file_google_protobuf_source_context,
  file_google_protobuf_struct,
  file_google_protobuf_timestamp,
  file_google_protobuf_type,
  file_google_protobuf_wrappers,
} from '@bufbuild/protobuf/wkt';

const WKT_FILES = new Map(
  [
    file_google_protobuf_any,
    file_google_protobuf_api,
    file_google_protobuf_descriptor,
    file_google_protobuf_duration,
    file_google_protobuf_empty,
    file_google_protobuf_field_mask,
    file_google_protobuf_source_context,
    file_google_protobuf_struct,
    file_google_protobuf_timestamp,
    file_google_protobuf_type,
    file_google_protobuf_wrappers,
  ].map((f) => [f.proto.name, f.proto] as const),
);

export type MethodKind = DescMethod['methodKind'];

export interface MethodInfo {
  service: string;
  name: string;
  /** /pkg.Service/Method */
  path: string;
  kind: MethodKind;
  desc: DescMethod;
}

export interface ServiceInfo {
  name: string;
  methods: MethodInfo[];
}

/** Service schema built from FileDescriptorProtos (reflection, .proto files, or protosets). */
export class Schema {
  readonly registry: FileRegistry;
  readonly services: ServiceInfo[];

  constructor(files: Array<FileDescriptorProto | Uint8Array>, serviceFilter?: string[]) {
    const decoded = files.map((f) => (f instanceof Uint8Array ? fromBinary(FileDescriptorProtoSchema, f) : f));
    this.registry = createFileRegistry(create(FileDescriptorSetSchema, { file: repairDescriptors(decoded) }));

    const services: DescService[] = [];
    for (const file of this.registry.files) services.push(...file.services);
    const filter = serviceFilter ? new Set(serviceFilter) : undefined;
    this.services = services
      .filter((s) => !filter || filter.has(s.typeName))
      .sort((a, b) => a.typeName.localeCompare(b.typeName))
      .map((s) => ({
        name: s.typeName,
        methods: s.methods.map((m) => ({
          service: s.typeName,
          name: m.name,
          path: `/${s.typeName}/${m.name}`,
          kind: m.methodKind,
          desc: m,
        })),
      }));
  }

  get methods(): MethodInfo[] {
    return this.services.flatMap((s) => s.methods);
  }

  /** Accepts "/pkg.Svc/Method", "pkg.Svc/Method" or "pkg.Svc.Method". */
  findMethod(path: string): MethodInfo | undefined {
    const p = normalizeMethodPath(path);
    return this.methods.find((m) => m.path === p || m.path.toLowerCase() === p.toLowerCase());
  }
}

type Msg = FileDescriptorProto['messageType'][number];

function collectSymbols(file: FileDescriptorProto, into: Map<string, FileDescriptorProto>): void {
  const walk = (prefix: string, messages: Msg[], enums: FileDescriptorProto['enumType']) => {
    for (const e of enums) into.set(`${prefix}.${e.name}`, file);
    for (const m of messages) {
      const name = `${prefix}.${m.name}`;
      into.set(name, file);
      walk(name, m.nestedType, m.enumType);
    }
  };
  walk(file.package ? `.${file.package}` : '', file.messageType, file.enumType);
}

/** Every fully-qualified type a file references (fields, extensions, method signatures). */
function referencedTypes(file: FileDescriptorProto): Set<string> {
  const refs = new Set<string>();
  const walk = (m: Msg) => {
    for (const f of [...m.field, ...m.extension]) {
      if (f.typeName) refs.add(f.typeName);
      if (f.extendee) refs.add(f.extendee);
    }
    m.nestedType.forEach(walk);
  };
  file.messageType.forEach(walk);
  for (const ext of file.extension) {
    if (ext.typeName) refs.add(ext.typeName);
    if (ext.extendee) refs.add(ext.extendee);
  }
  for (const svc of file.service) for (const m of svc.method) refs.add(m.inputType).add(m.outputType);
  return refs;
}

const WKT_SYMBOLS = new Map<string, FileDescriptorProto>();
for (const wkt of WKT_FILES.values()) collectSymbols(wkt, WKT_SYMBOLS);

/**
 * Makes descriptor sets from any source acceptable to protobuf-es:
 *
 * - protoc writes fully-qualified type references (".pkg.Msg"), but
 *   protobufjs-generated descriptors (@grpc/proto-loader, @grpc/reflection
 *   servers) write them relative to the current scope ("Msg", "Item.Status").
 * - protobufjs also regroups types into one synthetic file per package with
 *   empty `dependency` lists, so imports are recomputed from actual references.
 * - Servers often omit well-known types; bundled copies are added when a
 *   referenced symbol isn't defined anywhere.
 * - Files are returned in dependency order.
 */
export function repairDescriptors(input: FileDescriptorProto[]): FileDescriptorProto[] {
  const byName = new Map<string, FileDescriptorProto>();
  for (const f of input) if (!byName.has(f.name)) byName.set(f.name, f);
  const files = [...byName.values()];

  const symbols = new Map<string, FileDescriptorProto>();
  for (const f of files) collectSymbols(f, symbols);
  const exists = (name: string) => symbols.has(name) || WKT_SYMBOLS.has(name);

  const resolve = (ref: string, scope: string): string => {
    if (!ref || ref.startsWith('.')) return ref;
    // Walk outward from the innermost scope: .a.b.C + ref, .a.b + ref, .a + ref, ref.
    for (let s = scope; ; s = s.slice(0, s.lastIndexOf('.'))) {
      const candidate = `${s}.${ref}`;
      if (exists(candidate)) return candidate;
      if (!s) break;
    }
    return ref;
  };

  const TYPE_MESSAGE = 11;
  const TYPE_ENUM = 14;
  const isEnum = (name: string) => {
    const file = symbols.get(name) ?? WKT_SYMBOLS.get(name);
    return !!file && findEnum(file, name);
  };
  const fixMessage = (m: Msg, scope: string) => {
    const name = `${scope}.${m.name}`;
    for (const field of [...m.field, ...m.extension]) {
      if (!field.jsonName) field.jsonName = jsonName(field.name);
      if (field.typeName) {
        field.typeName = resolve(field.typeName, name);
        if (!field.type) field.type = isEnum(field.typeName) ? TYPE_ENUM : TYPE_MESSAGE;
      }
      if (field.extendee) field.extendee = resolve(field.extendee, name);
    }
    for (const nested of m.nestedType) fixMessage(nested, name);
  };
  for (const f of files) {
    const scope = f.package ? `.${f.package}` : '';
    for (const m of f.messageType) fixMessage(m, scope);
    for (const ext of f.extension) {
      if (ext.typeName) ext.typeName = resolve(ext.typeName, scope);
      if (ext.extendee) ext.extendee = resolve(ext.extendee, scope);
    }
    for (const svc of f.service) {
      for (const method of svc.method) {
        method.inputType = resolve(method.inputType, scope);
        method.outputType = resolve(method.outputType, scope);
      }
    }
  }

  // Recompute imports and pull in missing well-known types.
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const deps = new Set(file.dependency.filter((d) => byName.has(d) || WKT_FILES.has(d)));
    for (const ref of referencedTypes(file)) {
      let owner = symbols.get(ref);
      if (!owner) {
        owner = WKT_SYMBOLS.get(ref);
        if (owner && !byName.has(owner.name)) {
          byName.set(owner.name, owner);
          files.push(owner);
          collectSymbols(owner, symbols);
        }
      }
      if (owner && owner !== file) deps.add(owner.name);
    }
    for (const d of deps) {
      const wkt = WKT_FILES.get(d);
      if (!byName.has(d) && wkt) {
        byName.set(d, wkt);
        files.push(wkt);
        collectSymbols(wkt, symbols);
      }
    }
    file.dependency = [...deps];
    file.publicDependency = [];
    file.weakDependency = [];
  }

  // Topological order: dependencies first.
  const ordered: FileDescriptorProto[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (f: FileDescriptorProto) => {
    if (state.get(f.name)) return;
    state.set(f.name, 'visiting');
    for (const d of f.dependency) {
      const dep = byName.get(d);
      if (dep) visit(dep);
    }
    state.set(f.name, 'done');
    ordered.push(f);
  };
  files.forEach(visit);
  return ordered;
}

/** protoc's ToJsonName: drop underscores and upper-case the following letter. */
function jsonName(protoName: string): string {
  return protoName.replace(/_+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''));
}

function findEnum(file: FileDescriptorProto, fqName: string): boolean {
  const walk = (prefix: string, messages: Msg[], enums: FileDescriptorProto['enumType']): boolean =>
    enums.some((e) => `${prefix}.${e.name}` === fqName) || messages.some((m) => walk(`${prefix}.${m.name}`, m.nestedType, m.enumType));
  return walk(file.package ? `.${file.package}` : '', file.messageType, file.enumType);
}

/** Canonical "/pkg.Service/Method" form of "/pkg.Svc/Method", "pkg.Svc/Method" or "pkg.Svc.Method". */
export function normalizeMethodPath(path: string): string {
  const p = path.trim();
  if (!p) return '';
  if (p.startsWith('/')) return p;
  if (p.includes('/')) return `/${p}`;
  const dot = p.lastIndexOf('.');
  return dot > 0 ? `/${p.slice(0, dot)}/${p.slice(dot + 1)}` : p;
}

export function kindLabel(kind: MethodKind): string {
  switch (kind) {
    case 'unary':
      return 'unary';
    case 'server_streaming':
      return 'server stream';
    case 'client_streaming':
      return 'client stream';
    case 'bidi_streaming':
      return 'bidi stream';
  }
}

export function isClientStreaming(kind: MethodKind): boolean {
  return kind === 'client_streaming' || kind === 'bidi_streaming';
}

// ---------------------------------------------------------------------------
// Example message generation
// ---------------------------------------------------------------------------

const WKT_TEMPLATES: Record<string, () => unknown> = {
  'google.protobuf.Timestamp': () => new Date().toISOString(),
  'google.protobuf.Duration': () => '1s',
  'google.protobuf.Empty': () => ({}),
  'google.protobuf.Struct': () => ({}),
  'google.protobuf.Value': () => null,
  'google.protobuf.ListValue': () => [],
  'google.protobuf.FieldMask': () => '',
  'google.protobuf.Any': () => ({ '@type': 'type.googleapis.com/' }),
  'google.protobuf.StringValue': () => '',
  'google.protobuf.BytesValue': () => '',
  'google.protobuf.BoolValue': () => false,
  'google.protobuf.DoubleValue': () => 0,
  'google.protobuf.FloatValue': () => 0,
  'google.protobuf.Int32Value': () => 0,
  'google.protobuf.UInt32Value': () => 0,
  'google.protobuf.Int64Value': () => '0',
  'google.protobuf.UInt64Value': () => '0',
};

function scalarTemplate(t: ScalarType): unknown {
  switch (t) {
    case ScalarType.STRING:
      return '';
    case ScalarType.BYTES:
      return '';
    case ScalarType.BOOL:
      return false;
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      return '0';
    default:
      return 0;
  }
}

function enumTemplate(e: DescEnum): unknown {
  // Prefer the first non-zero value: the zero value is usually *_UNSPECIFIED.
  return (e.values[1] ?? e.values[0])?.name ?? 0;
}

/** Builds an example JSON object with every field populated (first member of each oneof). */
export function messageTemplate(desc: DescMessage, depth = 0, seen: string[] = []): unknown {
  const wkt = WKT_TEMPLATES[desc.typeName];
  if (wkt) return wkt();
  if (depth > 4 || seen.includes(desc.typeName)) return {};
  const nextSeen = [...seen, desc.typeName];
  const out: Record<string, unknown> = {};
  const doneOneofs = new Set<string>();

  const valueFor = (field: DescField): unknown => {
    switch (field.fieldKind) {
      case 'scalar':
        return scalarTemplate(field.scalar);
      case 'enum':
        return enumTemplate(field.enum);
      case 'message':
        return messageTemplate(field.message, depth + 1, nextSeen);
      case 'list':
        if (field.listKind === 'scalar') return [scalarTemplate(field.scalar)];
        if (field.listKind === 'enum') return [enumTemplate(field.enum)];
        return [messageTemplate(field.message, depth + 1, nextSeen)];
      case 'map': {
        const key = field.mapKey === ScalarType.STRING ? 'key' : field.mapKey === ScalarType.BOOL ? 'true' : '0';
        const value =
          field.mapKind === 'scalar'
            ? scalarTemplate(field.scalar)
            : field.mapKind === 'enum'
              ? enumTemplate(field.enum)
              : messageTemplate(field.message, depth + 1, nextSeen);
        return { [key]: value };
      }
    }
  };

  for (const field of desc.fields) {
    if (field.oneof) {
      if (doneOneofs.has(field.oneof.name)) continue;
      doneOneofs.add(field.oneof.name);
    }
    out[field.jsonName] = valueFor(field);
  }
  return out;
}

export function methodTemplate(method: MethodInfo): string {
  const one = messageTemplate(method.desc.input);
  const value = isClientStreaming(method.kind) ? [one] : one;
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Proto-like description, for the schema viewer
// ---------------------------------------------------------------------------

function fieldTypeName(field: DescField): string {
  const scalarName = (t: ScalarType) => ScalarType[t]!.toLowerCase();
  switch (field.fieldKind) {
    case 'scalar':
      return scalarName(field.scalar);
    case 'enum':
      return field.enum.typeName;
    case 'message':
      return field.message.typeName;
    case 'list':
      return `repeated ${field.listKind === 'scalar' ? scalarName(field.scalar) : field.listKind === 'enum' ? field.enum.typeName : field.message.typeName}`;
    case 'map': {
      const v = field.mapKind === 'scalar' ? scalarName(field.scalar) : field.mapKind === 'enum' ? field.enum.typeName : field.message.typeName;
      return `map<${scalarName(field.mapKey)}, ${v}>`;
    }
  }
}

function describeMessage(desc: DescMessage): string[] {
  const lines = [`message ${desc.typeName} {`];
  const oneofOpen = new Set<string>();
  for (const member of desc.members) {
    if (member.kind === 'oneof') {
      if (oneofOpen.has(member.name)) continue;
      oneofOpen.add(member.name);
      lines.push(`  oneof ${member.name} {`);
      for (const f of member.fields) lines.push(`    ${fieldTypeName(f)} ${f.name} = ${f.number};`);
      lines.push('  }');
    } else {
      const optional = member.proto.proto3Optional ? 'optional ' : '';
      lines.push(`  ${optional}${fieldTypeName(member)} ${member.name} = ${member.number};`);
    }
  }
  lines.push('}');
  return lines;
}

function describeEnum(desc: DescEnum): string[] {
  return [`enum ${desc.typeName} {`, ...desc.values.map((v) => `  ${v.name} = ${v.number};`), '}'];
}

/** Proto-syntax dump of a method and every message/enum it transitively references. */
export function describeMethod(method: MethodInfo): string {
  const m = method.desc;
  const stream = (b: boolean) => (b ? 'stream ' : '');
  const clientStream = isClientStreaming(method.kind);
  const serverStream = method.kind === 'server_streaming' || method.kind === 'bidi_streaming';
  const out = [
    `rpc ${m.name}(${stream(clientStream)}${m.input.typeName}) returns (${stream(serverStream)}${m.output.typeName});`,
    '',
  ];
  const seen = new Set<string>();
  const queue: Array<DescMessage | DescEnum> = [m.input, m.output];
  while (queue.length) {
    const d = queue.shift()!;
    if (seen.has(d.typeName) || d.typeName.startsWith('google.protobuf.')) continue;
    seen.add(d.typeName);
    if (d.kind === 'enum') {
      out.push(...describeEnum(d), '');
      continue;
    }
    out.push(...describeMessage(d), '');
    for (const f of d.fields) {
      if (f.fieldKind === 'message') queue.push(f.message);
      else if (f.fieldKind === 'enum') queue.push(f.enum);
      else if (f.fieldKind === 'list' && f.listKind === 'message') queue.push(f.message);
      else if (f.fieldKind === 'list' && f.listKind === 'enum') queue.push(f.enum);
      else if (f.fieldKind === 'map' && f.mapKind === 'message') queue.push(f.message);
      else if (f.fieldKind === 'map' && f.mapKind === 'enum') queue.push(f.enum);
    }
  }
  return out.join('\n').trimEnd();
}
