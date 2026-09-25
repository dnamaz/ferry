import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextField as TextInput } from './TextField.js';
import { theme } from '../theme.js';
import { clamp, fuzzyScore, padEnd, scrollInto, truncate } from '../util.js';

export function ModalFrame({
  title,
  width,
  height,
  children,
  footer,
}: {
  title: string;
  width: number;
  height?: number;
  children: React.ReactNode;
  footer?: string;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.borderFocus} width={width} height={height} paddingX={1}>
      <Text bold color={theme.accent} wrap="truncate-end">
        {title}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
      {footer ? (
        <Text color={theme.muted} wrap="truncate-end">
          {footer}
        </Text>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------

export function PromptModal({
  title,
  initial = '',
  placeholder,
  hint,
  width,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial?: string;
  placeholder?: string;
  hint?: string;
  width: number;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  useInput((_, key) => {
    if (key.escape) onCancel();
  });
  return (
    <ModalFrame title={title} width={width} footer="enter: confirm · esc: cancel">
      {hint ? (
        <Text color={theme.muted} wrap="wrap">
          {hint}
        </Text>
      ) : null}
      <Box marginTop={hint ? 1 : 0}>
        <Text color={theme.accent}>› </Text>
        <TextInput value={value} onChange={setValue} onSubmit={(v) => onSubmit(v)} placeholder={placeholder} />
      </Box>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------------------

export function ConfirmModal({
  title,
  message,
  width,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  width: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if ((key.ctrl || key.meta) && !key.escape) return;
    if (input === 'y' || input === 'Y' || key.return) onConfirm();
    else if (input === 'n' || input === 'N' || key.escape) onCancel();
  });
  return (
    <ModalFrame title={title} width={width} footer="y/enter: yes · n/esc: no">
      <Text wrap="wrap">{message}</Text>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------------------

export interface PickerItem<T> {
  label: string;
  value: T;
  hint?: string;
  color?: string;
  /** extra text matched by the filter but not shown */
  keywords?: string;
}

export function PickerModal<T>({
  title,
  items,
  width,
  height,
  emptyText = 'Nothing to pick',
  initialIndex = 0,
  onSelect,
  onCancel,
  footer,
}: {
  title: string;
  items: PickerItem<T>[];
  width: number;
  height: number;
  emptyText?: string;
  initialIndex?: number;
  onSelect: (value: T) => void;
  onCancel: () => void;
  footer?: string;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(initialIndex);
  const [offset, setOffset] = useState(0);

  const filtered = useMemo(() => {
    if (!query) return items;
    return items
      .map((item) => ({ item, score: fuzzyScore(query, `${item.label} ${item.keywords ?? ''}`) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.item);
  }, [items, query]);

  const listHeight = Math.max(1, height - 5);
  const current = clamp(index, 0, Math.max(0, filtered.length - 1));
  const scroll = scrollInto(current, offset, listHeight);
  if (scroll !== offset) setOffset(scroll);

  useInput((_, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) return setIndex(clamp(current - 1, 0, filtered.length - 1));
    if (key.downArrow) return setIndex(clamp(current + 1, 0, filtered.length - 1));
    if (key.pageUp) return setIndex(clamp(current - listHeight, 0, filtered.length - 1));
    if (key.pageDown) return setIndex(clamp(current + listHeight, 0, filtered.length - 1));
    if (key.return && filtered[current]) onSelect(filtered[current]!.value);
  });

  const inner = width - 4;
  return (
    <ModalFrame title={title} width={width} height={height} footer={footer ?? '↑↓: move · type to filter · enter: select · esc: cancel'}>
      <Box>
        <Text color={theme.accent}>⌕ </Text>
        <TextInput
          value={query}
          onChange={(v) => {
            setQuery(v);
            setIndex(0);
            setOffset(0);
          }}
          placeholder="filter…"
        />
      </Box>
      {filtered.length === 0 ? (
        <Text color={theme.muted}>{emptyText}</Text>
      ) : (
        filtered.slice(scroll, scroll + listHeight).map((item, i) => {
          const selected = scroll + i === current;
          const hint = item.hint ? ` ${item.hint}` : '';
          const labelWidth = Math.max(4, inner - 2 - Math.min(hint.length, Math.floor(inner / 2)));
          return (
            <Box key={scroll + i}>
              <Text color={selected ? theme.accent : undefined}>{selected ? '› ' : '  '}</Text>
              <Text color={item.color} bold={selected} wrap="truncate-end">
                {padEnd(item.label, labelWidth)}
              </Text>
              <Text color={theme.muted} wrap="truncate-end">
                {truncate(hint, inner - 2 - labelWidth)}
              </Text>
            </Box>
          );
        })
      )}
    </ModalFrame>
  );
}

// ---------------------------------------------------------------------------

export function TextViewerModal({
  title,
  text,
  width,
  height,
  onClose,
  render,
  onCopy,
  wrap,
  altText,
  altLabel = 'reveal',
}: {
  title: string;
  text: string;
  width: number;
  height: number;
  onClose: () => void;
  render?: (line: string, width: number) => React.ReactNode;
  /** enables `y` to copy */
  onCopy?: () => void;
  /** soft-wrap long lines instead of truncating them */
  wrap?: boolean;
  /** alternate text shown while `v` is toggled (e.g. unmasked secrets) */
  altText?: string;
  altLabel?: string;
}) {
  const [alt, setAlt] = useState(false);
  const shownText = alt && altText !== undefined ? altText : text;
  const lines = useMemo(() => {
    const raw = shownText.split('\n');
    if (!wrap) return raw;
    const w = Math.max(10, width - 4);
    return raw.flatMap((line) => {
      if (line.length <= w) return [line];
      const out: string[] = [];
      for (let i = 0; i < line.length; i += i === 0 ? w : w - 4) out.push(i === 0 ? line.slice(0, w) : `    ${line.slice(i, i + w - 4)}`);
      return out;
    });
  }, [shownText, wrap, width]);
  const [offset, setOffset] = useState(0);
  const view = Math.max(1, height - 4);
  const max = Math.max(0, lines.length - view);
  useInput((input, key) => {
    if ((key.ctrl || key.meta) && !key.escape) return;
    if (key.escape || input === 'q' || key.return) return onClose();
    if (input === 'y' && onCopy) return onCopy();
    if (input === 'v' && altText !== undefined) return setAlt((a) => !a);
    if (key.upArrow || input === 'k') setOffset((o) => clamp(o - 1, 0, max));
    if (key.downArrow || input === 'j') setOffset((o) => clamp(o + 1, 0, max));
    if (key.pageUp) setOffset((o) => clamp(o - view, 0, max));
    if (key.pageDown || input === ' ') setOffset((o) => clamp(o + view, 0, max));
    if (key.home || input === 'g') setOffset(0);
    if (key.end || input === 'G') setOffset(max);
  });
  const footer = `${offset + 1}-${Math.min(lines.length, offset + view)} of ${lines.length} · ↑↓ pgup/pgdn: scroll${onCopy ? ' · y: copy' : ''}${altText !== undefined ? ` · v: ${alt ? 'hide' : altLabel}` : ''} · esc: close`;
  return (
    <ModalFrame title={title} width={width} height={height} footer={footer}>
      {lines.slice(offset, offset + view).map((line, i) => (
        <Box key={offset + i}>{render ? render(line, width - 4) : <Text wrap="truncate-end">{line || ' '}</Text>}</Box>
      ))}
    </ModalFrame>
  );
}

// ---------------------------------------------------------------------------

export type FormField =
  | { id: string; label: string; kind: 'text'; value: string; placeholder?: string; mask?: boolean; hint?: string }
  | { id: string; label: string; kind: 'toggle'; value: boolean; hint?: string }
  | { id: string; label: string; kind: 'select'; value: string; options: Array<{ value: string; label: string }>; hint?: string };

export type FormValues = Record<string, string | boolean>;

/**
 * Generic settings form. `fields` is recomputed from current values so
 * dependent fields can appear/disappear (e.g. proto paths for proto source).
 */
export function FormModal({
  title,
  width,
  fields: buildFields,
  initial,
  onSave,
  onCancel,
}: {
  title: string;
  width: number;
  fields: (values: FormValues) => FormField[];
  initial: FormValues;
  onSave: (values: FormValues) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<FormValues>(initial);
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState('');
  const fields = buildFields(values);
  const current = fields[clamp(index, 0, fields.length - 1)];

  const set = (id: string, v: string | boolean) => setValues((prev) => ({ ...prev, [id]: v }));
  const cycle = (dir: 1 | -1) => {
    if (!current) return;
    if (current.kind === 'toggle') set(current.id, !current.value);
    if (current.kind === 'select') {
      const i = current.options.findIndex((o) => o.value === current.value);
      const next = current.options[(i + dir + current.options.length) % current.options.length]!;
      set(current.id, next.value);
    }
  };

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === 's')) return onSave(values);
      if ((key.ctrl || key.meta) && !key.escape) return;
      if (key.upArrow) return setIndex((i) => clamp(i - 1, 0, fields.length - 1));
      if (key.downArrow || key.tab) return setIndex((i) => clamp(i + 1, 0, fields.length - 1));
      if (key.leftArrow) return cycle(-1);
      if (key.rightArrow || input === ' ') return cycle(1);
      if (key.return && current) {
        if (current.kind === 'text') {
          setDraft(current.value);
          setEditing(current.id);
        } else cycle(1);
      }
    },
    { isActive: !editing },
  );
  useInput(
    (_, key) => {
      if (key.escape) setEditing(undefined);
    },
    { isActive: !!editing },
  );

  const labelWidth = Math.min(22, Math.max(...fields.map((f) => f.label.length)) + 2);
  const valueWidth = width - 6 - labelWidth;

  return (
    <ModalFrame
      title={title}
      width={width}
      footer={editing ? 'enter: apply · esc: discard edit' : '↑↓: move · enter/space/←→: change · esc: save & close · ctrl+c: discard'}
    >
      {fields.map((f, i) => {
        const selected = i === index;
        let display: React.ReactNode;
        if (editing === f.id) {
          display = (
            <TextInput
              value={draft}
              onChange={setDraft}
              mask={f.kind === 'text' && f.mask ? '•' : undefined}
              onSubmit={(v) => {
                set(f.id, v);
                setEditing(undefined);
              }}
            />
          );
        } else if (f.kind === 'toggle') {
          display = <Text color={f.value ? theme.ok : theme.muted}>{f.value ? '● on' : '○ off'}</Text>;
        } else if (f.kind === 'select') {
          const label = f.options.find((o) => o.value === f.value)?.label ?? f.value;
          display = <Text color={theme.info}>‹ {label} ›</Text>;
        } else {
          const shown = f.mask && f.value ? '•'.repeat(Math.min(12, f.value.length)) : f.value;
          display = shown ? (
            <Text wrap="truncate-end">{truncate(shown, valueWidth)}</Text>
          ) : (
            <Text color={theme.muted}>{truncate(f.placeholder ?? '—', valueWidth)}</Text>
          );
        }
        return (
          <Box key={f.id} flexDirection="column">
            <Box>
              <Text color={selected ? theme.accent : undefined}>{selected ? '› ' : '  '}</Text>
              <Text bold={selected}>{padEnd(f.label, labelWidth)}</Text>
              {display}
            </Box>
            {selected && f.hint && !editing ? (
              <Text color={theme.muted} wrap="truncate-end">
                {'    '}
                {f.hint}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </ModalFrame>
  );
}

// ---------------------------------------------------------------------------

export interface KVRow {
  key: string;
  value: string;
  disabled?: boolean;
  secret?: boolean;
  description?: string;
}

/** Table editor for metadata, collection variables and environment values. */
export function KVEditorModal({
  title,
  rows: initialRows,
  width,
  height,
  allowSecret,
  keyLabel = 'KEY',
  valueLabel = 'VALUE',
  onSave,
  onCancel,
  hint,
}: {
  title: string;
  rows: KVRow[];
  width: number;
  height: number;
  allowSecret?: boolean;
  keyLabel?: string;
  valueLabel?: string;
  onSave: (rows: KVRow[]) => void;
  onCancel: () => void;
  hint?: string;
}) {
  const [rows, setRows] = useState<KVRow[]>(initialRows);
  const [index, setIndex] = useState(0);
  const [column, setColumn] = useState<'key' | 'value'>('key');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [offset, setOffset] = useState(0);

  const listHeight = Math.max(1, height - 6 - (hint ? 1 : 0));
  const current = clamp(index, 0, Math.max(0, rows.length - 1));
  const scroll = scrollInto(current, offset, listHeight);
  if (scroll !== offset) setOffset(scroll);

  const update = (i: number, patch: Partial<KVRow>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const startEdit = (i: number, col: 'key' | 'value') => {
    setColumn(col);
    setDraft(rows[i]?.[col] ?? '');
    setEditing(true);
  };

  useInput(
    (input, key) => {
      if (key.escape) return onSave(rows.filter((r) => r.key || r.value));
      if (key.ctrl && input === 's') return onSave(rows.filter((r) => r.key || r.value));
      if ((key.ctrl || key.meta) && !key.escape) return;
      if (key.upArrow || input === 'k') return setIndex(clamp(current - 1, 0, rows.length - 1));
      if (key.downArrow || input === 'j') return setIndex(clamp(current + 1, 0, rows.length - 1));
      if (key.leftArrow || key.rightArrow || key.tab) return setColumn((c) => (c === 'key' ? 'value' : 'key'));
      if (input === 'a' || input === 'n' || (key.return && rows.length === 0)) {
        const at = rows.length;
        setRows((prev) => [...prev, { key: '', value: '' }]);
        setIndex(at);
        setColumn('key');
        setDraft('');
        setEditing(true);
        return;
      }
      if (!rows.length) return;
      if (key.return || input === 'e') return startEdit(current, column);
      if (input === 'd') {
        setRows((prev) => prev.filter((_, j) => j !== current));
        return setIndex(clamp(current, 0, rows.length - 2));
      }
      if (input === ' ') return update(current, { disabled: !rows[current]!.disabled });
      if (input === 's' && allowSecret) return update(current, { secret: !rows[current]!.secret });
      if (input === 'v' && allowSecret) return setReveal((r) => !r);
    },
    { isActive: !editing },
  );
  useInput(
    (_, key) => {
      if (key.escape) {
        setEditing(false);
        // drop rows that were added and abandoned
        setRows((prev) => prev.filter((r, j) => j !== current || r.key || r.value));
      }
      if (key.tab) {
        update(current, { [column]: draft });
        startEdit(current, column === 'key' ? 'value' : 'key');
      }
    },
    { isActive: editing },
  );

  const inner = width - 4;
  const keyWidth = Math.max(10, Math.floor((inner - 4) * 0.35));
  const valueWidth = inner - 4 - keyWidth - 1 - (allowSecret ? 7 : 0);

  return (
    <ModalFrame
      title={title}
      width={width}
      height={height}
      footer={
        editing
          ? 'enter: apply · tab: next cell · esc: discard'
          : `a: add · enter: edit · ←→: column · space: enable/disable · d: delete${allowSecret ? ' · s: secret · v: reveal' : ''} · esc: save & close · ctrl+c: discard`
      }
    >
      {hint ? (
        <Text color={theme.muted} wrap="truncate-end">
          {hint}
        </Text>
      ) : null}
      <Box>
        <Text color={theme.muted}>
          {'    '}
          {padEnd(keyLabel, keyWidth)} {valueLabel}
        </Text>
      </Box>
      {rows.length === 0 ? <Text color={theme.muted}>  (empty — press a to add)</Text> : null}
      {rows.slice(scroll, scroll + listHeight).map((row, i) => {
        const at = scroll + i;
        const selected = at === current;
        const cell = (col: 'key' | 'value', w: number) => {
          if (selected && editing && column === col) {
            return (
              <Box width={w}>
                <TextInput
                  value={draft}
                  onChange={setDraft}
                  onSubmit={(v) => {
                    update(at, { [col]: v });
                    setEditing(false);
                  }}
                />
              </Box>
            );
          }
          let text = row[col];
          if (col === 'value' && row.secret && !reveal) text = text ? '••••••••' : '';
          const active = selected && column === col;
          return (
            <Text inverse={active} dimColor={row.disabled} wrap="truncate-end">
              {padEnd(text || (col === 'key' ? '<key>' : ''), w)}
            </Text>
          );
        };
        return (
          <Box key={at}>
            <Text color={selected ? theme.accent : undefined}>{selected ? '›' : ' '}</Text>
            <Text color={row.disabled ? theme.muted : theme.ok}>{row.disabled ? '○ ' : '● '}</Text>
            {cell('key', keyWidth)}
            <Text> </Text>
            {cell('value', valueWidth)}
            {row.secret ? <Text color={theme.warn}> secret</Text> : null}
          </Box>
        );
      })}
    </ModalFrame>
  );
}
