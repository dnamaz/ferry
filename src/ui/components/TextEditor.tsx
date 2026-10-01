import React, { useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { clamp, tryFormatJson } from '../util.js';
import { CursorLine, JsonLine, PlainLine, type VarLookup, varAt } from './JsonLine.js';
import { TextField } from './TextField.js';

interface Props {
  value: string;
  onChange: (value: string) => void;
  width: number;
  height: number;
  active: boolean;
  onExit?: () => void;
  /** show JSON syntax colors */
  json?: boolean;
  /** colors `{{vars}}` by whether they have a value */
  vars?: VarLookup;
  /** enables enter on a `{{var}}` to set its value in place */
  onSetVar?: (name: string, value: string) => void;
}

interface EditorState {
  text: string;
  row: number;
  col: number;
  scroll: number;
}

/**
 * Minimal multi-line editor. State lives in a ref so bursts of keystrokes
 * (fast typing, pastes split into chunks) never apply to a stale value.
 *
 * Keys: arrows, home/end, ctrl+a/ctrl+e (line start/end), pgup/pgdn,
 * enter (auto-indent), tab (2 spaces), backspace, ctrl+d (delete forward),
 * ctrl+k (kill to end of line), ctrl+u (kill to start), ctrl+f (format JSON), esc (exit).
 * With `onSetVar`, enter on a `{{var}}` edits the variable's value on a row under the line instead.
 */
export function TextEditor({ value, onChange, width, height, active, onExit, json = true, vars, onSetVar }: Props) {
  const state = useRef<EditorState>({ text: value, row: 0, col: 0, scroll: 0 });
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [varEdit, setVarEdit] = useState<{ name: string; draft: string } | undefined>();

  // Adopt external changes (template generation, formatting from outside...).
  if (state.current.text !== value) {
    state.current.text = value;
    const lines = value.split('\n');
    state.current.row = clamp(state.current.row, 0, lines.length - 1);
    state.current.col = clamp(state.current.col, 0, lines[state.current.row]!.length);
  }

  const gutter = 4;
  const textWidth = Math.max(4, width - gutter - 1);

  const commit = (lines: string[], row: number, col: number) => {
    const s = state.current;
    s.text = lines.join('\n');
    s.row = clamp(row, 0, lines.length - 1);
    s.col = clamp(col, 0, lines[s.row]!.length);
    if (s.row < s.scroll) s.scroll = s.row;
    if (s.row >= s.scroll + height) s.scroll = s.row - height + 1;
    onChange(s.text);
    rerender();
  };

  useInput(
    (input, key) => {
      const s = state.current;
      const lines = s.text.split('\n');
      const line = lines[s.row] ?? '';
      const { row, col } = s;

      if (key.escape) return onExit?.();
      if (key.upArrow) return commit(lines, row - 1, col);
      if (key.downArrow) return commit(lines, row + 1, col);
      if (key.leftArrow) {
        if (col === 0 && row > 0) return commit(lines, row - 1, lines[row - 1]!.length);
        return commit(lines, row, col - 1);
      }
      if (key.rightArrow) {
        if (col >= line.length && row < lines.length - 1) return commit(lines, row + 1, 0);
        return commit(lines, row, col + 1);
      }
      if (key.pageUp) return commit(lines, row - height, col);
      if (key.pageDown) return commit(lines, row + height, col);
      if (key.home || (key.ctrl && input === 'a')) return commit(lines, row, 0);
      if (key.end || (key.ctrl && input === 'e')) return commit(lines, row, line.length);

      if (key.ctrl && input === 'f') {
        const formatted = tryFormatJson(s.text);
        if (formatted) commit(formatted.split('\n'), row, col);
        return;
      }
      if (key.ctrl && input === 'k') {
        if (col >= line.length && row < lines.length - 1) {
          lines.splice(row, 2, line + lines[row + 1]);
        } else lines[row] = line.slice(0, col);
        return commit(lines, row, col);
      }
      if (key.ctrl && input === 'u') {
        lines[row] = line.slice(col);
        return commit(lines, row, 0);
      }
      if (key.ctrl && input === 'd') {
        if (col < line.length) lines[row] = line.slice(0, col) + line.slice(col + 1);
        else if (row < lines.length - 1) lines.splice(row, 2, line + lines[row + 1]);
        return commit(lines, row, col);
      }
      // Ink reports the Backspace key (\x7f) as `delete` on most terminals.
      if (key.backspace || key.delete) {
        if (col > 0) {
          // Delete a whole indent step when only whitespace precedes the cursor.
          const before = line.slice(0, col);
          const n = /^\s+$/.test(before) && col % 2 === 0 ? 2 : 1;
          lines[row] = line.slice(0, col - n) + line.slice(col);
          return commit(lines, row, col - n);
        }
        if (row > 0) {
          const prevLen = lines[row - 1]!.length;
          lines.splice(row - 1, 2, lines[row - 1] + line);
          return commit(lines, row - 1, prevLen);
        }
        return;
      }
      if (key.return) {
        const onVar = onSetVar ? varAt(line, col) : undefined;
        if (onVar) return setVarEdit({ name: onVar.name, draft: vars?.(onVar.name) ?? '' });
        const indent = /^\s*/.exec(line)![0];
        const before = line.slice(0, col);
        const after = line.slice(col);
        const opens = /[{[]\s*$/.test(before);
        const closes = /^\s*[}\]]/.test(after);
        const inner = opens ? `${indent}  ` : indent;
        if (opens && closes) {
          lines.splice(row, 1, before, inner, indent + after.trimStart());
        } else {
          lines.splice(row, 1, before, inner + after.trimStart());
        }
        return commit(lines, row + 1, inner.length);
      }
      if (key.tab) {
        lines[row] = `${line.slice(0, col)}  ${line.slice(col)}`;
        return commit(lines, row, col + 2);
      }
      if (key.ctrl || key.meta || !input) return;

      // Typed or pasted text.
      const text = input.replace(/\r\n?/g, '\n');
      const inserted = (line.slice(0, col) + text + line.slice(col)).split('\n');
      lines.splice(row, 1, ...inserted);
      const lastInserted = text.split('\n');
      const newRow = row + lastInserted.length - 1;
      const newCol = lastInserted.length > 1 ? lastInserted.at(-1)!.length : col + text.length;
      commit(lines, newRow, newCol);
    },
    { isActive: active && !varEdit },
  );
  useInput(
    (_, key) => {
      if (key.escape) setVarEdit(undefined);
    },
    { isActive: active && !!varEdit },
  );

  const s = state.current;
  const lines = s.text.split('\n');
  // Keep the cursor row on screen after resizes.
  useLayoutEffect(() => {
    if (s.row >= s.scroll + height) {
      s.scroll = Math.max(0, s.row - height + 1);
      rerender();
    }
  });

  const hOffset = active ? Math.max(0, s.col - textWidth + 1) : 0;
  // The value row takes one line under the cursor line; keep the cursor line on screen above it.
  const textRows = varEdit ? Math.max(1, height - 1) : height;
  const scroll = varEdit && s.row >= s.scroll + textRows ? s.row - textRows + 1 : s.scroll;
  const visible = lines.slice(scroll, scroll + textRows);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {visible.map((line, i) => {
        const lineNo = scroll + i;
        const isCursorLine = active && lineNo === s.row;
        return (
          <React.Fragment key={lineNo}>
            <Box>
              <Text color={isCursorLine ? theme.accent : theme.muted} dimColor={!isCursorLine}>
                {String(lineNo + 1).padStart(gutter - 1)}{' '}
              </Text>
              {isCursorLine ? (
                <CursorLine line={line} col={s.col} offset={hOffset} width={textWidth} vars={vars} />
              ) : json ? (
                <JsonLine line={line} width={textWidth} offset={hOffset} vars={vars} />
              ) : (
                <PlainLine line={line} width={textWidth} offset={hOffset} vars={vars} />
              )}
            </Box>
            {isCursorLine && varEdit ? (
              <Box>
                <Text color={theme.accent}>{'  ↳ '}</Text>
                <Text color={theme.info} bold>{`{{${varEdit.name}}} = `}</Text>
                <TextField
                  value={varEdit.draft}
                  onChange={(draft) => setVarEdit((v) => (v ? { ...v, draft } : v))}
                  onSubmit={(v) => {
                    setVarEdit(undefined);
                    onSetVar?.(varEdit.name, v);
                  }}
                  placeholder="value · enter: save · esc: cancel"
                  width={Math.max(4, width - varEdit.name.length - 12)}
                />
              </Box>
            ) : null}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

