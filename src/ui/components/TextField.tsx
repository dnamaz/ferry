import React, { useRef, useReducer } from 'react';
import { Text, useInput } from 'ink';
import { theme } from '../theme.js';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  mask?: string;
  focus?: boolean;
  /** visible width; the view scrolls horizontally around the cursor */
  width?: number;
}

/**
 * Single-line input. Unlike ink-text-input it ignores ctrl/meta combos, so
 * global shortcuts (ctrl+r, ctrl+s...) never leak characters into the field.
 */
export function TextField({ value, onChange, onSubmit, placeholder, mask, focus = true, width }: Props) {
  const state = useRef({ value, cursor: value.length });
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  if (state.current.value !== value) {
    state.current = { value, cursor: Math.min(state.current.cursor, value.length) };
    if (state.current.cursor === 0 && value) state.current.cursor = value.length;
  }

  const set = (v: string, cursor: number) => {
    state.current = { value: v, cursor: Math.max(0, Math.min(cursor, v.length)) };
    if (v !== value) onChange(v);
    rerender();
  };

  useInput(
    (input, key) => {
      const { value: v, cursor } = state.current;
      if (key.return) return onSubmit?.(v);
      if (key.upArrow || key.downArrow || key.tab || key.escape) return;
      if (key.leftArrow) return set(v, cursor - 1);
      if (key.rightArrow) return set(v, cursor + 1);
      if (key.home || (key.ctrl && input === 'a')) return set(v, 0);
      if (key.end || (key.ctrl && input === 'e')) return set(v, v.length);
      if (key.ctrl && input === 'u') return set(v.slice(cursor), 0);
      if (key.ctrl && input === 'k') return set(v.slice(0, cursor), cursor);
      if (key.ctrl && input === 'w') {
        const before = v.slice(0, cursor).replace(/\S+\s*$/, '');
        return set(before + v.slice(cursor), before.length);
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        return set(v.slice(0, cursor - 1) + v.slice(cursor), cursor - 1);
      }
      if (key.ctrl || key.meta || !input) return;
      const text = input.replace(/[\r\n]+/g, ' ');
      set(v.slice(0, cursor) + text + v.slice(cursor), cursor + text.length);
    },
    { isActive: focus },
  );

  const { value: v, cursor } = state.current;
  const shown = mask ? mask.repeat(v.length) : v;
  if (!shown && placeholder) {
    return (
      <Text>
        {focus ? <Text inverse> </Text> : null}
        <Text color={theme.muted}>{placeholder}</Text>
      </Text>
    );
  }
  const w = width ?? 10_000;
  const start = Math.max(0, cursor - w + 1);
  const view = shown.slice(start, start + w);
  const c = cursor - start;
  if (!focus) return <Text wrap="truncate-end">{view}</Text>;
  return (
    <Text wrap="truncate-end">
      {view.slice(0, c)}
      <Text inverse>{view[c] ?? ' '}</Text>
      {view.slice(c + 1)}
    </Text>
  );
}
