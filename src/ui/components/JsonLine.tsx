import React from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';
import { type CodeToken, type Token, tokenizeCodeLine, tokenizeJsonLine, truncate } from '../util.js';

const COLORS: Record<Token['kind'], string | undefined> = {
  key: theme.json.key,
  string: theme.json.string,
  number: theme.json.number,
  literal: theme.json.literal,
  punct: theme.json.punct,
  plain: undefined,
  var: theme.accent,
};

/** Value of `{{name}}` in the active scopes, or undefined when nothing defines it. */
export type VarLookup = (name: string) => string | undefined;

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Whether a `{{var}}` token resolves to a non-empty value (true without a lookup). */
function varSet(token: string, vars?: VarLookup): boolean {
  return !vars || !!vars(token.replace(/^\{\{\s*|\s*\}\}$/g, ''));
}

/** `{{vars}}` with a value use the accent, empty or undefined ones red (like the variables table). */
export function varColor(token: string, vars?: VarLookup): string {
  return varSet(token, vars) ? theme.vars.set : theme.vars.empty;
}

/** The `{{var}}` at column `col` of `line` (cursor on it or just after it). */
export function varAt(line: string, col: number): { name: string; start: number; end: number } | undefined {
  for (const m of line.matchAll(VAR_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (col >= start && col <= end) return { name: m[1]!, start, end };
  }
  return undefined;
}

type Segment = { text: string; color?: string; bold?: boolean; underline?: boolean; cursor?: boolean };

/** Splits plain text into `{{var}}` and other segments. */
function varSegments(line: string, vars?: VarLookup): Segment[] {
  return line
    .split(/(\{\{[^{}]*\}\})/)
    .filter(Boolean)
    .map((p) => (p.startsWith('{{') ? { text: p, color: varColor(p, vars), bold: true, underline: !varSet(p, vars) } : { text: p }));
}

/** Clips segments to the visible window [offset, offset + width). */
function clip<T extends { text: string }>(tokens: T[], offset: number, width: number): T[] {
  const out: T[] = [];
  let pos = 0;
  for (const t of tokens) {
    const start = pos;
    const end = pos + t.text.length;
    pos = end;
    if (end <= offset) continue;
    if (start >= offset + width) break;
    const from = Math.max(0, offset - start);
    const to = Math.min(t.text.length, offset + width - start);
    out.push({ ...t, text: t.text.slice(from, to) });
  }
  return out;
}

/** `  → value` for the `{{vars}}` on a line that have one (several are joined with ` · `), else ''. */
export function varValuesSuffix(line: string, values?: VarLookup): string {
  if (!values) return '';
  const shown = [...line.matchAll(VAR_RE)].map((m) => values(m[1]!)).filter((v): v is string => v !== undefined);
  return shown.length ? `  → ${shown.join(' · ')}` : '';
}

/** Appends the muted `→ value` suffix in whatever room the visible text leaves. */
function withValues(segments: Segment[], line: string, width: number, values?: VarLookup): Segment[] {
  const suffix = varValuesSuffix(line, values);
  const used = segments.reduce((n, s) => n + s.text.length, 0);
  return suffix && used < width ? [...segments, { text: truncate(suffix, width - used), color: theme.muted }] : segments;
}

function Segments({ segments, dim }: { segments: Segment[]; dim?: boolean }) {
  return (
    <Text wrap="truncate-end" dimColor={dim}>
      {segments.length === 0 ? ' ' : segments.map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} underline={s.underline}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

interface LineProps {
  line: string;
  width: number;
  offset?: number;
  vars?: VarLookup;
  /** display values of `{{vars}}` (resolved, secrets masked); shown after the line as `→ value` */
  values?: VarLookup;
}

export function JsonLine({ line, width, offset = 0, dim, vars, values }: LineProps & { dim?: boolean }) {
  const segments = tokenizeJsonLine(line).map((t) => ({ text: t.text, color: t.kind === 'var' ? varColor(t.text, vars) : COLORS[t.kind], bold: t.kind === 'var', underline: t.kind === 'var' && !varSet(t.text, vars) }));
  return <Segments segments={withValues(clip(segments, offset, width), line, width, values)} dim={dim} />;
}

const CODE_COLORS: Record<CodeToken['kind'], string | undefined> = {
  comment: theme.muted,
  string: theme.json.string,
  number: theme.json.number,
  keyword: theme.info,
  literal: theme.json.literal,
  api: theme.accent,
  var: theme.vars.set,
  plain: undefined,
};

/** A JavaScript/TypeScript line (scripts). */
export function CodeLine({ line, width, offset = 0 }: { line: string; width: number; offset?: number }) {
  const segments = tokenizeCodeLine(line).map((t) => ({ text: t.text, color: CODE_COLORS[t.kind], bold: t.kind === 'api' }));
  return <Segments segments={clip(segments, offset, width)} />;
}

/** A non-JSON line with only `{{vars}}` highlighted. */
export function PlainLine({ line, width, offset = 0, vars, values }: LineProps) {
  return <Segments segments={withValues(clip(varSegments(line, vars), offset, width), line, width, values)} />;
}

/** The line being edited: `{{vars}}` highlighted, the cursor shown inverse. */
export function CursorLine({ line, col, offset, width, vars }: { line: string; col: number; offset: number; width: number; vars?: VarLookup }) {
  const visible = clip(varSegments(line, vars), offset, width);
  const c = col - offset;
  const out: Segment[] = [];
  let pos = 0;
  for (const s of visible) {
    const start = pos;
    pos += s.text.length;
    if (c < start || c >= pos) {
      out.push(s);
      continue;
    }
    const i = c - start;
    if (i > 0) out.push({ ...s, text: s.text.slice(0, i) });
    out.push({ ...s, text: s.text[i]!, cursor: true });
    if (i + 1 < s.text.length) out.push({ ...s, text: s.text.slice(i + 1) });
  }
  const atEnd = c >= pos;
  return (
    <Text wrap="truncate-end">
      {out.map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} underline={s.underline} inverse={s.cursor}>
          {s.text}
        </Text>
      ))}
      {atEnd ? <Text inverse> </Text> : null}
    </Text>
  );
}
