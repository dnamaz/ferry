/**
 * Captures pull values out of a response into variables after every
 * successful call, so one request can feed the next (List → Get).
 *
 * They round-trip through Postman as an afterResponse script:
 *   pm.environment.set("addressId", pm.response.messages.idx(0).data.addressId);
 */
import { type Segment, getAtPath, parsePath, valueToString } from './jsonpath.js';
import type { Capture, Script } from './model.js';

const IDENT = /^[A-Za-z_$][\w$]*$/;

function accessor(segments: Segment[]): string {
  return segments.map((s) => (typeof s === 'number' ? `[${s}]` : IDENT.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`)).join('');
}

export interface CaptureResult {
  variable: string;
  path: string;
  value?: string;
  error?: string;
}

/** Evaluates captures against response messages (path segment 0 is the message index). */
export function evaluateCaptures(captures: Capture[], messages: unknown[]): CaptureResult[] {
  return captures
    .filter((c) => c.variable && c.path)
    .map((c) => {
      const segments = parsePath(c.path);
      if (!segments) return { ...c, error: `invalid path "${c.path}"` };
      const [first, ...rest] = segments;
      const index = typeof first === 'number' ? first : 0;
      const path = typeof first === 'number' ? rest : segments;
      if (index >= messages.length) return { ...c, error: `no message #${index + 1} (got ${messages.length})` };
      const value = getAtPath(messages[index], path);
      if (value === undefined) return { ...c, error: `nothing at ${c.path}` };
      return { ...c, value: valueToString(value) };
    });
}

/**
 * HTTP captures address the JSON response body directly (`access_token`,
 * `items[0].id`, or `[0].id` for a top-level array).
 */
export function evaluateHttpCaptures(captures: Capture[], body: unknown): CaptureResult[] {
  return evaluateCaptures(
    captures.map((c) => ({ ...c, path: `[0]${c.path.startsWith('[') ? '' : '.'}${c.path}` })),
    [body],
  ).map((r, i) => ({ ...r, path: captures[i]!.path, error: r.error?.replace(/\[0\]\.?/, '') }));
}

export function httpCapturesToScript(captures: Capture[]): Script {
  const lines = captures.map((c) => `pm.environment.set(${JSON.stringify(c.variable)}, pm.response.json()${accessor(parsePath(c.path) ?? [])});`);
  return { type: 'afterResponse', code: lines.join('\n'), language: 'text/javascript' };
}

export function capturesToScript(captures: Capture[]): Script {
  const lines = captures.map((c) => {
    const segments = parsePath(c.path) ?? [0];
    const [first, ...rest] = segments;
    const index = typeof first === 'number' ? first : 0;
    const path = typeof first === 'number' ? rest : segments;
    return `pm.environment.set(${JSON.stringify(c.variable)}, pm.response.messages.idx(${index}).data${accessor(path)});`;
  });
  return { type: 'afterResponse', code: lines.join('\n'), language: 'text/javascript' };
}

const SET = String.raw`pm\.(?:environment|collectionVariables|variables|globals)\.set\(\s*(["'])(.+?)\1\s*,\s*`;
const ACCESSOR = String.raw`((?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[(?:"(?:[^"\\]|\\.)*"|'[^']*')\])*)`;
const HTTP_DIRECT = new RegExp(String.raw`^\s*${SET}pm\.response\.json\(\)${ACCESSOR}\s*\)\s*;?\s*$`);

/**
 * Finds capture-shaped statements in an HTTP post-response script. Handles the
 * direct form and the common "assign, then set" idiom:
 *
 *   pm.environment.set("token", pm.response.json().access_token);
 *   var t = pm.response.json().access_token; ... pm.environment.set("token", t);
 *   (Bruno) bru.setEnvVar("token", res.getBody().access_token) / res.body.access_token
 *
 * Returns `exact` when the script contains nothing else (it can then be
 * replaced by captures on export); otherwise the script must be kept.
 */
export function httpScriptCaptures(code: string): { captures: Capture[]; exact: boolean } {
  const captures: Capture[] = [];
  let exact = true;
  const assigned = new Map<string, string>();
  const assign = new RegExp(String.raw`(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pm\.response\.json\(\)|res\.getBody\(\)|res\.body)${ACCESSOR}\s*;?`, 'g');
  for (const m of code.matchAll(assign)) assigned.set(m[1]!, (m[2] ?? '').replace(/^\./, ''));
  const setter = new RegExp(
    String.raw`(?:pm\.(?:environment|collectionVariables|variables|globals)\.set|bru\.(?:setEnvVar|setVar|setGlobalEnvVar))\(\s*(["'])(.+?)\1\s*,\s*(.+?)\s*\)\s*(?:;|$)`,
    'gm',
  );
  for (const m of code.matchAll(setter)) {
    const name = m[2]!;
    const expr = m[3]!.trim();
    const direct = new RegExp(String.raw`^(?:pm\.response\.json\(\)|res\.getBody\(\)|res\.body)${ACCESSOR}$`).exec(expr);
    if (direct) captures.push({ variable: name, path: (direct[1] ?? '').replace(/^\./, '') });
    else if (assigned.has(expr)) captures.push({ variable: name, path: assigned.get(expr)! });
  }
  for (const line of code.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('//') && !HTTP_DIRECT.test(t)) exact = false;
  }
  return { captures: captures.filter((c) => c.path), exact: exact && captures.length > 0 };
}

const LINE =
  /^\s*pm\.(?:environment|collectionVariables|variables|globals)\.set\(\s*(["'])(.+?)\1\s*,\s*pm\.response\.messages\.idx\(\s*(\d+)\s*\)\.data((?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[(?:"(?:[^"\\]|\\.)*"|'[^']*')\])*)\s*\)\s*;?\s*$/;

/**
 * Converts an afterResponse script back into captures when it consists only
 * of capture statements (plus blank lines and // comments); otherwise returns
 * undefined so the script is kept verbatim.
 */
export function scriptToCaptures(script: Script): Capture[] | undefined {
  if (!/afterResponse$/i.test(script.type)) return undefined;
  const captures: Capture[] = [];
  for (const line of script.code.split('\n')) {
    if (!line.trim() || line.trim().startsWith('//')) continue;
    const m = LINE.exec(line);
    if (!m) return undefined;
    captures.push({ variable: m[2]!, path: `[${m[3]}]${m[4] ?? ''}` });
  }
  return captures.length ? captures : undefined;
}
