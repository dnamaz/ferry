/**
 * Minimal JSON paths over gRPC responses, used to pick values out of one
 * response and feed them into another request.
 *
 * A path starts with the message index, then JS-style accessors:
 *   [0].addressId      [3].items[1].sku      [0]["weird-key"]
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Segment = string | number;

const IDENT = /^[A-Za-z_$][\w$]*$/;

export function formatPath(segments: Segment[]): string {
  return segments
    .map((s, i) => (typeof s === 'number' ? `[${s}]` : IDENT.test(s) ? (i === 0 ? s : `.${s}`) : `[${JSON.stringify(s)}]`))
    .join('');
}

export function parsePath(path: string): Segment[] | undefined {
  const out: Segment[] = [];
  const re = /\[(\d+)\]|\.?([A-Za-z_$][\w$]*)|\[("(?:[^"\\]|\\.)*"|'[^']*')\]/y;
  let i = 0;
  const p = path.trim();
  while (i < p.length) {
    re.lastIndex = i;
    const m = re.exec(p);
    if (!m) return undefined;
    if (m[1] !== undefined) out.push(Number(m[1]));
    else if (m[2] !== undefined) out.push(m[2]);
    else {
      const q = m[3]!;
      out.push(q.startsWith('"') ? (JSON.parse(q) as string) : q.slice(1, -1));
    }
    i = re.lastIndex;
  }
  return out.length ? out : undefined;
}

export function getAtPath(root: unknown, segments: Segment[]): unknown {
  let cur: unknown = root;
  for (const s of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[s];
  }
  return cur;
}

/** Value as it should appear in a variable: strings raw, everything else as JSON. */
export function valueToString(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Pretty-printing with a path per line
// ---------------------------------------------------------------------------

export interface JsonLine {
  text: string;
  /** full path including the message index, for lines that hold a scalar */
  path?: Segment[];
  value?: Json;
}

/** Pretty-prints like JSON.stringify(v, null, 2), recording the path of every scalar line. */
export function jsonLines(value: unknown, prefix: Segment[] = []): JsonLine[] {
  const lines: JsonLine[] = [];
  const walk = (v: Json, path: Segment[], indent: string, lead: string, trail: string) => {
    if (v !== null && typeof v === 'object') {
      const isArray = Array.isArray(v);
      const entries: Array<[Segment, Json]> = isArray ? (v as Json[]).map((x, i) => [i, x]) : Object.entries(v);
      const [open, close] = isArray ? ['[', ']'] : ['{', '}'];
      if (!entries.length) {
        lines.push({ text: `${indent}${lead}${open}${close}${trail}` });
        return;
      }
      lines.push({ text: `${indent}${lead}${open}` });
      entries.forEach(([k, child], i) => {
        const childLead = isArray ? '' : `${JSON.stringify(k)}: `;
        walk(child, [...path, k], `${indent}  `, childLead, i < entries.length - 1 ? ',' : '');
      });
      lines.push({ text: `${indent}${close}${trail}` });
      return;
    }
    lines.push({ text: `${indent}${lead}${JSON.stringify(v)}${trail}`, path, value: v });
  };
  walk(value as Json, prefix, '', '', '');
  return lines;
}

/** Scalar leaves of a JSON document, for choosing a target field. */
export function leaves(value: unknown): Array<{ path: Segment[]; value: Json }> {
  return jsonLines(value)
    .filter((l) => l.path && l.path.length > 0)
    .map((l) => ({ path: l.path!, value: l.value! }));
}

/** Returns `text` (a JSON document) with the value at `path` replaced, pretty-printed. */
export function setInJsonText(text: string, path: Segment[], value: unknown): string {
  const doc = JSON.parse(text.trim() || '{}') as Json;
  if (!path.length) return JSON.stringify(value, null, 2);
  let cur = doc as Record<string | number, Json>;
  for (const s of path.slice(0, -1)) {
    if (cur[s] === null || typeof cur[s] !== 'object') cur[s] = typeof s === 'number' ? [] : {};
    cur = cur[s] as Record<string | number, Json>;
  }
  cur[path.at(-1)!] = value as Json;
  return JSON.stringify(doc, null, 2);
}

/** Field names compare equal across proto_name / jsonName / case differences. */
export function normalizeKey(s: Segment): string {
  return String(s).replace(/[_-]/g, '').toLowerCase();
}

/**
 * Suggests a variable name for a picked value, e.g. `[0].addressId` → addressId,
 * `[0].id` from ListAddresses → addressId, `[0].price.units` → priceUnits.
 */
export function suggestVariableName(path: Segment[], methodName = ''): string {
  const keys = path.filter((s): s is string => typeof s === 'string');
  const last = keys.at(-1) ?? 'value';
  const camel = (s: string) => s.replace(/[_-]+(\w)/g, (_, c: string) => c.toUpperCase());
  if (last.toLowerCase() === 'id') {
    const parent = keys.at(-2) ?? methodName.replace(/^(List|Get|Search|Stream|Find|Batch)/, '');
    const singular = /ies$/.test(parent)
      ? parent.replace(/ies$/, 'y')
      : /(ss|sh|ch|x|z)es$/.test(parent)
        ? parent.replace(/es$/, '')
        : /(us|ss|is)$/.test(parent)
          ? parent
          : parent.replace(/s$/, '');
    return camel(`${singular.charAt(0).toLowerCase()}${singular.slice(1)}Id`) || 'id';
  }
  if (keys.length >= 2 && /^(value|units|amount|code|name)$/i.test(last)) return camel(`${keys.at(-2)}_${last}`);
  return camel(last);
}
