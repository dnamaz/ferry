import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { CallResult } from '../../grpc/invoke.js';
import { type HttpResult, jsonBody, looksBinary } from '../../http/client.js';
import type { ScriptOutcome, ScriptPhase } from '../../core/scripts.js';
import type { PhaseName, Timing } from '../../core/timing.js';
import { theme } from '../theme.js';
import { formatBytes, formatDuration, truncate, wrapText } from '../util.js';

export interface ScriptRun {
  phase: ScriptPhase;
  outcome: ScriptOutcome;
  /** hides secret values */
  mask: (name: string, value: string) => string;
}
export type AnyResult = (CallResult | HttpResult) & { scripts?: ScriptRun[] };
export const isHttpResult = (r: AnyResult | undefined): r is HttpResult => !!r && 'kind' in r && r.kind === 'http';
import { JsonLine } from './JsonLine.js';
import { type Segment, formatPath, jsonLines, valueToString } from '../../core/jsonpath.js';

export type ResponseTab = 'messages' | 'metadata' | 'timing';
export const RESPONSE_TABS: ResponseTab[] = ['messages', 'metadata', 'timing'];

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

/** Lines shown in the response body for the given tab; error lines wrap to `width` so long messages stay readable. */
export function responseLines(result: AnyResult | undefined, tab: ResponseTab, width?: number): ResponseLine[] {
  if (!result) return [];
  if (tab === 'timing') return timingLines(result, width);
  const lines = tab === 'metadata' ? [...bodyLines(result, tab), ...scriptLines(result.scripts)] : [...scriptErrors(result.scripts), ...bodyLines(result, tab)];
  if (!width) return lines;
  return lines.flatMap((l) =>
    l.kind === 'error' ? wrapText(l.text, width, l.text.startsWith('// ') ? '//   ' : '  ').map((text) => ({ ...l, text })) : [l],
  );
}

/** Script errors and failed tests, shown above the response body. */
function scriptErrors(runs: ScriptRun[] = []): ResponseLine[] {
  const lines: ResponseLine[] = runs.flatMap(({ outcome }) => [
    ...(outcome.error ? [{ text: `// ${outcome.error}`, kind: 'error' as const }] : []),
    ...outcome.tests.filter((t) => !t.passed).map((t) => ({ text: `// ✗ test "${t.name}": ${t.error}`, kind: 'error' as const })),
  ]);
  return lines.length ? [...lines, { text: '// (m: script output)', kind: 'comment' }, { text: '', kind: 'comment' }] : [];
}

const PHASE_HINT: Record<PhaseName, string> = {
  prepare: 'build the request',
  redirect: 'earlier hops',
  dns: 'resolve host name',
  connect: 'TCP handshake',
  tls: 'TLS handshake',
  http2: 'HTTP/2 settings',
  send: 'upload body',
  wait: 'network round trip + server',
  receive: 'body / stream',
};

/** The Timing tab: one bar per phase, then what the server says it spent. */
export function timingLines(result: AnyResult, width = 80): ResponseLine[] {
  const t: Timing | undefined = result.timing;
  if (!t) {
    const why = result.state === 'running' ? 'shown once the response is complete' : 'none: the request never went out';
    return [{ text: `// timing ${why}`, kind: 'comment' }];
  }
  const total = t.phases.reduce((sum, p) => sum + p.ms, 0);
  const label = Math.max(...t.phases.map((p) => p.name.length)) + 1;
  const num = Math.max(...t.phases.map((p) => fmtMs(p.ms).length));
  const hint = Math.max(...t.phases.map((p) => PHASE_HINT[p.name].length));
  const barMax = Math.max(4, width - label - num - hint - 10);
  const lines: ResponseLine[] = [
    { text: `// ${fmtMs(total)} total · ${t.reused ? 'reused an open connection (no dns/connect/tls)' : 'new connection'}`, kind: 'comment' },
    { text: '', kind: 'comment' },
  ];
  for (const p of t.phases) {
    const bar = total > 0 ? '█'.repeat(Math.round((p.ms / total) * barMax)) || (p.ms > 0 ? '▏' : '') : '';
    lines.push({ text: `${`${p.name}:`.padEnd(label + 1)}${fmtMs(p.ms).padStart(num)}  ${PHASE_HINT[p.name].padEnd(hint)}  ${bar}`, kind: 'meta' });
  }
  const sizes = transferSizes(result);
  lines.push(
    { text: '', kind: 'comment' },
    { text: `// ${sizes.note}`, kind: 'comment' },
    { text: `sent:     ${sizes.sent}`, kind: 'meta' },
    { text: `received: ${sizes.received}`, kind: 'meta' },
  );
  if (t.serverMs !== undefined) {
    const wait = t.phases.find((p) => p.name === 'wait')?.ms;
    lines.push({ text: '', kind: 'comment' }, { text: `// server reported ${fmtMs(t.serverMs)} (${t.serverSource})`, kind: 'comment' });
    if (wait !== undefined) lines.push({ text: `// so about ${fmtMs(Math.max(0, wait - t.serverMs))} of the ${fmtMs(wait)} wait is network and proxies`, kind: 'comment' });
  }
  return lines;
}

function transferSizes(r: AnyResult): { sent: string; received: string; note: string } {
  if (isHttpResult(r)) return { sent: formatBytes(r.requestBytes ?? 0), received: formatBytes(r.body.length), note: 'body sizes (headers not included)' };
  const msgs = (n: number) => ` in ${n} message${n === 1 ? '' : 's'}`;
  return {
    sent: formatBytes(r.requestBytes ?? 0) + msgs(r.sent),
    received: formatBytes(r.responseBytes ?? 0) + msgs(r.messages.length),
    note: 'protobuf message sizes (metadata and the 5-byte frame header per message not included)',
  };
}

const fmtMs = (ms: number) => `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;

function scriptLines(runs: ScriptRun[] = []): ResponseLine[] {
  return runs.flatMap(({ phase, outcome, mask }): ResponseLine[] => {
    const lines: ResponseLine[] = [{ text: '', kind: 'comment' }, { text: `// ${phase === 'before' ? 'pre-request' : 'post-response'} scripts (${outcome.ran})`, kind: 'comment' }];
    for (const s of outcome.set) {
      lines.push(
        s.value === undefined
          ? { text: `unset {{${s.name}}}`, kind: 'meta' }
          : { text: `set {{${s.name}}}: ${mask(s.name, s.value)}${s.where ? `  (${s.where})` : '  (not stored: no environment or collection)'}`, kind: s.where ? 'meta' : 'error' },
      );
    }
    for (const [name, value] of Object.entries(outcome.locals)) lines.push({ text: `local {{${name}}}: ${mask(name, value)}`, kind: 'meta' });
    for (const t of outcome.tests) lines.push({ text: `${t.passed ? '✓' : '✗'} ${t.name}${t.error ? `: ${t.error}` : ''}`, kind: t.passed ? 'text' : 'error' });
    for (const l of outcome.logs) lines.push({ text: l, kind: 'text' });
    if (outcome.error) lines.push({ text: outcome.error, kind: 'error' });
    if (lines.length === 2) lines.push({ text: '(no output)', kind: 'comment' });
    return lines;
  });
}

function bodyLines(result: AnyResult, tab: ResponseTab): ResponseLine[] {
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
  const lines = useMemo(() => responseLines(result, tab, inner), [result, tab, inner]);

  let status: React.ReactNode = <Text color={theme.muted}>ctrl+r to send</Text>;
  if (isHttpResult(result)) {
    const took = formatDuration(result.durationMs ?? Date.now() - result.startedAt);
    const size = formatBytes(result.body.length);
    if (result.state === 'running') {
      status = (
        <Text wrap="truncate-end">
          <Text color={theme.info}>{spinner} {result.status ? `${result.status} receiving` : 'waiting'}</Text>
          <Text color={theme.muted}> · {took} · ↓ {size} · ctrl+c: cancel</Text>
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
            · {took} · ↑ {formatBytes(result.requestBytes ?? 0)} ↓ {size}
            {result.contentType ? ` · ${result.contentType.split(';')[0]}` : ''}
          </Text>
        </Text>
      );
    }
  } else if (result) {
    const count = result.messages.length;
    const stats = [
      formatDuration(result.durationMs ?? Date.now() - result.startedAt),
      `↑ ${result.sent > 1 ? `${result.sent} msgs ` : ''}${formatBytes(result.requestBytes ?? 0)}`,
      `↓ ${count} msg${count === 1 ? '' : 's'} ${formatBytes(result.responseBytes ?? 0)}`,
    ];
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
        <Text color={theme.muted}> │ </Text>
        {tabLabel('timing', 'Timing')}
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
