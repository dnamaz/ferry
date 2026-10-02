import React from 'react';
import { Box, Text } from 'ink';
import type { HttpRequest } from '../../core/model.js';
import { kvSummary } from '../../core/resolve.js';
import { icons, theme } from '../theme.js';
import { jsonError, padEnd, truncate } from '../util.js';
import { JsonLine, PlainLine, type VarLookup } from './JsonLine.js';
import type { RequestField } from './RequestPanel.js';
import { TextEditor } from './TextEditor.js';
import { TextField } from './TextField.js';

export const METHOD_COLORS: Record<string, string> = {
  GET: 'green',
  POST: 'yellow',
  PUT: 'blue',
  PATCH: 'magenta',
  DELETE: 'red',
  HEAD: 'cyan',
  OPTIONS: 'cyan',
};

const LABELS: Partial<Record<RequestField, string>> = {
  name: 'Name',
  method: 'Method',
  url: 'URL',
  params: 'Params',
  pathvars: 'Path vars',
  headers: 'Headers',
  auth: 'Auth',
  body: 'Body',
  settings: 'Settings',
  captures: 'Captures',
  scripts: 'Scripts',
  message: 'Content',
};

const BODY_LABELS: Record<string, string> = {
  none: 'none',
  json: 'JSON',
  text: 'text',
  xml: 'XML',
  html: 'HTML',
  javascript: 'JavaScript',
  urlencoded: 'form-urlencoded',
  formdata: 'multipart form',
  graphql: 'GraphQL',
  file: 'file',
};

interface Props {
  width: number;
  height: number;
  focused: boolean;
  request: HttpRequest;
  fields: readonly RequestField[];
  breadcrumb: string;
  dirty: boolean;
  field: RequestField;
  editing?: 'name' | 'url';
  editValue: string;
  onEditChange: (v: string) => void;
  onEditSubmit: (v: string) => void;
  messageEditing: boolean;
  onMessageChange: (v: string) => void;
  onMessageExit: () => void;
  /** values of `{{vars}}` in the active scopes, for coloring the message */
  vars?: VarLookup;
  /** display values of `{{vars}}` (resolved, secrets masked), shown in grey after message lines */
  varValues?: VarLookup;
  /** sets a `{{var}}` from the message editor (enter on it) */
  onSetVar?: (name: string, value: string) => void;
  resolvedUrl?: string;
  authSummary: string;
  settingsSummary: string;
  capturesSummary: string;
  scriptsSummary: string;
}

/** Text shown in the body editor area: raw content, or a summary for structured bodies. */
export function bodyText(r: HttpRequest): { text: string; editable: boolean; json: boolean } {
  const b = r.body;
  switch (b.type) {
    case 'none':
      return { text: '', editable: false, json: false };
    case 'urlencoded':
    case 'formdata':
      return {
        text: (b.fields ?? []).map((f) => `${f.disabled ? '# ' : ''}${f.key}: ${f.type === 'file' ? `@${f.value}` : f.value}`).join('\n'),
        editable: false,
        json: false,
      };
    case 'file':
      return { text: b.content ? `file: ${b.content}` : '(no file selected)', editable: false, json: false };
    default:
      return { text: b.content ?? '', editable: true, json: b.type === 'json' };
  }
}

export function HttpRequestPanel(props: Props) {
  const { width, height, focused, request, field, fields } = props;
  const inner = width - 4;
  const labelWidth = 10;
  const valueWidth = inner - labelWidth - 2;

  const row = (f: RequestField, content: React.ReactNode) => {
    const selected = focused && field === f;
    return (
      <Box key={f} height={1}>
        <Box flexShrink={0} width={2 + labelWidth}>
          <Text color={selected ? theme.accent : theme.muted} bold={selected}>
            {selected ? '› ' : '  '}
            {padEnd(LABELS[f] ?? f, labelWidth)}
          </Text>
        </Box>
        <Box width={valueWidth} overflow="hidden">
          {content}
        </Box>
      </Box>
    );
  };
  const muted = (text: string) => (
    <Text color={theme.muted} wrap="truncate-end">
      {truncate(text, valueWidth)}
    </Text>
  );
  const plain = (text: string) => <Text wrap="truncate-end">{truncate(text, valueWidth)}</Text>;

  const textRow = (f: 'name' | 'url', value: string, placeholder: string, extra?: string) => {
    if (props.editing === f) return row(f, <TextField value={props.editValue} onChange={props.onEditChange} onSubmit={props.onEditSubmit} width={valueWidth} />);
    const shown = value || placeholder;
    return row(
      f,
      <Text wrap="truncate-end">
        <Text color={value ? undefined : theme.muted}>{truncate(shown, valueWidth)}</Text>
        {extra ? <Text color={theme.muted}>{truncate(`  → ${extra}`, Math.max(0, valueWidth - shown.length))}</Text> : null}
      </Text>,
    );
  };

  const body = bodyText(request);
  const bodyType = BODY_LABELS[request.body.type] ?? request.body.type;
  const err = body.json ? jsonError(body.text) : undefined;
  const rowsShown = fields.length - 1; // all but the content area
  // Header (1) + rows + separator (1) + borders (2)
  const editorHeight = Math.max(1, height - rowsShown - 5);
  const method = request.method.toUpperCase();

  const rendered = fields.map((f) => {
    switch (f) {
      case 'name':
        return textRow('name', request.name, 'untitled');
      case 'method':
        return row('method', <Text color={METHOD_COLORS[method] ?? theme.text} bold>{method}</Text>);
      case 'url':
        return textRow('url', request.url, 'https://api.example.com/path/:id', props.resolvedUrl && props.resolvedUrl !== request.url ? props.resolvedUrl : undefined);
      case 'params':
        return row('params', request.queryParams.length ? plain(kvSummary(request.queryParams)) : muted('none · enter to add query parameters'));
      case 'pathvars':
        return row('pathvars', plain(request.pathVariables.map((p) => `:${p.key}=${p.value || '∅'}`).join('  ')));
      case 'headers':
        return row('headers', request.headers.length ? plain(kvSummary(request.headers)) : muted('none'));
      case 'auth':
        return row('auth', plain(props.authSummary));
      case 'body':
        return row(
          'body',
          <Text wrap="truncate-end">
            <Text>{bodyType}</Text>
            {err ? <Text color={theme.error}> ✗ {truncate(err, Math.max(0, valueWidth - 20))}</Text> : body.json ? <Text color={theme.ok}> ✓</Text> : null}
          </Text>,
        );
      case 'settings':
        return row('settings', plain(props.settingsSummary));
      case 'captures':
        return row('captures', request.captures?.length ? plain(props.capturesSummary) : muted(props.capturesSummary));
      case 'scripts':
        return row('scripts', request.scripts?.length ? plain(props.scriptsSummary) : muted(props.scriptsSummary));
      case 'message':
        return (
          <React.Fragment key="message">
            <Text color={theme.border}>{'─'.repeat(inner)}</Text>
            {row(
              'message',
              muted(
                props.messageEditing
                  ? 'editing — esc to finish, ctrl+f format'
                  : focused && field === 'message'
                    ? body.editable
                      ? 'enter: edit · o: $EDITOR · f: format'
                      : 'enter: edit body'
                    : request.body.type === 'none'
                      ? `no body${['POST', 'PUT', 'PATCH'].includes(method) ? ' · set a type in Body' : ''}`
                      : '',
              ),
            )}
          </React.Fragment>
        );
      default:
        return null;
    }
  });

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={focused ? theme.borderFocus : theme.border} paddingX={1}>
      <Box>
        <Text bold color={focused ? theme.accent : theme.text}>
          Request{' '}
        </Text>
        <Text color={theme.muted} wrap="truncate-end">
          {truncate(props.breadcrumb, inner - 12)}
        </Text>
        {props.dirty ? <Text color={theme.warn}> {icons.dirty}unsaved</Text> : null}
      </Box>
      {rendered.slice(0, -1)}
      {rendered.at(-1)}
      {props.messageEditing && body.editable ? (
        <TextEditor value={body.text} onChange={props.onMessageChange} width={inner} height={editorHeight} active onExit={props.onMessageExit} json={body.json} vars={props.vars} onSetVar={props.onSetVar} />
      ) : (
        <Box flexDirection="column" height={editorHeight}>
          {(request.body.type === 'none' ? [] : body.text.split('\n'))
            .slice(0, editorHeight)
            .map((line, i) => (
              <Box key={i}>
                <Text color={theme.muted} dimColor>
                  {String(i + 1).padStart(3)}{' '}
                </Text>
                {body.json ? <JsonLine line={line} width={inner - 4} vars={props.vars} values={props.varValues} /> : <PlainLine line={line} width={inner - 4} vars={props.vars} values={props.varValues} />}
              </Box>
            ))}
        </Box>
      )}
    </Box>
  );
}
