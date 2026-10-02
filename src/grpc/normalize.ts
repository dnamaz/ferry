import { type DescField, type DescMessage, create, toJson } from '@bufbuild/protobuf';
import { DurationSchema, TimestampSchema } from '@bufbuild/protobuf/wkt';

const WRAPPERS = new Set(
  ['Double', 'Float', 'Int64', 'UInt64', 'Int32', 'UInt32', 'Bool', 'String', 'Bytes'].map((t) => `google.protobuf.${t}Value`),
);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Obj, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

/**
 * Rewrites the protobufjs "object" form some tools save (Bruno, @grpc/proto-loader) into
 * canonical proto3 JSON for `desc`:
 *   Timestamp / Duration  {"seconds": "1767225600", "nanos": 0}  → "2026-01-01T00:00:00Z" / "1767225600s"
 *   wrapper types          {"value": "x"}                         → "x"
 *   map fields             [{"key": "k", "value": "v"}]           → {"k": "v"}
 * Canonical input never has these shapes, so it passes through unchanged. Anything that
 * doesn't match is left alone for fromJson to report.
 */
export function normalizeJson(desc: DescMessage, value: unknown): unknown {
  if (!isObj(value)) return value;
  const out: Obj = {};
  for (const [key, v] of Object.entries(value)) {
    const field = desc.fields.find((f) => f.name === key || f.jsonName === key);
    out[key] = field ? normalizeField(field, v) : v;
  }
  return out;
}

function normalizeField(field: DescField, value: unknown): unknown {
  switch (field.fieldKind) {
    case 'message':
      return normalizeMessage(field.message, value);
    case 'list':
      return field.listKind === 'message' && Array.isArray(value) ? value.map((v) => normalizeMessage(field.message, v)) : value;
    case 'map': {
      const entries = Array.isArray(value) && value.every((e) => isObj(e) && 'key' in e && onlyKeys(e, ['key', 'value']));
      const obj = entries ? Object.fromEntries((value as Obj[]).map((e) => [String(e.key), e.value])) : value;
      if (field.mapKind !== 'message' || !isObj(obj)) return obj;
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, normalizeMessage(field.message, v)]));
    }
    default:
      return value;
  }
}

function normalizeMessage(desc: DescMessage, value: unknown): unknown {
  if (!isObj(value)) return value;
  switch (desc.typeName) {
    case 'google.protobuf.Timestamp':
    case 'google.protobuf.Duration':
      return onlyKeys(value, ['seconds', 'nanos']) ? secondsNanos(desc.typeName, value) : value;
    case 'google.protobuf.Struct':
    case 'google.protobuf.Value':
    case 'google.protobuf.ListValue':
    case 'google.protobuf.Any':
      return value;
  }
  if (WRAPPERS.has(desc.typeName)) {
    if (!onlyKeys(value, ['value'])) return value;
    return 'value' in value ? value.value : toJson(desc, create(desc));
  }
  return normalizeJson(desc, value);
}

function secondsNanos(typeName: string, o: Obj): unknown {
  try {
    const init = { seconds: BigInt((o.seconds as string | number | undefined) ?? 0), nanos: Number(o.nanos ?? 0) };
    return typeName === 'google.protobuf.Timestamp' ? toJson(TimestampSchema, create(TimestampSchema, init)) : toJson(DurationSchema, create(DurationSchema, init));
  } catch {
    return o; // out of range or not a number: let fromJson explain
  }
}
