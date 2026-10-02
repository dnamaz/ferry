import { existsSync } from 'node:fs';

export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  if (s.length <= width) return s;
  return width <= 1 ? s.slice(0, width) : `${s.slice(0, width - 1)}…`;
}

/** Splits `s` into rows of at most `width` chars, breaking at spaces where possible; later rows start with `indent`. */
export function wrapText(s: string, width: number, indent = ''): string[] {
  if (width <= indent.length + 1 || s.length <= width) return [s];
  const rows: string[] = [];
  let rest = s;
  while (rest.length > width - (rows.length ? indent.length : 0)) {
    const room = width - (rows.length ? indent.length : 0);
    const space = rest.lastIndexOf(' ', room);
    const cut = space > room / 2 ? space : room;
    rows.push((rows.length ? indent : '') + rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) rows.push((rows.length ? indent : '') + rest);
  return rows;
}

export function padEnd(s: string, width: number): string {
  const t = truncate(s, width);
  return t + ' '.repeat(Math.max(0, width - t.length));
}

/** Keeps `index` visible in a window of `height` rows, returning the new scroll offset. */
export function scrollInto(index: number, offset: number, height: number): number {
  if (height <= 0) return 0;
  if (index < offset) return index;
  if (index >= offset + height) return index - height + 1;
  return offset;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Subsequence match used by pickers; returns a score (lower is better) or -1. */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    gaps += found - ti;
    ti = found + 1;
  }
  return 100 + gaps;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function tryFormatJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
}

export function jsonError(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try {
    JSON.parse(text);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

export type Token = { text: string; kind: 'key' | 'string' | 'number' | 'literal' | 'punct' | 'plain' | 'var' };

/** Line-level JSON tokenizer, good enough for highlighting (tolerates invalid JSON). */
export function tokenizeJsonLine(line: string): Token[] {
  const tokens: Token[] = [];
  const re = /(\{\{[^{}]*\}\})|("(?:[^"\\]|\\.)*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)|(true|false|null)|([{}[\],:])|(\s+)|([^\s"{}[\],:]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m[1]) tokens.push({ text: m[1], kind: 'var' });
    else if (m[2] !== undefined) {
      if (m[3]) {
        tokens.push({ text: m[2], kind: 'key' });
        tokens.push({ text: m[3], kind: 'punct' });
      } else {
        // variables inside strings get their own highlight
        const parts = m[2].split(/(\{\{[^{}]*\}\})/);
        for (const p of parts) if (p) tokens.push({ text: p, kind: p.startsWith('{{') ? 'var' : 'string' });
      }
    } else if (m[4]) tokens.push({ text: m[4], kind: 'number' });
    else if (m[5]) tokens.push({ text: m[5], kind: 'literal' });
    else if (m[6]) tokens.push({ text: m[6], kind: 'punct' });
    else tokens.push({ text: m[0], kind: 'plain' });
  }
  return tokens;
}

export function which(cmd: string): boolean {
  return (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(`${dir}/${cmd}`));
}
