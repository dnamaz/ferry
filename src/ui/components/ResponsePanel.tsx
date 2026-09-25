import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { CallResult } from '../../grpc/invoke.js';
import { type HttpResult, jsonBody, looksBinary } from '../../http/client.js';
import { theme } from '../theme.js';
import { formatBytes, formatDuration, truncate } from '../util.js';

export type AnyResult = CallResult | HttpResult;
export const isHttpResult = (r: AnyResult | undefined): r is HttpResult => !!r && 'kind' in r && r.kind === 'http';
import { JsonLine } from './JsonLine.js';
import { type Segment, formatPath, jsonLines, valueToString } from '../../core/jsonpath.js';

export type ResponseTab = 'messages' | 'metadata';

interface Props {
  width: number;
  height: number;
  focused: boolean;
  result?: AnyResult;
  tab: ResponseTab;
  offset: number;
  spinner: string;
  /** absolute line index of the value cursor (select mode) */
  cursor?: number;
}

export interface ResponseLine {
  text: string;
  kind: 'comment' | 'error' | 'json' | 'meta' | 'text';
  /** message index + field path, on lines holding a scalar value */
  path?: Segment[];
  value?: unknown;
}

/** Lines shown in the response body for the given tab. */
export function responseLines(result: AnyResult | undefined, tab: ResponseTab): ResponseLine[] {
  if (!result) return [];
  if (isHttpResult(result)) return httpLines(result, tab);
  if (tab === 'metadata') {
    const section = (title: string, pairs: Array<[string, string]>): ResponseLine[] => [
      { text: `// ${title}`, kind: 'comment' },
      ...(pairs.length ? pairs.map(([k, v]) => ({ text: `${k}: ${v}`, kind: 'meta' as const })) : [{ text: '(none)', kind: 'comment' as const }]),
      { text: '', kind: 'comment' },
    ];
    return [...section('response headers', result.headers), ...section('trailers', result.trailers)];
  }
  const lines: ResponseLine[] = [];
  if (result.error) lines.push({ text: `// ${result.error}`, kind: 'error' }, { text: '', kind: 'comment' });
  if (result.state === 'error' && result.details) lines.push({ text: `// ${result.codeName}: ${result.details}`, kind: 'error' }, { text: '', kind: 'comment' });
  const many = result.messages.length > 1;
  result.messages.forEach((m, i) => {
    if (many) lines.push({ text: `// message ${i + 1}`, kind: 'comment' });
    for (const l of jsonLines(m, [i])) lines.push({ text: l.text, kind: 'json', path: l.path, value: l.value });
    if (many) lines.push({ text: '', kind: 'comment' });
  });
  return lines;
}

const MAX_TEXT_LINES = 20_000;

function httpLines(r: HttpResult, tab: ResponseTab): ResponseLine[] {
  if (tab === 'metadata') {
    return [
      { text: `// ${r.status ?? ''} ${r.statusText ?? ''}  ${r.url ?? ''}`.trimEnd(), kind: 'comment' },
      ...(r.headers.length ? r.headers.map(([k, v]) => ({ text: `${k}: ${v}`, kind: 'meta' as const })) : [{ text: '(none)', kind: 'comment' as const }]),
    ];
  }
  const lines: ResponseLine[] = [];
  if (r.error) lines.push({ text: `// ${r.error}`, kind: 'error' }, { text: '', kind: 'comment' });
  if (!r.body.length) {
    if (r.state !== 'running' && r.status !== undefined) lines.push({ text: '// (empty body)', kind: 'comment' });
    return lines;
  }
  if (looksBinary(r.body, r.contentType)) {
    lines.push(
      { text: `// binary body · ${formatBytes(r.body.length)} · ${r.contentType ?? 'unknown type'}`, kind: 'comment' },
      { text: '// press s to save it to a file', kind: 'comment' },
    );
    return lines;
  }
  const json = r.state === 'running' ? undefined : jsonBody(r);
  if (json !== undefined) {
    for (const l of jsonLines(json)) lines.push({ text: l.text, kind: 'json', path: l.path, value: l.value });
    return lines;
  }
  const text = r.body.toString('utf8').split('\n');
  for (const t of text.slice(0, MAX_TEXT_LINES)) lines.push({ text: t.replace(/\r$/, ''), kind: 'text' });
  if (text.length > MAX_TEXT_LINES) lines.push({ text: `// … ${text.length - MAX_TEXT_LINES} more lines (s to save the full body)`, kind: 'comment' });
  return lines;
}

function statusColor(status?: number): string {
  if (!status) return theme.error;
  if (status < 300) return theme.ok;
  if (status < 400) return theme.info;
  if (status < 500) return theme.warn;
  return theme.error;
}

export function ResponsePanel({ width, height, focused, result, tab, offset, spinner, cursor }: Props) {
  const inner = width - 4;
  const bodyHeight = Math.max(1, height - 4);
  const lines = useMemo(() => responseLines(result, tab), [result, tab]);

  let status: React.ReactNode = <Text color={theme.muted}>ctrl+r to send</Text>;
  if (isHttpResult(result)) {
    const took = formatDuration(result.durationMs ?? Date.now() - result.startedAt);
    const size = formatBytes(result.body.length);
    if (result.state === 'running') {
      status = (
        <Text wrap="truncate-end">
          <Text color={theme.info}>{spinner} {result.status ? `${result.status} receiving` : 'waiting'}</Text>
          <Text color={theme.muted}> · {took} · {size} · ctrl+c: cancel</Text>
        </Text>
      );
    } else if (result.status === undefined) {
      status = (
        <Text wrap="truncate-end">
          <Text color={result.state === 'cancelled' ? theme.warn : theme.error} bold>
            ✗ {result.state === 'cancelled' ? 'CANCELLED' : 'REQUEST FAILED'}
          </Text>
          <Text color={theme.muted}> · {took}</Text>
        </Text>
      );
    } else {
      status = (
        <Text wrap="truncate-end">
          <Text color={statusColor(result.status)} bold>
            ● {result.status} {result.statusText}
          </Text>
          <Text color={theme.muted}>
            {' '}
            · {took} · {size}
            {result.contentType ? ` · ${result.contentType.split(';')[0]}` : ''}
          </Text>
        </Text>
      );
    }
  } else if (result) {
    const count = result.messages.length;
    const stats = [formatDuration(result.durationMs ?? Date.now() - result.startedAt), `${count} msg${count === 1 ? '' : 's'}`];
    if (result.sent > 1) stats.push(`${result.sent} sent`);
    if (result.state === 'running') {
      status = (
        <Text>
          <Text color={theme.info}>{spinner} running</Text>
          <Text color={theme.muted}> · {stats.join(' · ')} · ctrl+c: cancel</Text>
        </Text>
      );
    } else {
      const ok = result.state === 'done';
      const label = result.error && result.code === undefined ? 'CLIENT ERROR' : result.state === 'cancelled' ? 'CANCELLED' : `${result.codeName} (${result.code})`;
      status = (
        <Text wrap="truncate-end">
          <Text color={ok ? theme.ok : result.state === 'cancelled' ? theme.warn : theme.error} bold>
            {ok ? '● ' : '✗ '}
            {label}
          </Text>
          <Text color={theme.muted}> · {stats.join(' · ')}</Text>
        </Text>
      );
    }
  }

  const selected = cursor !== undefined ? lines[cursor] : undefined;
  if (selected) {
    const where = selected.path ? formatPath(selected.path) : '';
    const shown = selected.path ? valueToString(selected.value) : '';
    status = (
      <Text wrap="truncate-end">
        <Text color={theme.accent} bold>
          SELECT{' '}
        </Text>
        <Text color={theme.json.key}>{where}</Text>
        <Text color={theme.muted}> = </Text>
        <Text color={theme.json.string}>{truncate(shown, Math.max(8, inner - where.length - 40))}</Text>
        <Text color={theme.muted}> · enter: use · y: copy · esc: done</Text>
      </Text>
    );
  }

  const tabLabel = (t: ResponseTab, label: string) => (
    <Text bold={tab === t} underline={tab === t} color={tab === t ? (focused ? theme.accent : theme.text) : theme.muted}>
      {label}
    </Text>
  );

  const visible = lines.slice(offset, offset + bodyHeight);
  const scrollInfo = lines.length > bodyHeight ? ` ${offset + 1}-${Math.min(lines.length, offset + bodyHeight)}/${lines.length}` : '';

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={focused ? theme.borderFocus : theme.border} paddingX={1}>
      <Box>
        <Text bold color={focused ? theme.accent : theme.text}>
          Response{' '}
        </Text>
        {tabLabel('messages', isHttpResult(result) ? 'Body' : 'Messages')}
        <Text color={theme.muted}> │ </Text>
        {isHttpResult(result)
          ? tabLabel('metadata', `Headers (${result.headers.length})`)
          : tabLabel('metadata', `Metadata${result ? ` (${result.headers.length + result.trailers.length})` : ''}`)}
        <Text color={theme.muted}>{scrollInfo}</Text>
      </Box>
      <Box>{status}</Box>
      <Box flexDirection="column" height={bodyHeight}>
        {visible.map((line, i) => {
          const at = offset + i;
          const isCursor = at === cursor;
          const bg = isCursor ? theme.selection.bg : undefined;
          if (line.kind === 'comment' || line.kind === 'error') {
            return (
              <Text key={at} color={line.kind === 'error' ? theme.error : theme.muted} wrap="truncate-end">
                {truncate(line.text, inner)}
              </Text>
            );
          }
          if (line.kind === 'text') {
            return (
              <Text key={at} wrap="truncate-end">
                {truncate(line.text, inner) || ' '}
              </Text>
            );
          }
          if (line.kind === 'meta') {
            const key = line.text.split(':')[0]!;
            return (
              <Text key={at} wrap="truncate-end">
                <Text color={theme.json.key}>{key}</Text>
                <Text>{truncate(line.text.slice(key.length), inner - key.length)}</Text>
              </Text>
            );
          }
          return isCursor ? (
            <Box key={at}>
              <Text backgroundColor={bg} color={theme.accent} bold wrap="truncate-end">
                {truncate(line.text, inner)}
              </Text>
            </Box>
          ) : (
            <JsonLine key={at} line={line.text} width={inner} />
          );
        })}
      </Box>
    </Box>
  );
}
