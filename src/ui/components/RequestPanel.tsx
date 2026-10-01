import React from 'react';
import { Box, Text } from 'ink';
import { TextField as TextInput } from './TextField.js';
import type { GrpcRequest } from '../../core/model.js';
import { kvSummary } from '../../core/resolve.js';
import { type MethodInfo, isClientStreaming, kindLabel } from '../../grpc/schema.js';
import { icons, theme } from '../theme.js';
import { jsonError, padEnd, truncate } from '../util.js';
import { JsonLine, type VarLookup } from './JsonLine.js';
import { TextEditor } from './TextEditor.js';

export const REQUEST_FIELDS = ['name', 'url', 'method', 'metadata', 'auth', 'settings', 'captures', 'scripts', 'message'] as const;
/** HTTP rows; `pathvars` is only shown when the URL has :variables. */
export const HTTP_FIELDS = ['name', 'method', 'url', 'params', 'pathvars', 'headers', 'auth', 'body', 'settings', 'captures', 'scripts', 'message'] as const;
export type RequestField = (typeof REQUEST_FIELDS)[number] | (typeof HTTP_FIELDS)[number];

interface Props {
  width: number;
  height: number;
  focused: boolean;
  request?: GrpcRequest;
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
  /** sets a `{{var}}` from the message editor (enter on it) */
  onSetVar?: (name: string, value: string) => void;
  method?: MethodInfo;
  resolvedUrl?: string;
  authSummary: string;
  settingsSummary: string;
  capturesSummary: string;
  scriptsSummary: string;
}

const LABELS: Record<RequestField, string> = {
  name: 'Name',
  url: 'URL',
  method: 'Method',
  metadata: 'Metadata',
  auth: 'Auth',
  settings: 'Settings',
  captures: 'Captures',
  scripts: 'Scripts',
  message: 'Message',
  params: 'Params',
  pathvars: 'Path vars',
  headers: 'Headers',
  body: 'Body',
};

export function RequestPanel(props: Props) {
  const { width, height, focused, request, field } = props;
  const inner = width - 4;

  if (!request) {
    return (
      <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={focused ? theme.borderFocus : theme.border} paddingX={1}>
        <Text bold color={theme.muted}>
          Request
        </Text>
        <Text color={theme.muted}> </Text>
        <Text color={theme.muted}>Select a request in the sidebar, or press N for a scratch request.</Text>
      </Box>
    );
  }

  const labelWidth = 10;
  const valueWidth = inner - labelWidth - 2;
  const row = (f: RequestField, content: React.ReactNode) => {
    const selected = focused && field === f;
    return (
      <Box key={f} height={1}>
        <Box flexShrink={0} width={2 + labelWidth}>
          <Text color={selected ? theme.accent : theme.muted} bold={selected}>
            {selected ? '› ' : '  '}
            {padEnd(LABELS[f], labelWidth)}
          </Text>
        </Box>
        <Box width={valueWidth} overflow="hidden">
          {content}
        </Box>
      </Box>
    );
  };

  const textRow = (f: 'name' | 'url', value: string, placeholder: string, extra?: string) => {
    if (props.editing === f) {
      return row(f, <TextInput value={props.editValue} onChange={props.onEditChange} onSubmit={props.onEditSubmit} />);
    }
    const shown = value || placeholder;
    const extraText = extra ? `  → ${extra}` : '';
    return row(
      f,
      <Text wrap="truncate-end">
        <Text color={value ? undefined : theme.muted}>{truncate(shown, valueWidth)}</Text>
        <Text color={theme.muted}>{truncate(extraText, Math.max(0, valueWidth - shown.length))}</Text>
      </Text>,
    );
  };

  const method = props.method;
  const methodRow = row(
    'method',
    request.methodPath ? (
      <Text wrap="truncate-end">
        <Text>{truncate(request.methodPath, valueWidth - (method ? kindLabel(method.kind).length + 3 : 0))}</Text>
        {method ? <Text color={theme.kind[method.kind]}> [{kindLabel(method.kind)}]</Text> : null}
      </Text>
    ) : (
      <Text color={theme.muted}>enter to pick a method</Text>
    ),
  );

  // Header (1) + 8 field rows + separator (1) + message header (1) + borders (2)
  const editorHeight = Math.max(1, height - 13);
  const err = jsonError(request.message);
  const inputType = method ? method.desc.input.typeName.split('.').pop() : undefined;
  const streamingHint = method && isClientStreaming(method.kind) ? ' · JSON array = multiple messages' : '';

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
      {textRow('name', request.name, 'untitled')}
      {textRow('url', request.url, 'host:port  (grpcs:// for TLS)', props.resolvedUrl && props.resolvedUrl !== request.url ? props.resolvedUrl : undefined)}
      {methodRow}
      {row('metadata', <Text wrap="truncate-end">{truncate(kvSummary(request.metadata), valueWidth)}</Text>)}
      {row('auth', <Text wrap="truncate-end">{truncate(props.authSummary, valueWidth)}</Text>)}
      {row('settings', <Text wrap="truncate-end">{truncate(props.settingsSummary, valueWidth)}</Text>)}
      {row(
        'captures',
        <Text wrap="truncate-end" color={request.captures?.length ? undefined : theme.muted}>
          {truncate(props.capturesSummary, valueWidth)}
        </Text>,
      )}
      {row(
        'scripts',
        <Text wrap="truncate-end" color={request.scripts?.length ? undefined : theme.muted}>
          {truncate(props.scriptsSummary, valueWidth)}
        </Text>,
      )}
      <Text color={theme.border}>{'─'.repeat(inner)}</Text>
      {row(
        'message',
        <Text wrap="truncate-end">
          <Text color={theme.muted}>{inputType ?? 'JSON'}</Text>
          {err ? <Text color={theme.error}> ✗ {truncate(err, Math.max(0, valueWidth - 20))}</Text> : <Text color={theme.ok}> ✓</Text>}
          <Text color={theme.muted}>
            {props.messageEditing ? ' · editing — esc to finish, ctrl+f format' : focused && field === 'message' ? ' · enter: edit · t: template · o: $EDITOR' : ''}
            {streamingHint}
          </Text>
        </Text>,
      )}
      {props.messageEditing ? (
        <TextEditor value={request.message} onChange={props.onMessageChange} width={inner} height={editorHeight} active onExit={props.onMessageExit} vars={props.vars} onSetVar={props.onSetVar} />
      ) : (
        <Box flexDirection="column" height={editorHeight}>
          {request.message
            .split('\n')
            .slice(0, editorHeight)
            .map((line, i) => (
              <Box key={i}>
                <Text color={theme.muted} dimColor>
                  {String(i + 1).padStart(3)}{' '}
                </Text>
                <JsonLine line={line} width={inner - 4} vars={props.vars} />
              </Box>
            ))}
        </Box>
      )}
    </Box>
  );
}
