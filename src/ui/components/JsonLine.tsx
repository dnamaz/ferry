import React from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';
import { type Token, tokenizeJsonLine } from '../util.js';

const COLORS: Record<Token['kind'], string | undefined> = {
  key: theme.json.key,
  string: theme.json.string,
  number: theme.json.number,
  literal: theme.json.literal,
  punct: theme.json.punct,
  plain: undefined,
  var: theme.accent,
};

/** Clips tokens to the visible window [offset, offset + width). */
function clip(tokens: Token[], offset: number, width: number): Token[] {
  const out: Token[] = [];
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

export function JsonLine({ line, width, offset = 0, dim }: { line: string; width: number; offset?: number; dim?: boolean }) {
  const tokens = clip(tokenizeJsonLine(line), offset, width);
  return (
    <Text wrap="truncate-end" dimColor={dim}>
      {tokens.length === 0 ? ' ' : tokens.map((t, i) => (
        <Text key={i} color={COLORS[t.kind]} bold={t.kind === 'var'}>
          {t.text}
        </Text>
      ))}
    </Text>
  );
}
