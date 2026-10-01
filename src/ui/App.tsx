import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import {
  type Auth,
  type Capture,
  type Collection,
  type Environment,
  type GrpcRequest,
  HTTP_METHODS,
  type HttpRequest,
  type KV,
  type SchemaSource,
  type Script,
  type SendableRequest,
  type TlsFiles,
  type CertificateEntry,
  clone,
  isSendable,
  newGrpcRequest,
  newHttpRequest,
  pathVariableNames,
  splitQuery,
  walkItems,
} from '../core/model.js';
import { evaluateCaptures, evaluateHttpCaptures } from '../core/captures.js';
import {
  type ScriptOutcome,
  type ScriptPhase,
  grpcRequestInfo,
  grpcResponseInfo,
  httpRequestInfo,
  httpResponseInfo,
  isPhase,
  runPhase,
  scriptsFor,
  secretMask,
  summarizeOutcome,
  withLocals,
} from '../core/scripts.js';
import { type Segment, formatPath, leaves, normalizeKey, setInJsonText, suggestVariableName, valueToString } from '../core/jsonpath.js';
import { type OAuthConfig, buildScopes, effectiveAuth, oauthFields, resolveHttpRequest, resolveRequest } from '../core/resolve.js';
import { cachedToken, describeExpiry, getToken, withToken } from '../http/oauth.js';
import { previewGrpc, previewHttp } from '../core/preview.js';
import { parseTarget } from '../grpc/connection.js';
import { type HttpHandle, jsonBody, sendHttp } from '../http/client.js';
import { toCurl } from '../http/curl.js';
import { createResolver, referencedVars } from '../core/vars.js';
import type { Workspace } from '../core/workspace.js';
import { type DiscoverOptions, cacheKey, discover } from '../grpc/discovery.js';
import { type CallHandle, type CallResult, invoke } from '../grpc/invoke.js';
import { toGrpcurl } from '../grpc/grpcurl.js';
import { expandHome } from '../grpc/proto-files.js';
import { type MethodInfo, type Schema, describeMethod, isClientStreaming, kindLabel, methodTemplate, normalizeMethodPath } from '../grpc/schema.js';
import { EnvManager } from './components/EnvManager.js';
import { CertManager } from './components/CertManager.js';
import { JsonLine } from './components/JsonLine.js';
import {
  ConfirmModal,
  type FormField,
  FormModal,
  type FormValues,
  type KVRow,
  KVEditorModal,
  type PickerItem,
  PickerModal,
  PromptModal,
  TextViewerModal,
} from './components/Modals.js';
import { HTTP_FIELDS, REQUEST_FIELDS, type RequestField, RequestPanel } from './components/RequestPanel.js';
import { HttpRequestPanel, METHOD_COLORS, bodyText } from './components/HttpRequestPanel.js';
import { type AnyResult, type ResponseTab, ResponsePanel, type ScriptRun, isHttpResult, responseLines } from './components/ResponsePanel.js';
import { type SidebarTab, Sidebar, buildServiceRows, buildTree } from './components/Sidebar.js';
import { TabBar } from './components/TabBar.js';
import { copyToClipboard, editInExternalEditor } from './terminal.js';
import { theme } from './theme.js';
import { clamp, formatBytes, scrollInto, truncate, tryFormatJson } from './util.js';

type Focus = 'sidebar' | 'request' | 'response';

type Modal =
  | { type: 'help' }
  | { type: 'prompt'; title: string; initial?: string; hint?: string; placeholder?: string; onSubmit: (v: string) => void }
  | { type: 'confirm'; title: string; message: string; onConfirm: () => void }
  | { type: 'picker'; title: string; items: PickerItem<unknown>[]; onSelect: (v: unknown) => void; emptyText?: string; initialIndex?: number; footer?: string }
  | { type: 'text'; title: string; text: string; json?: boolean; copy?: string; wrap?: boolean; note?: string; altText?: string; altLabel?: string }
  | { type: 'form'; title: string; fields: (v: FormValues) => FormField[]; initial: FormValues; onSave: (v: FormValues) => void }
  | { type: 'kv'; title: string; rows: KVRow[]; allowSecret?: boolean; hint?: string; keyLabel?: string; valueLabel?: string; onSave: (rows: KVRow[]) => void }
  | { type: 'env' }
  | { type: 'certs' };

interface Draft {
  request: SendableRequest;
  /** not yet saved to any collection */
  scratch?: boolean;
}

function scriptKind(s: Script): string {
  return /test/i.test(s.type) && !/after|post/i.test(s.type) ? 'tests' : /before|pre/i.test(s.type) ? 'pre-request' : 'post-response';
}

function scriptTemplate(phase: ScriptPhase, kind: 'grpc' | 'http'): string {
  if (phase === 'before') {
    return [
      '// Pre-request script: JavaScript or TypeScript, runs before the request is sent.',
      '//',
      "//   pm.variables.set('requestId', crypto.randomUUID());   // this request only: {{requestId}}",
      "//   bru.setEnvVar('startedAt', new Date().toISOString());  // saved to the active environment",
      '',
    ].join('\n');
  }
  const body = kind === 'grpc' ? 'the response message (an array for streams)' : 'the JSON body';
  return [
    '// Post-response script: JavaScript or TypeScript, runs after every response.',
    '// Variables you set are saved to the active environment (else the collection),',
    '// so {{accessToken}} in metadata/headers picks them up on the next send.',
    '//',
    `//   const body = res.getBody();                        // ${body}`,
    "//   bru.setEnvVar('accessToken', body.access_token);",
    '//',
    kind === 'grpc'
      ? "//   pm.environment.set('accessToken', pm.response.messages.idx(0).data.accessToken);"
      : "//   pm.environment.set('accessToken', pm.response.json().access_token);",
    "//   pm.test('ok', () => pm.expect(pm.response.code).to.equal(" + (kind === 'grpc' ? '0' : '200') + '));',
    '',
  ].join('\n');
}

type SchemaState = { state: 'loading' | 'ready' | 'error'; schema?: Schema; error?: string };

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const HELP = `GLOBAL
  ctrl+r        send request                 ctrl+s   save request
  ctrl+c        cancel running call / quit   q        quit
  tab/shift+tab cycle panes                  1 / 2    collections / services
  e             environments                 N        new scratch request
  R             re-discover services         i        import Postman v3 YAML
  L             stacked ↔ side-by-side       B        hide / show sidebar
  C             show as a curl / grpcurl command (y to copy)
  p             preview what will be sent (headers/metadata + sources, TLS)
  P             per-host certificates (client certs / CAs for mTLS)

CHAINING (response pane: enter to select a value)
  ↑↓            move between values          enter    actions for the value
  u             use in another open request (pick the field; best match preselected)
  v             save as {{variable}}         y        copy value
  Captures (request field) re-save values after every successful call.
  Scripts (request field) run JS/TS before the request / after the response:
    bru.setEnvVar('accessToken', res.getBody().access_token)
    pm.environment.set('accessToken', pm.response.json().access_token)

TABS
  [ / ]         previous / next tab          T        list open tabs (fuzzy)
  { / }         move tab left / right        alt+1…9  jump to tab N
  w             close tab                    W        close other tabs
  Opening a request from the sidebar adds a tab; each tab keeps its own
  draft, response and scroll position. Open tabs are restored on start.
  ?             this help

COLLECTIONS (sidebar)
  ↑↓ / j k      move                         ←→ / h l collapse / expand
  enter         open request / toggle        c        new collection
  n             new request                  f        new folder
  r             rename                       d        delete
  y             duplicate                    K / J    move up / down
  v             variables (collection/folder)
  a / H         auth / headers (collection/folder; inherited by requests)
  s             collection settings (schema source, TLS files)
  x             export collection as Postman v3 YAML

SERVICES (sidebar)
  enter         use method on current request (fills a template)
  d             describe method (proto definition)
  a             add method to a collection as a new request

REQUEST
  ↑↓            select field                 enter    edit field
  t             generate message template    o        edit message in $EDITOR
  f             format message JSON
  message editor: esc done · ctrl+f format · ctrl+k/ctrl+u kill · tab indent

RESPONSE
  ↑↓ pgup pgdn  scroll                       g / G    top / bottom
  m / ←→        messages ↔ metadata          y        copy to clipboard

VARIABLES
  {{name}} is resolved from environment > folder > collection variables.
  Dynamic: {{$guid}} {{$timestamp}} {{$isoTimestamp}} {{$randomInt}}

STREAMING
  Client/bidi streaming: make the message a JSON array; each element is sent
  as one message, then the stream is half-closed.`;

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

function sourceLabel(source: SchemaSource | undefined): string {
  if (!source) return 'reflection';
  if (source.type === 'reflection') return 'reflection';
  if (source.type === 'proto') return `proto: ${source.files.join(', ') || '(no files)'}`;
  return `protoset: ${source.files.join(', ') || '(no files)'}`;
}

const splitList = (s: string | boolean | undefined) =>
  String(s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function schemaFromForm(v: FormValues): SchemaSource | undefined {
  if (v.source === 'reflection') return { type: 'reflection' };
  if (v.source === 'proto') return { type: 'proto', files: splitList(v.protoFiles), importPaths: splitList(v.importPaths) };
  if (v.source === 'protoset') return { type: 'protoset', files: splitList(v.protosets) };
  return undefined;
}

function schemaFormFields(v: FormValues, inheritLabel?: string): FormField[] {
  const options = [
    ...(inheritLabel ? [{ value: 'inherit', label: `inherit (${inheritLabel})` }] : []),
    { value: 'reflection', label: 'server reflection' },
    { value: 'proto', label: '.proto files' },
    { value: 'protoset', label: 'protoset (FileDescriptorSet)' },
  ];
  const fields: FormField[] = [
    { id: 'source', label: 'Schema source', kind: 'select', value: String(v.source), options, hint: 'Where service definitions come from' },
  ];
  if (v.source === 'proto') {
    fields.push(
      { id: 'protoFiles', label: 'Proto files', kind: 'text', value: String(v.protoFiles ?? ''), placeholder: 'a.proto, b.proto', hint: 'Comma separated; relative to the imported collection folder or cwd' },
      { id: 'importPaths', label: 'Import paths', kind: 'text', value: String(v.importPaths ?? ''), placeholder: './protos, ~/googleapis', hint: 'Comma separated include directories' },
    );
  }
  if (v.source === 'protoset') {
    fields.push({ id: 'protosets', label: 'Protoset files', kind: 'text', value: String(v.protosets ?? ''), placeholder: 'api.binpb', hint: 'Output of `buf build -o` or `protoc -o`' });
  }
  return fields;
}

function tlsFileFields(v: FormValues): FormField[] {
  return [
    { id: 'caCert', label: 'CA certificate', kind: 'text', value: String(v.caCert ?? ''), placeholder: 'system roots', hint: 'PEM file to trust instead of the system roots' },
    { id: 'clientCert', label: 'Client cert', kind: 'text', value: String(v.clientCert ?? ''), placeholder: 'none', hint: 'PEM client certificate (mTLS)' },
    { id: 'clientKey', label: 'Client key', kind: 'text', value: String(v.clientKey ?? ''), placeholder: 'none', hint: 'PEM client key (mTLS)' },
    { id: 'pfx', label: 'PKCS#12 bundle', kind: 'text', value: String(v.pfx ?? ''), placeholder: 'none', hint: '.p12/.pfx with cert + key, instead of the two PEM files' },
    {
      id: 'passphrase',
      label: 'Passphrase',
      kind: 'text',
      value: String(v.passphrase ?? ''),
      placeholder: 'none',
      mask: !isVarRef(String(v.passphrase ?? '')),
      hint: 'For an encrypted key or the PKCS#12 bundle; {{var}} keeps it in an environment',
    },
  ];
}

const TLS_KEYS = ['caCert', 'clientCert', 'clientKey', 'pfx', 'passphrase'] as const;
const tlsInitial = (t: TlsFiles | undefined): FormValues => Object.fromEntries(TLS_KEYS.map((k) => [k, t?.[k] ?? '']));
/** TLS fields from a form, or undefined when all are empty. */
function tlsFromForm(v: FormValues): TlsFiles | undefined {
  const out: TlsFiles = {};
  for (const k of TLS_KEYS) if (String(v[k] ?? '').trim()) out[k] = String(v[k]).trim();
  return Object.keys(out).length ? out : undefined;
}

const isVarRef = (s: string) => /^\s*\{\{[^{}]+\}\}\s*$/.test(s);

export function App({ workspace: ws }: { workspace: Workspace }) {
  const version = useSyncExternalStore(ws.subscribe, ws.getVersion);
  const { exit } = useApp();
  const { cols, rows } = useTerminalSize();

  const [focus, setFocus] = useState<Focus>(ws.state.sidebarHidden ? 'request' : 'sidebar');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('collections');
  const [layout, setLayout] = useState<'stacked' | 'side-by-side'>(ws.state.layout ?? 'stacked');
  const [sidebarHidden, setSidebarHidden] = useState(ws.state.sidebarHidden ?? false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(ws.state.expanded ?? ws.collections.map((c) => c.id)));
  const [treeIndex, setTreeIndex] = useState(0);
  const [treeOffset, setTreeOffset] = useState(0);
  const [svcExpanded, setSvcExpanded] = useState<Set<string>>(new Set());
  const [svcIndex, setSvcIndex] = useState(0);
  const [svcOffset, setSvcOffset] = useState(0);
  const isSavedRequest = (id: string) => isSendable(ws.locate(id)?.item);
  const [tabs, setTabs] = useState<string[]>(() => {
    const saved = ws.state.openTabs ?? (ws.state.lastRequestId ? [ws.state.lastRequestId] : []);
    return [...new Set(saved)].filter(isSavedRequest);
  });
  const [activeId, setActiveId] = useState<string | undefined>(() =>
    ws.state.lastRequestId && tabs.includes(ws.state.lastRequestId) ? ws.state.lastRequestId : tabs[0],
  );
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [field, setField] = useState<RequestField>('url');
  const [editing, setEditing] = useState<'name' | 'url' | undefined>();
  const [editValue, setEditValue] = useState('');
  const [messageEditing, setMessageEditing] = useState(false);
  const [schemas, setSchemas] = useState<Record<string, SchemaState>>({});
  const schemasRef = useRef(schemas);
  schemasRef.current = schemas;
  const lastDiscoveryError = useRef<string | undefined>(undefined);
  const [results, setResults] = useState<Record<string, AnyResult>>({});
  const handles = useRef<Record<string, CallHandle | HttpHandle>>({});
  // Response view (messages/metadata, scroll) is kept per tab.
  const [views, setViews] = useState<Record<string, { tab: ResponseTab; offset: number }>>({});
  const view = (activeId && views[activeId]) || { tab: 'messages' as ResponseTab, offset: 0 };
  const responseTab = view.tab;
  const responseOffset = view.offset;
  const updateView = (patch: (v: { tab: ResponseTab; offset: number }) => Partial<{ tab: ResponseTab; offset: number }>, id = activeId) => {
    if (!id) return;
    setViews((p) => {
      const cur = p[id] ?? { tab: 'messages' as ResponseTab, offset: 0 };
      return { ...p, [id]: { ...cur, ...patch(cur) } };
    });
  };
  const setResponseOffset = (next: number | ((o: number) => number), id = activeId) =>
    updateView((v) => ({ offset: typeof next === 'function' ? next(v.offset) : next }), id);
  const setResponseTab = (next: (t: ResponseTab) => ResponseTab) => updateView((v) => ({ tab: next(v.tab) }));
  const [modals, setModals] = useState<Modal[]>([]);
  // Response "select mode": a cursor over value lines, for copying/chaining values.
  const [selecting, setSelecting] = useState(false);
  const [selCursor, setSelCursor] = useState(0);
  const [toast, setToastState] = useState<{ text: string; color: string } | undefined>();
  const toastTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const [spin, setSpin] = useState(0);

  // --- layout ------------------------------------------------------------------
  const totalHeight = Math.max(16, rows - 1); // one spare row avoids Ink's full-clear redraw path
  const bodyHeight = totalHeight - 2;
  const sideBySide = layout === 'side-by-side';
  const sidebarWidth = sidebarHidden ? 0 : clamp(Math.floor(cols * (sideBySide ? 0.22 : 0.28)), 24, 46);
  const rightWidth = Math.max(40, cols - sidebarWidth);
  // side-by-side: request | response, both full height; stacked: request above response
  const requestWidth = sideBySide ? Math.floor(rightWidth / 2) : rightWidth;
  const responseWidth = rightWidth - (sideBySide ? requestWidth : 0);
  const panelsHeight = bodyHeight - 1; // one row for the tab bar
  const sidebarList = Math.max(1, bodyHeight - 4);
  const modalWidth = Math.min(cols - 4, 96);
  const modalHeight = Math.max(8, Math.min(bodyHeight - 2, 32));

  // --- helpers -----------------------------------------------------------------
  const setToast = (text: string, color: string = theme.info) => {
    setToastState({ text, color });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastState(undefined), 5000);
  };
  const push = (m: Modal) => setModals((s) => [...s, m]);
  const pop = () => setModals((s) => s.slice(0, -1));
  const replace = (m: Modal) => setModals((s) => [...s.slice(0, -1), m]);

  const savedRequest = (id: string | undefined): SendableRequest | undefined => {
    if (!id) return undefined;
    const item = ws.locate(id)?.item;
    return isSendable(item) ? item : undefined;
  };
  const requestById = (id: string | undefined) => (id ? (drafts[id]?.request ?? savedRequest(id)) : undefined);
  const isDirty = (id: string) => {
    const d = drafts[id];
    if (!d) return false;
    if (d.scratch) return true;
    const saved = savedRequest(id);
    return !saved || JSON.stringify(saved) !== JSON.stringify(d.request);
  };

  const request = requestById(activeId);
  const grpcReq = request?.type === 'grpc' ? request : undefined;
  const httpReq = request?.type === 'http' ? request : undefined;

  /** Rows of the request pane for the active request (HTTP hides Path vars when unused). */
  const requestFields: readonly RequestField[] = httpReq
    ? HTTP_FIELDS.filter((f) => f !== 'pathvars' || pathVariableNames(httpReq.url).length > 0 || httpReq.pathVariables.length > 0)
    : REQUEST_FIELDS;
  // Stacked: tall enough for every field row plus a line of content (header, separator, borders: 5), when the terminal allows.
  const minRequest = requestFields.length + 5;
  const requestHeight = sideBySide ? panelsHeight : clamp(Math.floor(panelsHeight * 0.56), minRequest, Math.max(minRequest, panelsHeight - 6));
  const responseHeight = sideBySide ? panelsHeight : Math.max(6, panelsHeight - requestHeight);
  const responseBody = Math.max(1, responseHeight - 4);
  const loc = activeId ? ws.locate(activeId) : undefined;
  const collection = loc?.collection;
  const ancestors = loc?.ancestors ?? [];
  const env = ws.activeEnvironment;

  const resolved = useMemo(
    () => (grpcReq ? resolveRequest(grpcReq, { collection, ancestors, environment: env, certificates: ws.settings.certificates }) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grpcReq, collection, env, version],
  );
  const grpcResolved = resolved;
  const httpResolved = useMemo(
    () => (httpReq ? resolveHttpRequest(httpReq, { collection, ancestors, environment: env, certificates: ws.settings.certificates }) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [httpReq, collection, env, version],
  );

  /** `{{var}}` values for the active request (environment > folder > collection), for coloring the message. */
  const varLookup = useMemo(
    () => createResolver(buildScopes(collection, ancestors, env)).lookup,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, env, version, activeId],
  );

  /** Sets a `{{var}}` from the message editor where it's already defined, else the environment (else the collection). */
  const setMessageVar = (name: string, value: string) => {
    const nearestFolder = [...ancestors].reverse().find((f) => f.variables?.some((v) => v.key === name));
    let where: string | undefined;
    if (env?.values.some((v) => v.key === name)) where = ws.setVariable(name, value, { environment: env });
    else if (nearestFolder && collection) {
      nearestFolder.variables = nearestFolder.variables!.map((v) => (v.key === name ? { ...v, value, disabled: undefined } : v));
      ws.saveCollection(collection);
      where = `folder "${nearestFolder.name}"`;
    } else if (collection?.variables.some((v) => v.key === name)) where = ws.setVariable(name, value, { collectionId: collection.id, scope: 'collection' });
    else where = ws.setVariable(name, value, { collectionId: collection?.id });
    if (!where) return setToast(`Nowhere to store {{${name}}}: select an environment or save the request to a collection`, theme.warn);
    setToast(value ? `{{${name}}} = ${truncate(value, 40)} in ${where}` : `{{${name}}} cleared in ${where}`, theme.ok);
  };

  /** Variables the URL needs that no scope defines; nothing can be sent until they resolve. */
  const activeUrl = resolved?.url ?? httpResolved?.url;
  const urlMissing = activeUrl ? referencedVars(activeUrl).filter((v) => !v.startsWith('$')) : [];
  const urlMissingMessage = urlMissing.length
    ? `URL needs ${urlMissing.map((v) => `{{${v}}}`).join(', ')}, which ${env ? `environment "${env.name}" doesn't define` : 'is undefined (no environment selected)'}. Press e to choose an environment.`
    : undefined;

  /** Adds a cached (still valid) OAuth2 token, if any; used where fetching isn't worth blocking on. */
  const withCachedToken = (metadata: Array<{ key: string; value: string }>, cfg: OAuthConfig | undefined) => {
    const t = cfg ? cachedToken(cfg, ws.home) : undefined;
    return cfg && t ? withToken(metadata, cfg, t.accessToken, true) : metadata;
  };

  /** Fetches (or reuses) the OAuth2 token for a request; reports progress in the status line. */
  const tokenFor = async (cfg: OAuthConfig): Promise<string> => {
    const cached = cachedToken(cfg, ws.home);
    if (cached) return cached.accessToken;
    setToast(`Fetching OAuth2 token from ${cfg.tokenUrl}…`, theme.info);
    const t = await getToken(cfg, ws.home);
    setToast(`Got OAuth2 token (${describeExpiry(t)})`, theme.ok);
    return t.accessToken;
  };

  const discoverOpts = (): DiscoverOptions | undefined =>
    resolved && !urlMissing.length && (resolved.schema.type !== 'reflection' || resolved.url)
      ? {
          source: resolved.schema,
          url: resolved.url,
          settings: resolved.settings,
          tls: resolved.tls,
          metadata: withCachedToken(resolved.metadata, resolved.oauth),
          baseDir: resolved.baseDir,
        }
      : undefined;
  const opts = discoverOpts();
  const schemaKey = opts ? cacheKey(opts) : undefined;
  const schemaState = schemaKey ? schemas[schemaKey] : undefined;
  const schema = schemaState?.schema;
  const method = schema && resolved ? schema.findMethod(resolved.methodPath) : undefined;

  /** Edits any request (creating a draft); `updateRequest` / `updateHttp` only touch that kind. */
  const updateAny = (id: string | undefined, fn: (r: SendableRequest) => SendableRequest) => {
    if (!id) return;
    setDrafts((prev) => {
      const base = prev[id]?.request ?? savedRequest(id);
      if (!base) return prev;
      return { ...prev, [id]: { ...prev[id], request: fn(clone(base)) } };
    });
  };
  const updateRequest = (id: string | undefined, fn: (r: GrpcRequest) => GrpcRequest) => updateAny(id, (r) => (r.type === 'grpc' ? fn(r) : r));
  const updateHttp = (id: string | undefined, fn: (r: HttpRequest) => HttpRequest) => updateAny(id, (r) => (r.type === 'http' ? fn(r) : r));

  const openRequest = (id: string) => {
    setActiveId(id);
    setTabs((t) => (t.includes(id) ? t : [...t, id]));
    setMessageEditing(false);
    setEditing(undefined);
    if (!drafts[id]) ws.saveState({ lastRequestId: id });
  };

  const ensureSchema = async (refresh = false, quiet = false): Promise<Schema | undefined> => {
    const o = discoverOpts();
    if (!o) {
      lastDiscoveryError.current = urlMissingMessage ?? 'URL is empty';
      if (!quiet) setToast(urlMissingMessage ?? 'Set a URL first (or configure .proto files in settings)', theme.warn);
      return undefined;
    }
    const key = cacheKey(o);
    const cur = schemasRef.current[key];
    if (!refresh && cur?.state === 'ready') return cur.schema;
    setSchemas((p) => ({ ...p, [key]: { state: 'loading' } }));
    try {
      const s = await discover(o, refresh);
      setSchemas((p) => ({ ...p, [key]: { state: 'ready', schema: s } }));
      setSvcExpanded(new Set(s.services.map((x) => x.name)));
      if (refresh) setToast(`Discovered ${s.services.length} service(s), ${s.methods.length} method(s)`, theme.ok);
      return s;
    } catch (err) {
      const message = (err as Error).message;
      lastDiscoveryError.current = message;
      setSchemas((p) => ({ ...p, [key]: { state: 'error', error: message } }));
      if (!quiet) setToast(`Discovery failed: ${message}`, theme.error);
      return undefined;
    }
  };

  // Discover automatically whenever the active target changes.
  useEffect(() => {
    if (schemaKey && !schemasRef.current[schemaKey]) void ensureSchema(false, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey]);

  // Spinner while anything is in flight.
  const busy = Object.values(results).some((r) => r.state === 'running') || Object.values(schemas).some((s) => s.state === 'loading');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setSpin((n) => (n + 1) % SPINNER.length), 90);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => {
    ws.saveState({ expanded: [...expanded] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // --- tree / services -----------------------------------------------------------
  const tree = useMemo(() => buildTree(ws.collections, expanded), [ws.collections, expanded, version]);
  const tIndex = clamp(treeIndex, 0, Math.max(0, tree.length - 1));
  const treeRow = tree[tIndex];
  const services = useMemo(() => buildServiceRows(schema, svcExpanded), [schema, svcExpanded]);
  const sIndex = clamp(svcIndex, 0, Math.max(0, services.length - 1));
  const svcRow = services[sIndex];

  const moveTree = (to: number) => {
    const i = clamp(to, 0, Math.max(0, tree.length - 1));
    setTreeIndex(i);
    setTreeOffset((o) => scrollInto(i, o, sidebarList));
  };
  // `rowsOverride` is the tree after a mutation; don't clamp against the stale one.
  const selectTreeId = (id: string, rowsOverride?: typeof tree) => {
    const i = (rowsOverride ?? tree).findIndex((r) => r.id === id);
    if (i < 0) return;
    setTreeIndex(i);
    setTreeOffset((o) => scrollInto(i, o, sidebarList));
  };
  const moveSvc = (to: number) => {
    const i = clamp(to, 0, Math.max(0, services.length - 1));
    setSvcIndex(i);
    setSvcOffset((o) => scrollInto(i, o, sidebarList - 1));
  };
  const toggle = (set: Set<string>, id: string, open?: boolean) => {
    const next = new Set(set);
    if (open ?? !next.has(id)) next.add(id);
    else next.delete(id);
    return next;
  };

  /** Where "new request/folder" goes, relative to the selected tree row. */
  const containerOf = (row = treeRow): { collectionId: string; parentId: string } | undefined => {
    if (!row) return undefined;
    if (row.kind === 'collection' || row.kind === 'folder') return { collectionId: row.collectionId, parentId: row.id };
    return { collectionId: row.collectionId, parentId: row.parentId };
  };

  /**
   * A sensible starting URL for a new request of `kind`: a sibling's target for
   * gRPC, or a sibling's base (`{{endpointHost}}` / scheme://host) for HTTP.
   */
  const defaultUrlFor = (collectionId: string | undefined, kind: 'grpc' | 'http'): string => {
    const base = (url: string) => (kind === 'http' ? (/^(\{\{[^}]+\}\}|[a-z]+:\/\/[^/]+)/i.exec(url)?.[1] ?? '') : url);
    if (request?.type === kind && (!collectionId || collection?.id === collectionId)) return base(request.url);
    const c = collectionId ? ws.collection(collectionId) : undefined;
    if (c) for (const { item } of walkItems(c.items)) if (item.type === kind && item.url) return base(item.url);
    return request?.type === kind ? base(request.url) : '';
  };

  // --- actions ---------------------------------------------------------------------
  const newScratch = (partial: Partial<GrpcRequest> = {}, kind: 'grpc' | 'http' = 'grpc') => {
    const r: SendableRequest =
      kind === 'http'
        ? newHttpRequest({ name: 'Scratch request', url: defaultUrlFor(undefined, 'http') })
        : newGrpcRequest({ name: 'Scratch request', url: defaultUrlFor(undefined, 'grpc'), ...partial });
    setDrafts((p) => ({ ...p, [r.id]: { request: r, scratch: true } }));
    setActiveId(r.id);
    setTabs((t) => [...t, r.id]);
    setFocus('request');
    setField(partial.methodPath ? 'message' : 'url');
  };

  /** Asks gRPC or HTTP, then runs `then`. */
  const chooseKind = (title: string, then: (kind: 'grpc' | 'http') => void) =>
    push({
      type: 'picker',
      title,
      items: [
        { label: 'HTTP request', value: 'http', hint: 'REST / JSON / GraphQL over HTTP', color: METHOD_COLORS.GET },
        { label: 'gRPC request', value: 'grpc', hint: 'discovers methods via reflection or .proto files', color: theme.ok },
      ],
      initialIndex: request?.type === 'grpc' ? 1 : 0,
      onSelect: (v) => {
        pop();
        then(v as 'grpc' | 'http');
      },
    });

  const createRequestIn = (collectionId: string, parentId: string, partial: Partial<GrpcRequest>, kind: 'grpc' | 'http' = 'grpc') => {
    const r: SendableRequest =
      kind === 'http'
        ? newHttpRequest({ url: defaultUrlFor(collectionId, 'http'), name: partial.name ?? 'New request' })
        : newGrpcRequest({ url: defaultUrlFor(collectionId, 'grpc'), ...partial });
    ws.addItem(collectionId, parentId, r);
    const nextExpanded = new Set(expanded).add(collectionId).add(parentId);
    setExpanded(nextExpanded);
    selectTreeId(r.id, buildTree(ws.collections, nextExpanded));
    openRequest(r.id);
    return r;
  };

  const chooseCollection = (title: string, onPick: (collectionId: string, parentId: string) => void) => {
    const items: PickerItem<unknown>[] = [];
    for (const c of ws.collections) {
      items.push({ label: c.name, value: { c: c.id, p: c.id }, color: theme.accent });
      for (const { item, ancestors: anc } of walkItems(c.items)) {
        if (item.type === 'folder') {
          items.push({ label: `${c.name} › ${[...anc, item].map((f) => f.name).join(' › ')}`, value: { c: c.id, p: item.id }, color: theme.info });
        }
      }
    }
    items.push({ label: '+ New collection…', value: { c: '__new__', p: '' }, color: theme.ok });
    push({
      type: 'picker',
      title,
      items,
      onSelect: (v) => {
        const { c, p } = v as { c: string; p: string };
        if (c === '__new__') {
          replace({
            type: 'prompt',
            title: 'New collection name',
            onSubmit: (name) => {
              pop();
              if (!name.trim()) return;
              const col = ws.createCollection(name.trim());
              onPick(col.id, col.id);
            },
          });
          return;
        }
        pop();
        onPick(c, p);
      },
    });
  };

  /** Short description of a request for pickers: gRPC method name, or METHOD /path. */
  const requestHint = (r: SendableRequest | undefined): string => {
    if (!r) return '';
    if (r.type === 'grpc') return r.methodPath.split('/').pop() ?? '';
    return `${r.method} ${r.url.replace(/^(\{\{[^}]+\}\}|[a-z]+:\/\/[^/]+)/i, '') || '/'}`;
  };
  /** Name hint used when suggesting variable names for picked values. */
  const sourceHint = (): string | undefined => {
    if (grpcReq) return method?.name ?? grpcReq.methodPath.split('/').pop();
    if (httpReq) return [...httpReq.url.split('/')].reverse().find((seg) => seg && !seg.startsWith(':') && !seg.includes('{{'));
    return undefined;
  };
  /** Response paths carry a leading message index for gRPC, none for HTTP. */
  const fieldPath = (path: Segment[]) => (httpReq ? path : path.slice(1));

  // --- tabs ------------------------------------------------------------------------
  const tabLabel = (id: string) => requestById(id)?.name ?? 'request';

  const switchTab = (delta: number) => {
    if (!tabs.length) return;
    const i = activeId ? tabs.indexOf(activeId) : -1;
    openRequest(tabs[(i + delta + tabs.length) % tabs.length]!);
  };

  const moveTab = (delta: number) => {
    if (!activeId) return;
    const i = tabs.indexOf(activeId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= tabs.length) return;
    const next = [...tabs];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setTabs(next);
  };

  /** Drops tabs (their drafts, responses and running calls) without asking. */
  const dropTabs = (ids: string[]) => {
    if (!ids.length) return;
    const gone = new Set(ids);
    for (const id of ids) handles.current[id]?.cancel();
    const without = <T,>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([k]) => !gone.has(k)));
    setDrafts((p) => without(p));
    setResults((p) => without(p));
    setViews((p) => without(p));
    const remaining = tabs.filter((t) => !gone.has(t));
    setTabs(remaining);
    if (activeId && gone.has(activeId)) {
      // Activate the neighbour, like a browser.
      const i = tabs.indexOf(activeId);
      const next = remaining[Math.min(Math.max(0, i), remaining.length - 1)];
      if (next) openRequest(next);
      else setActiveId(undefined);
    }
  };

  const closeTabs = (ids: string[], what: string) => {
    const dirty = ids.filter(isDirty);
    if (!dirty.length) return dropTabs(ids);
    push({
      type: 'confirm',
      title: `Close ${what}?`,
      message: `${dirty.map((id) => `"${tabLabel(id)}"`).join(', ')} ${dirty.length === 1 ? 'has' : 'have'} unsaved changes that will be lost. Close anyway? (n, then ctrl+s to save first)`,
      onConfirm: () => {
        pop();
        dropTabs(ids);
      },
    });
  };

  const pickTab = () => {
    if (!tabs.length) return setToast('No open tabs', theme.muted);
    push({
      type: 'picker',
      title: `Open tabs (${tabs.length})`,
      initialIndex: Math.max(0, activeId ? tabs.indexOf(activeId) : 0),
      items: tabs.map((id, i) => {
        const l = ws.locate(id);
        const where = drafts[id]?.scratch ? 'scratch' : [l?.collection.name, ...(l?.ancestors ?? []).map((a) => a.name)].filter(Boolean).join(' › ');
        const r = results[id];
        return {
          label: `${i + 1}. ${tabLabel(id)}${isDirty(id) ? '*' : ''}`,
          value: id,
          hint: [r ? (r.state === 'running' ? 'running' : isHttpResult(r) ? String(r.status ?? r.state) : (r.codeName ?? r.state)) : '', where].filter(Boolean).join(' · '),
          keywords: `${requestHint(requestById(id))} ${where}`,
          color: id === activeId ? theme.accent : undefined,
        };
      }) as PickerItem<unknown>[],
      onSelect: (id) => {
        pop();
        openRequest(id as string);
      },
      footer: '↑↓: move · type to filter · enter: switch · esc: cancel',
    });
  };

  // Close tabs whose requests were deleted from the sidebar.
  useEffect(() => {
    const keep = tabs.filter((id) => drafts[id]?.scratch || isSavedRequest(id));
    if (keep.length !== tabs.length) {
      setTabs(keep);
      if (activeId && !keep.includes(activeId)) setActiveId(keep[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, tabs, drafts]);

  // Remember open tabs (saved requests only).
  useEffect(() => {
    const persisted = tabs.filter((id) => !drafts[id]?.scratch);
    if (JSON.stringify(persisted) !== JSON.stringify(ws.state.openTabs ?? [])) ws.saveState({ openTabs: persisted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  const save = () => {
    if (!activeId || !request) return setToast('Nothing to save', theme.muted);
    const d = drafts[activeId];
    if (!d) return setToast('No changes', theme.muted);
    if (d.scratch) {
      chooseCollection('Save request to…', (collectionId, parentId) => {
        ws.addItem(collectionId, parentId, clone(d.request));
        setDrafts((p) => {
          const { [activeId]: _, ...rest } = p;
          return rest;
        });
        setExpanded((e) => new Set(e).add(collectionId).add(parentId));
        ws.saveState({ lastRequestId: activeId });
        setToast(`Saved "${d.request.name}"`, theme.ok);
      });
      return;
    }
    ws.updateRequest(d.request);
    setDrafts((p) => {
      const { [activeId]: _, ...rest } = p;
      return rest;
    });
    setToast(`Saved "${d.request.name}"`, theme.ok);
  };

  const sendHttpRequest = async () => {
    const id = activeId;
    let r = httpResolved;
    const req = httpReq;
    if (!id || !r || !req) return;
    if (handles.current[id]) return setToast('Request already running — ctrl+c to cancel', theme.warn);
    if (!req.url.trim()) return setToast('URL is empty', theme.warn);
    const scriptEnv = env;
    const pre = await runScriptPhase('before', req, httpRequestInfo(req.name, r));
    if (pre?.error) return scriptFailed(id, 'http', pre);
    // Pre-request scripts may have changed variables: resolve again.
    if (pre) r = resolveHttpRequest(req, { collection, ancestors, environment: withLocals(scriptEnv, pre.locals), certificates: ws.settings.certificates });
    if (urlMissingMessage && referencedVars(r.url).some((v) => !v.startsWith('$'))) return setToast(urlMissingMessage, theme.warn);
    if (r.missingVars.length) setToast(`Unresolved variables: ${r.missingVars.map((v) => `{{${v}}}`).join(', ')}`, theme.warn);
    else if (r.warnings.length) setToast(r.warnings.join(' · '), theme.warn);
    setResponseOffset(0, id);
    let oauthToken: string | undefined;
    if (r.oauth) {
      const startedAt = Date.now();
      setResults((p) => ({ ...p, [id]: { kind: 'http', state: 'running', headers: [], body: Buffer.alloc(0), startedAt } }));
      try {
        oauthToken = await tokenFor(r.oauth);
      } catch (err) {
        setToast((err as Error).message, theme.error);
        return setResults((p) => ({ ...p, [id]: { kind: 'http', state: 'error', headers: [], body: Buffer.alloc(0), startedAt, durationMs: Date.now() - startedAt, error: (err as Error).message } }));
      }
    }
    const handle = sendHttp(r, (res) => setResults((p) => ({ ...p, [id]: res })), { oauthToken });
    handles.current[id] = handle;
    const final: AnyResult = await handle.done;
    delete handles.current[id];
    setResults((p) => ({ ...p, [id]: final }));
    const post = final.state === 'done' && final.status !== undefined ? await runScriptPhase('after', req, httpRequestInfo(req.name, r), httpResponseInfo(final)) : undefined;
    const runs = scriptRuns(pre, post, scriptEnv);
    if (runs.length) setResults((p) => ({ ...p, [id]: { ...final, scripts: runs } }));
    const ok = final.state === 'done' && final.status !== undefined && final.status < 300;
    const captures = ownCaptures(req);
    if (ok && captures.length) applyHttpCaptures(captures, jsonBody(final), collection?.id, scriptSummary(runs));
    else reportScripts(runs);
  };

  const send = async () => {
    if (httpReq) return sendHttpRequest();
    const id = activeId;
    const request = grpcReq;
    let resolved = grpcResolved;
    if (!id || !request || !resolved) return setToast('Open or create a request first', theme.warn);
    if (handles.current[id]) return setToast('Call already running — ctrl+c to cancel', theme.warn);
    if (!resolved.url) return setToast('URL is empty', theme.warn);
    if (!resolved.methodPath) return setToast('Pick a method first (Method field or Services tab)', theme.warn);
    const scriptEnv = env;
    const pre = await runScriptPhase('before', request, grpcRequestInfo(request.name, resolved));
    if (pre?.error) return scriptFailed(id, 'grpc', pre);
    // Pre-request scripts may have changed variables: resolve again.
    if (pre) resolved = resolveRequest(request, { collection, ancestors, environment: withLocals(scriptEnv, pre.locals), certificates: ws.settings.certificates });
    if (urlMissingMessage && referencedVars(resolved.url).some((v) => !v.startsWith('$'))) return setToast(urlMissingMessage, theme.warn);
    if (resolved.missingVars.length) setToast(`Unresolved variables: ${resolved.missingVars.map((v) => `{{${v}}}`).join(', ')}`, theme.warn);
    else if (resolved.warnings.length) setToast(resolved.warnings.join(' · '), theme.warn);

    const start: CallResult = { state: 'running', headers: [], trailers: [], messages: [], sent: 0, startedAt: Date.now() };
    setResults((p) => ({ ...p, [id]: start }));
    setResponseOffset(0, id);
    const s = await ensureSchema(false, true);
    const fail = (error: string) => setResults((p) => ({ ...p, [id]: { ...start, state: 'error', error, durationMs: Date.now() - start.startedAt } }));
    if (!s) return fail(`Could not load schema: ${lastDiscoveryError.current ?? 'unknown error'}`);
    const m = s.findMethod(resolved.methodPath);
    if (!m) return fail(`Method ${resolved.methodPath} not found. Available: ${s.methods.map((x) => x.path).slice(0, 8).join(', ')}`);
    let metadata = resolved.metadata;
    if (resolved.oauth) {
      try {
        metadata = withToken(metadata, resolved.oauth, await tokenFor(resolved.oauth), true);
      } catch (err) {
        return fail((err as Error).message);
      }
    }

    const handle = invoke({
      url: resolved.url,
      settings: resolved.settings,
      tls: resolved.tls,
      baseDir: resolved.baseDir,
      schema: s,
      method: m,
      message: resolved.message,
      metadata,
      onUpdate: (r) => setResults((p) => ({ ...p, [id]: r })),
    });
    handles.current[id] = handle;
    const final: AnyResult = await handle.done;
    delete handles.current[id];
    setResults((p) => ({ ...p, [id]: final }));
    const post = final.state !== 'cancelled' && final.code !== undefined ? await runScriptPhase('after', request, grpcRequestInfo(request.name, resolved), grpcResponseInfo(final)) : undefined;
    const runs = scriptRuns(pre, post, scriptEnv);
    if (runs.length) setResults((p) => ({ ...p, [id]: { ...final, scripts: runs } }));
    const captures = ownCaptures(request);
    if (final.state === 'done' && captures.length) applyCaptures(captures, final.messages, collection?.id, scriptSummary(runs));
    else reportScripts(runs);
  };

  // --- scripts ------------------------------------------------------------------------
  const runScriptPhase = (phase: ScriptPhase, request: SendableRequest, info: ReturnType<typeof httpRequestInfo>, response?: ReturnType<typeof httpResponseInfo>) =>
    runPhase(phase, { store: ws, request, collection, ancestors, environment: env, info, response });
  const scriptRuns = (pre: ScriptOutcome | undefined, post: ScriptOutcome | undefined, environment: Environment | undefined): ScriptRun[] =>
    [pre && { phase: 'before' as const, outcome: pre }, post && { phase: 'after' as const, outcome: post }]
      .filter((x) => !!x)
      .map((x) => ({ ...x, mask: secretMask(environment) }));
  const scriptSummary = (runs: ScriptRun[]) => {
    const parts = runs.map((r) => summarizeOutcome(r.outcome, r.mask)).filter((x) => x.text);
    return parts.length ? { text: parts.map((x) => x.text).join(' · '), ok: parts.every((x) => x.ok) } : undefined;
  };
  const reportScripts = (runs: ScriptRun[]) => {
    const summary = scriptSummary(runs);
    if (summary) setToast(summary.text, summary.ok ? theme.ok : theme.warn);
  };
  const scriptFailed = (id: string, kind: 'http' | 'grpc', pre: ScriptOutcome) => {
    const startedAt = Date.now();
    const error = `Not sent: ${pre.error}`;
    const scripts = scriptRuns(pre, undefined, env);
    const result: AnyResult =
      kind === 'http'
        ? { kind: 'http', state: 'error', headers: [], body: Buffer.alloc(0), startedAt, durationMs: 0, error, scripts }
        : { state: 'error', headers: [], trailers: [], messages: [], sent: 0, startedAt, durationMs: 0, error, scripts };
    setResults((p) => ({ ...p, [id]: result }));
    setToast(error, theme.error);
  };
  /** Captures derived from a script that now runs itself are skipped, so it doesn't happen twice. */
  const ownCaptures = (r: SendableRequest) => (r.captures ?? []).filter((c) => c.source !== 'script');

  const cancelRunning = (): boolean => {
    const h = activeId ? handles.current[activeId] : undefined;
    const any = h ?? Object.values(handles.current)[0];
    if (!any) return false;
    any.cancel();
    setToast('Call cancelled', theme.warn);
    return true;
  };

  const applyTemplate = (m: MethodInfo | undefined = method, force = false) => {
    const request = grpcReq;
    if (!request || !activeId) return;
    if (!m) return setToast('Method not found in schema — discover services first (R)', theme.warn);
    const trivial = ['', '{}', '[]', '[{}]'].includes(request.message.replace(/\s/g, ''));
    const doIt = () => updateRequest(activeId, (r) => ({ ...r, message: methodTemplate(m) }));
    if (trivial || force) return doIt();
    push({ type: 'confirm', title: 'Replace message?', message: `Replace the current message with a ${m.desc.input.typeName} template?`, onConfirm: () => (pop(), doIt()) });
  };

  const pickMethod = async () => {
    const request = grpcReq;
    if (!request) return;
    const s = await ensureSchema();
    if (!s) return;
    const items = s.methods.map((m) => ({ label: m.path, value: m, hint: kindLabel(m.kind), color: theme.kind[m.kind] }));
    push({
      type: 'picker',
      title: `Pick a method · ${s.services.length} services`,
      items: items as PickerItem<unknown>[],
      emptyText: 'No methods found',
      onSelect: (v) => {
        pop();
        const m = v as MethodInfo;
        updateRequest(activeId, (r) => ({ ...r, methodPath: m.path }));
        const trivial = ['', '{}', '[]'].includes(request.message.replace(/\s/g, ''));
        if (trivial) updateRequest(activeId, (r) => ({ ...r, message: methodTemplate(m) }));
        setField('message');
      },
    });
  };

  // --- chaining: response values → variables / other requests ---------------------------
  type Extra = { text: string; ok: boolean } | undefined;
  const applyHttpCaptures = (captures: Capture[], body: unknown, collectionId?: string, extra?: Extra) => {
    if (body === undefined) return setToast(['Captures skipped: the response body is not JSON', extra?.text].filter(Boolean).join(' · '), theme.warn);
    reportCaptures(evaluateHttpCaptures(captures, body), collectionId, extra);
  };
  const applyCaptures = (captures: Capture[], messages: unknown[], collectionId?: string, extra?: Extra) =>
    reportCaptures(evaluateCaptures(captures, messages), collectionId, extra);
  const reportCaptures = (results: ReturnType<typeof evaluateCaptures>, collectionId?: string, extra?: Extra) => {
    const set: string[] = [];
    const failed: string[] = [];
    let where: string | undefined;
    for (const r of results) {
      if (r.value === undefined) {
        failed.push(`{{${r.variable}}}: ${r.error}`);
        continue;
      }
      where = ws.setVariable(r.variable, r.value, { collectionId });
      if (where) set.push(`{{${r.variable}}} = ${truncate(r.value, 40)}`);
      else failed.push(`{{${r.variable}}}: no environment or collection to store it in`);
    }
    if (set.length || failed.length || extra) {
      setToast(
        [set.length ? `Captured ${set.join(', ')} in ${where}` : '', failed.length ? `Capture failed: ${failed.join('; ')}` : '', extra?.text ?? ''].filter(Boolean).join(' · '),
        failed.length || (extra && !extra.ok) ? theme.warn : theme.ok,
      );
    }
  };

  // `fromMenu`: invoked from the value-actions picker (replace it) vs a direct shortcut (push).
  const saveVariable = (path: Segment[], value: unknown, keepUpdated: boolean, fromMenu = true) => {
    const show = fromMenu ? replace : push;
    const suggestion = suggestVariableName(fieldPath(path), sourceHint());
    const target = env ? `environment "${env.name}"` : collection ? `collection "${collection.name}"` : undefined;
    if (!target) {
      if (fromMenu) pop();
      return setToast('Activate an environment (e) or save this request to a collection first', theme.warn);
    }
    show({
      type: 'prompt',
      title: keepUpdated ? 'Capture into variable (updated after every response)' : 'Save value as variable',
      initial: suggestion,
      hint: `Stored in ${target}. Reference it as {{name}} in any request, e.g. "address_id": "{{${suggestion}}}".`,
      onSubmit: (raw) => {
        pop();
        const name = raw.trim().replace(/^\{\{|\}\}$/g, '');
        if (!name) return;
        const text = valueToString(value);
        const where = ws.setVariable(name, text, { collectionId: collection?.id });
        if (keepUpdated) {
          const capturePath = formatPath(path);
          updateAny(activeId, (r) => ({ ...r, captures: [...(r.captures ?? []).filter((c) => c.variable !== name), { variable: name, path: capturePath }] }));
          setToast(`{{${name}}} = ${truncate(text, 40)} in ${where} · captured from ${capturePath} after each call (ctrl+s to keep)`, theme.ok);
        } else {
          setToast(`{{${name}}} = ${truncate(text, 40)} in ${where}`, theme.ok);
        }
      },
    });
  };

  interface TargetField {
    label: string;
    /** name used to find the best match (address_id ~ addressId) */
    key: string;
    current: string;
    focus: RequestField;
    apply: (r: SendableRequest, value: unknown) => SendableRequest;
  }

  /** Places a value can go in `target`: message/body JSON fields, query params, path variables, headers, form fields. */
  const targetFields = (target: SendableRequest, sourceKey: string): TargetField[] | string => {
    const lastKey = (p: Segment[]) => [...p].reverse().find((x): x is string => typeof x === 'string') ?? '';
    const jsonFields = (text: string, prefix: string, focus: RequestField, set: (r: SendableRequest, text: string) => SendableRequest): TargetField[] | string => {
      let doc: unknown;
      try {
        doc = JSON.parse(text.trim() || '{}');
      } catch {
        return `"${target.name}" ${prefix || 'message'} isn't valid JSON; fix it first`;
      }
      return leaves(doc).map((f) => ({
        label: `${prefix}${formatPath(f.path)}`,
        key: lastKey(f.path),
        current: JSON.stringify(f.value),
        focus,
        apply: (r, value) => set(r, setInJsonText(r.type === 'grpc' ? r.message : (r.body.content ?? ''), f.path, value)),
      }));
    };
    if (target.type === 'grpc') {
      const fields = jsonFields(target.message, '', 'message', (r, text) => (r.type === 'grpc' ? { ...r, message: text } : r));
      if (typeof fields !== 'string' && !fields.length) return `"${target.name}" has no fields; generate a template with t first`;
      return fields;
    }
    const out: TargetField[] = [];
    const str = (v: unknown) => valueToString(v);
    const names = [...new Set([...target.pathVariables.map((p) => p.key), ...pathVariableNames(target.url)])];
    for (const name of names) {
      out.push({
        label: `path :${name}`,
        key: name,
        current: JSON.stringify(target.pathVariables.find((p) => p.key === name)?.value ?? ''),
        focus: 'pathvars',
        apply: (r, value) => {
          if (r.type !== 'http') return r;
          const exists = r.pathVariables.some((p) => p.key === name);
          return { ...r, pathVariables: exists ? r.pathVariables.map((p) => (p.key === name ? { ...p, value: str(value) } : p)) : [...r.pathVariables, { key: name, value: str(value) }] };
        },
      });
    }
    for (const q of target.queryParams) {
      out.push({
        label: `query ${q.key}`,
        key: q.key,
        current: JSON.stringify(q.value),
        focus: 'params',
        apply: (r, value) => (r.type === 'http' ? { ...r, queryParams: r.queryParams.map((p) => (p === q || p.key === q.key ? { ...p, value: str(value), disabled: false } : p)) } : r),
      });
    }
    if (target.body.type === 'json' && target.body.content?.trim()) {
      const fields = jsonFields(target.body.content, 'body ', 'message', (r, text) => (r.type === 'http' ? { ...r, body: { ...r.body, content: text } } : r));
      if (typeof fields !== 'string') out.push(...fields);
    }
    for (const f of target.body.type === 'urlencoded' || target.body.type === 'formdata' ? (target.body.fields ?? []) : []) {
      out.push({
        label: `form ${f.key}`,
        key: f.key,
        current: JSON.stringify(f.value),
        focus: 'body',
        apply: (r, value) => (r.type === 'http' ? { ...r, body: { ...r.body, fields: (r.body.fields ?? []).map((x) => (x.key === f.key ? { ...x, value: str(value) } : x)) } } : r),
      });
    }
    for (const h of target.headers) {
      out.push({
        label: `header ${h.key}`,
        key: h.key,
        current: JSON.stringify(h.value),
        focus: 'headers',
        apply: (r, value) => (r.type === 'http' ? { ...r, headers: r.headers.map((x) => (x.key === h.key ? { ...x, value: str(value) } : x)) } : r),
      });
    }
    out.push({
      label: '+ new query parameter…',
      key: '',
      current: '',
      focus: 'params',
      apply: (r, value) => (r.type === 'http' ? { ...r, queryParams: [...r.queryParams, { key: sourceKey || 'value', value: str(value) }] } : r),
    });
    return out;
  };

  /** Writes `value` into a field of another open request. */
  const useInTab = (path: Segment[], value: unknown, fromMenu = true) => {
    const others = tabs.filter((t) => t !== activeId);
    const dismiss = () => fromMenu && pop();
    if (!others.length) return (dismiss(), setToast('Open the target request in another tab first', theme.warn));
    const sourceKey = [...path].reverse().find((s): s is string => typeof s === 'string') ?? '';
    const chooseField = (targetId: string, modalOpen: boolean) => {
      const target = requestById(targetId);
      if (!target) return;
      const close = () => modalOpen && pop();
      const fields = targetFields(target, sourceKey);
      if (typeof fields === 'string') {
        close();
        return setToast(fields, theme.warn);
      }
      let best = fields.findIndex((f) => normalizeKey(f.key) === normalizeKey(sourceKey));
      if (best < 0 && /id$/i.test(sourceKey)) best = fields.findIndex((f) => /id$/i.test(f.key) && !/tenant/i.test(f.key));
      (modalOpen ? replace : push)({
        type: 'picker',
        title: `Set which field of "${target.name}" to ${truncate(valueToString(value), 30)}?`,
        initialIndex: Math.max(0, best),
        items: fields.map((f, i) => ({ label: f.label, value: i, hint: f.current ? `now ${truncate(f.current, 30)}` : undefined })) as PickerItem<unknown>[],
        onSelect: (i) => {
          pop();
          const f = fields[i as number]!;
          try {
            updateAny(targetId, (r) => f.apply(r, value));
          } catch (err) {
            return setToast(`Could not set ${f.label}: ${(err as Error).message}`, theme.error);
          }
          openRequest(targetId);
          setFocus('request');
          setField(f.focus);
          setToast(`Set ${f.label} in "${target.name}" · ctrl+r to send`, theme.ok);
        },
      });
    };
    if (others.length === 1) return chooseField(others[0]!, fromMenu);
    (fromMenu ? replace : push)({
      type: 'picker',
      title: 'Use value in which request?',
      items: others.map((id) => ({ label: tabLabel(id), value: id, hint: requestHint(requestById(id)) })) as PickerItem<unknown>[],
      onSelect: (id) => chooseField(id as string, true),
    });
  };

  const valueActions = (path: Segment[], value: unknown) => {
    const suggestion = suggestVariableName(fieldPath(path), sourceHint());
    const hasOthers = tabs.some((t) => t !== activeId);
    const items: PickerItem<unknown>[] = [
      ...(hasOthers ? [{ label: 'Use in another request…', value: 'use', hint: 'write it into a field of an open tab' }] : []),
      { label: `Save as {{${suggestion}}}…`, value: 'var', hint: env ? `in environment "${env.name}"` : 'in the collection' },
      { label: 'Capture: save and update after every response…', value: 'capture', hint: `adds ${formatPath(path)} to this request's captures` },
      { label: 'Copy value', value: 'copy' },
      { label: 'Copy path', value: 'path', hint: formatPath(path) },
    ];
    push({
      type: 'picker',
      title: `${formatPath(path)} = ${truncate(valueToString(value), 50)}`,
      items,
      onSelect: (choice) => {
        if (choice === 'use') return useInTab(path, value);
        if (choice === 'var') return saveVariable(path, value, false);
        if (choice === 'capture') return saveVariable(path, value, true);
        pop();
        const text = choice === 'path' ? formatPath(path) : valueToString(value);
        setToast(copyToClipboard(text) ? `Copied ${truncate(text, 60)}` : 'No clipboard tool found (pbcopy, wl-copy, xclip, xsel)', theme.ok);
      },
    });
  };

  const editCaptures = () => {
    if (!request) return;
    push({
      type: 'kv',
      title: `Captures · ${request.name}`,
      keyLabel: 'VARIABLE',
      valueLabel: httpReq ? 'PATH  into the JSON body' : 'PATH  [message].field',
      hint: `After each successful call${httpReq ? ' (2xx)' : ''}, the value at PATH${httpReq ? ' (e.g. access_token, items[0].id)' : ''} is stored as {{VARIABLE}} (environment, else collection). Tip: select a response value (enter in the response pane) to add one.`,
      rows: (request.captures ?? []).map((c) => ({ key: c.variable, value: c.path })),
      onSave: (rows) => {
        pop();
        const captures = rows.filter((r) => r.key && r.value).map((r) => ({ variable: r.key, path: r.value }));
        updateAny(activeId, (r) => ({ ...r, captures: captures.length ? captures : undefined }));
      },
    });
  };

  const editScripts = () => {
    if (!request) return;
    const own = request.scripts ?? [];
    const lines = (code: string) => `${code.split('\n').length} lines`;
    type Choice = { index: number } | { phase: ScriptPhase };
    const items: PickerItem<Choice>[] = own.map((script, index) => ({ label: scriptKind(script), value: { index }, hint: lines(script.code) }));
    for (const phase of ['after', 'before'] as const) {
      if (!own.some((s) => isPhase(s, phase))) items.push({ label: `New ${phase === 'before' ? 'pre-request' : 'post-response'} script`, value: { phase }, hint: 'JavaScript or TypeScript' });
    }
    const inherited = (['before', 'after'] as const).flatMap((phase) => scriptsFor(phase, { ...request, scripts: [] }, ancestors, collection));
    push({
      type: 'picker',
      title: `Scripts · ${request.name}`,
      items: items as PickerItem<unknown>[],
      footer: `enter: edit in $EDITOR (empty it to delete)${inherited.length ? ` · also runs: ${inherited.map((p) => `${p.from} ${scriptKind(p.script)}`).join(', ')}` : ''}`,
      onSelect: (v) => {
        pop();
        const choice = v as Choice;
        const existing = 'index' in choice ? own[choice.index] : undefined;
        const phase: ScriptPhase = existing ? (isPhase(existing, 'before') ? 'before' : 'after') : (choice as { phase: ScriptPhase }).phase;
        const template = scriptTemplate(phase, request.type);
        const res = editInExternalEditor(existing?.code ?? template, '.ts');
        setSpin((n) => n + 1);
        if (res.error) return setToast(res.error, theme.error);
        if (res.text === undefined) return;
        const code = res.text.trim() ? res.text : '';
        const blank = !code.split('\n').some((l) => l.trim() && !l.trim().startsWith('//'));
        const next: Script[] = [...own];
        if (existing) {
          if (blank) next.splice(next.indexOf(existing), 1);
          else next[next.indexOf(existing)] = { ...existing, code };
        } else if (!blank) {
          next.push({ type: phase === 'before' ? 'beforeRequest' : 'afterResponse', code, language: 'text/javascript' });
        }
        updateAny(activeId, (r) => ({ ...r, scripts: next.length ? next : undefined }));
        setToast(blank ? (existing ? 'Script removed (ctrl+s to keep)' : 'No script added') : 'Script updated — it runs on the next send (ctrl+s to keep)', theme.ok);
      },
    });
  };

  const editMetadata = () => {
    const request = grpcReq;
    if (!request) return;
    push({
      type: 'kv',
      title: `Metadata · ${request.name}`,
      hint: 'Sent as gRPC metadata. Keys ending in -bin take base64 values. {{vars}} are resolved.',
      rows: request.metadata.map((m) => ({ key: m.key, value: m.value, disabled: m.disabled, description: m.description })),
      onSave: (rows) => {
        pop();
        updateRequest(activeId, (r) => ({ ...r, metadata: rows.map(kvFromRow) }));
      },
    });
  };

  const authForm = (auth: Auth | undefined, allowInherit: boolean, title: string, onSave: (a: Auth | undefined) => void, http = false) => {
    const cred = (k: string) => auth?.credentials?.find((c) => c.key === k)?.value ?? '';
    const o = auth?.type === 'oauth2' ? oauthFields(auth) : undefined;
    push({
      type: 'form',
      title,
      initial: {
        type: auth?.type ?? (allowInherit ? 'inherit' : 'noauth'),
        token: cred('token'),
        username: cred('username'),
        password: cred('password'),
        key: cred('key'),
        value: cred('value'),
        in: cred('in') || 'header',
        grant: o ? (o.grantType === 'client_credentials' || (!o.grantType && o.tokenUrl && !o.accessToken) ? 'client_credentials' : 'manual') : 'client_credentials',
        accessTokenUrl: o?.tokenUrl ?? '',
        clientId: o?.clientId ?? '',
        clientSecret: o?.clientSecret ?? '',
        scope: o?.scope ?? '',
        audience: o?.audience ?? '',
        clientAuth: o && /header|basic/i.test(o.clientAuth) ? 'header' : 'body',
        headerPrefix: o?.headerPrefix ?? '',
        accessToken: o?.accessToken ?? '',
      },
      fields: (v) => {
        const types = [
          ...(allowInherit ? [{ value: 'inherit', label: 'inherit from parent' }] : []),
          { value: 'noauth', label: 'no auth' },
          { value: 'bearer', label: 'bearer token' },
          { value: 'basic', label: 'basic auth' },
          { value: 'apikey', label: http ? 'API key' : 'API key (metadata)' },
          { value: 'oauth2', label: 'OAuth 2.0' },
        ];
        if (!types.some((t) => t.value === v.type)) types.push({ value: String(v.type), label: `${v.type} (unsupported, ignored)` });
        const f: FormField[] = [{ id: 'type', label: 'Type', kind: 'select', value: String(v.type), options: types }];
        const text = (id: string, label: string, placeholder: string, secret = false, hint = 'Use {{variable}} to keep secrets in an environment') =>
          f.push({ id, label, kind: 'text', value: String(v[id] ?? ''), placeholder, mask: secret && !isVarRef(String(v[id] ?? '')), hint });
        if (v.type === 'bearer') text('token', 'Token', '{{token}}', true, 'Sent as "Authorization: Bearer <token>" (a leading "Bearer " is fine); empty tokens are not sent');
        if (v.type === 'basic') {
          text('username', 'Username', '{{username}}');
          text('password', 'Password', '{{password}}', true);
        }
        if (v.type === 'apikey') {
          text('key', http ? 'Key' : 'Metadata key', 'x-api-key');
          text('value', 'Value', '{{apiKey}}', true);
          if (http) {
            f.push({
              id: 'in',
              label: 'Add to',
              kind: 'select',
              value: String(v.in),
              options: [
                { value: 'header', label: 'header' },
                { value: 'query', label: 'query parameter' },
              ],
            });
          }
        }
        if (v.type === 'oauth2') {
          f.push({
            id: 'grant',
            label: 'Grant type',
            kind: 'select',
            value: String(v.grant),
            options: [
              { value: 'client_credentials', label: 'client credentials (fetch automatically)' },
              { value: 'manual', label: 'paste an access token' },
            ],
          });
          if (v.grant === 'client_credentials') {
            text('accessTokenUrl', 'Token URL', 'https://auth.example.com/oauth/token', false, 'POSTed with grant_type=client_credentials; the token is cached until it expires');
            text('clientId', 'Client ID', '{{clientId}}');
            text('clientSecret', 'Client secret', '{{clientSecret}}', true);
            text('scope', 'Scope', 'optional, space separated', false, '');
            text('audience', 'Audience', 'optional (Auth0 and similar)', false, '');
            f.push({
              id: 'clientAuth',
              label: 'Send client creds',
              kind: 'select',
              value: String(v.clientAuth),
              options: [
                { value: 'body', label: 'in the request body' },
                { value: 'header', label: 'as a Basic auth header' },
              ],
            });
          } else {
            text('accessToken', 'Access token', '{{accessToken}}', true);
          }
          text('headerPrefix', 'Header prefix', 'Bearer', false, '');
        }
        return f;
      },
      onSave: (v) => {
        pop();
        const type = String(v.type);
        if (type === 'inherit') return onSave(undefined);
        const keep = (keys: string[]) => keys.filter((k) => String(v[k] ?? '').trim()).map((k) => ({ key: k, value: String(v[k]).trim() }));
        let credentials: KV[] | undefined;
        if (type === 'bearer') credentials = keep(['token']);
        else if (type === 'basic') credentials = [{ key: 'username', value: String(v.username ?? '') }, { key: 'password', value: String(v.password ?? '') }];
        else if (type === 'apikey') credentials = keep(http ? ['key', 'value', 'in'] : ['key', 'value']);
        else if (type === 'oauth2') {
          // Postman v2.1 key names, so exports open in Postman.
          credentials =
            v.grant === 'client_credentials'
              ? [
                  { key: 'grant_type', value: 'client_credentials' },
                  ...keep(['accessTokenUrl', 'clientId', 'clientSecret', 'scope', 'audience', 'headerPrefix']),
                  { key: 'client_authentication', value: v.clientAuth === 'header' ? 'header' : 'body' },
                ]
              : keep(['accessToken', 'headerPrefix']);
        }
        const base: Auth = { ...(auth?.type === type ? auth : {}), type, credentials: credentials ?? (auth?.type === type ? auth.credentials : []) };
        onSave(base);
      },
    });
  };

  const editAuth = () => {
    if (!request) return;
    authForm(request.auth, true, `Auth · ${request.name}`, (a) => updateAny(activeId, (r) => ({ ...r, auth: a })), request.type === 'http');
  };

  // --- HTTP editors -------------------------------------------------------------------
  const pickHttpMethod = () => {
    if (!httpReq) return;
    push({
      type: 'picker',
      title: 'HTTP method',
      items: HTTP_METHODS.map((m) => ({ label: m, value: m, color: METHOD_COLORS[m] })) as PickerItem<unknown>[],
      initialIndex: Math.max(0, HTTP_METHODS.indexOf(httpReq.method as (typeof HTTP_METHODS)[number])),
      onSelect: (m) => {
        pop();
        updateHttp(activeId, (r) => ({ ...r, method: m as string }));
      },
    });
  };

  const editParams = () => {
    if (!httpReq) return;
    push({
      type: 'kv',
      title: `Query params · ${httpReq.name}`,
      hint: 'Appended to the URL (URL-encoded). {{vars}} are resolved. Typing ?a=1 into the URL also adds params here.',
      rows: httpReq.queryParams.map((q) => ({ key: q.key, value: q.value, disabled: q.disabled, description: q.description })),
      onSave: (rows) => {
        pop();
        updateHttp(activeId, (r) => ({ ...r, queryParams: rows.map(kvFromRow) }));
      },
    });
  };

  const editPathVars = () => {
    if (!httpReq) return;
    const names = pathVariableNames(httpReq.url);
    const rows = [
      ...names.map((n) => {
        const pv = httpReq.pathVariables.find((p) => p.key === n);
        return { key: n, value: pv?.value ?? '', description: pv?.description };
      }),
      ...httpReq.pathVariables.filter((p) => !names.includes(p.key)).map((p) => ({ key: p.key, value: p.value, disabled: true, description: p.description })),
    ];
    push({
      type: 'kv',
      title: `Path variables · ${httpReq.name}`,
      hint: 'Values for :name segments in the URL, e.g. /notes/:id. Unused ones are shown disabled.',
      rows,
      onSave: (saved) => {
        pop();
        updateHttp(activeId, (r) => ({ ...r, pathVariables: saved.filter((x) => !x.disabled || names.includes(x.key)).map(kvFromRow) }));
      },
    });
  };

  const editHeaders = () => {
    if (!httpReq) return;
    const inherited = [...(collection?.headers ?? []), ...ancestors.flatMap((a) => a.headers ?? [])];
    push({
      type: 'kv',
      title: `Headers · ${httpReq.name}`,
      hint: `Auth headers are added from the Auth field.${inherited.length ? ` Inherited from folders/collection: ${inherited.map((h) => h.key).join(', ')}.` : ''}`,
      rows: httpReq.headers.map((h) => ({ key: h.key, value: h.value, disabled: h.disabled, description: h.description })),
      onSave: (rows) => {
        pop();
        updateHttp(activeId, (r) => ({ ...r, headers: rows.map(kvFromRow) }));
      },
    });
  };

  const BODY_TYPES = [
    { value: 'none', label: 'none' },
    { value: 'json', label: 'JSON' },
    { value: 'text', label: 'text' },
    { value: 'xml', label: 'XML' },
    { value: 'html', label: 'HTML' },
    { value: 'javascript', label: 'JavaScript' },
    { value: 'urlencoded', label: 'form-urlencoded' },
    { value: 'formdata', label: 'multipart form (fields and files)' },
    { value: 'graphql', label: 'GraphQL' },
    { value: 'file', label: 'binary file' },
  ];

  const editBodyFields = (type: 'urlencoded' | 'formdata') => {
    if (!httpReq) return;
    push({
      type: 'kv',
      title: `${type === 'formdata' ? 'Multipart form' : 'Form-urlencoded'} fields · ${httpReq.name}`,
      hint: type === 'formdata' ? 'A value starting with @ sends that file, e.g. @./report.pdf (relative to the collection folder).' : 'Sent as application/x-www-form-urlencoded.',
      rows: (httpReq.body.fields ?? []).map((f) => ({ key: f.key, value: f.type === 'file' ? `@${f.value}` : f.value, disabled: f.disabled, description: f.description })),
      onSave: (rows) => {
        pop();
        const fields = rows.map((row) => {
          const file = type === 'formdata' && row.value.startsWith('@');
          return { key: row.key, value: file ? row.value.slice(1) : row.value, ...(file ? { type: 'file' as const } : {}), ...(row.disabled ? { disabled: true } : {}), ...(row.description ? { description: row.description } : {}) };
        });
        updateHttp(activeId, (r) => ({ ...r, body: { ...r.body, type, fields } }));
      },
    });
  };

  /** Body type picker, then the matching editor. */
  const editBody = () => {
    if (!httpReq) return;
    push({
      type: 'picker',
      title: 'Body type',
      items: BODY_TYPES as PickerItem<unknown>[],
      initialIndex: Math.max(0, BODY_TYPES.findIndex((t) => t.value === httpReq.body.type)),
      onSelect: (v) => {
        pop();
        const type = v as HttpRequest['body']['type'];
        updateHttp(activeId, (r) => ({ ...r, body: { ...r.body, type } }));
        if (type === 'urlencoded' || type === 'formdata') return editBodyFields(type);
        if (type === 'file') {
          return push({
            type: 'prompt',
            title: 'File to send as the body',
            initial: httpReq.body.type === 'file' ? (httpReq.body.content ?? '') : '',
            placeholder: './payload.bin',
            onSubmit: (path) => {
              pop();
              updateHttp(activeId, (r) => ({ ...r, body: { ...r.body, type: 'file', content: path.trim() } }));
            },
          });
        }
        if (type === 'graphql') {
          push({
            type: 'prompt',
            title: 'GraphQL variables (JSON, optional)',
            initial: httpReq.body.variables ?? '',
            placeholder: '{"id": "{{noteId}}"}',
            hint: 'Edit the query itself in the Content area below (enter on it).',
            onSubmit: (vars) => {
              pop();
              updateHttp(activeId, (r) => ({ ...r, body: { ...r.body, type: 'graphql', variables: vars.trim() || undefined } }));
            },
          });
        }
        if (type !== 'none') setField('message');
      },
    });
  };

  const editHttpSettings = () => {
    if (!httpReq) return;
    const s = httpReq.settings;
    push({
      type: 'form',
      title: `Settings · ${httpReq.name}`,
      initial: {
        follow: s.followRedirects ?? true,
        maxRedirects: s.maxRedirects !== undefined ? String(s.maxRedirects) : '',
        strict: s.strictSSL ?? true,
        timeout: s.timeout ? String(s.timeout) : '',
        ...tlsInitial(httpReq.tls),
      },
      fields: (v) => [
        { id: 'follow', label: 'Follow redirects', kind: 'toggle', value: Boolean(v.follow) },
        ...(v.follow ? ([{ id: 'maxRedirects', label: 'Max redirects', kind: 'text', value: String(v.maxRedirects ?? ''), placeholder: 'default' }] as FormField[]) : []),
        { id: 'strict', label: 'Verify TLS certs', kind: 'toggle', value: Boolean(v.strict), hint: 'Turn off for self-signed development certificates' },
        { id: 'timeout', label: 'Timeout', kind: 'text', value: String(v.timeout ?? ''), placeholder: 'none (ms)' },
        ...tlsFileFields(v),
      ],
      onSave: (v) => {
        pop();
        const num = (x: unknown) => (String(x).trim() !== '' && Number(x) >= 0 ? Number(x) : undefined);
        updateHttp(activeId, (r) => {
          const settings: HttpRequest['settings'] = {};
          if (!v.follow) settings.followRedirects = false;
          const max = num(v.maxRedirects);
          if (v.follow && max !== undefined) settings.maxRedirects = max;
          if (!v.strict) settings.strictSSL = false;
          const t = num(v.timeout);
          if (t) settings.timeout = t;
          return { ...r, settings, tls: tlsFromForm(v) };
        });
      },
    });
  };

  const saveResponseBody = () => {
    const r = activeId ? results[activeId] : undefined;
    if (!isHttpResult(r) || !r.body.length) return setToast('No response body to save', theme.muted);
    const ext = /json/.test(r.contentType ?? '') ? 'json' : /pdf/.test(r.contentType ?? '') ? 'pdf' : /csv/.test(r.contentType ?? '') ? 'csv' : /xml/.test(r.contentType ?? '') ? 'xml' : /text/.test(r.contentType ?? '') ? 'txt' : 'bin';
    const disposition = r.headers.find(([k]) => k.toLowerCase() === 'content-disposition')?.[1];
    const suggested = /filename="?([^";]+)"?/i.exec(disposition ?? '')?.[1] ?? `${(request?.name ?? 'response').replace(/[^\w.-]+/g, '_')}.${ext}`;
    push({
      type: 'prompt',
      title: `Save response body (${formatBytes(r.body.length)})`,
      initial: join(process.cwd(), basename(suggested)),
      onSubmit: (path) => {
        pop();
        try {
          writeFileSync(expandHome(path.trim()), r.body);
          setToast(`Saved ${formatBytes(r.body.length)} to ${path.trim()}`, theme.ok);
        } catch (err) {
          setToast(`Could not save: ${(err as Error).message}`, theme.error);
        }
      },
    });
  };

  const editSettings = () => {
    if (httpReq) return editHttpSettings();
    const request = grpcReq;
    if (!request) return;
    const s = request.settings;
    const src = request.schema;
    const inherited = sourceLabel(collection?.schema);
    push({
      type: 'form',
      title: `Settings · ${request.name}`,
      initial: {
        tls: s.secureConnection ?? false,
        strict: s.strictSSL ?? true,
        source: src?.type ?? 'inherit',
        protoFiles: src?.type === 'proto' ? src.files.join(', ') : '',
        importPaths: src?.type === 'proto' ? src.importPaths.join(', ') : '',
        protosets: src?.type === 'protoset' ? src.files.join(', ') : '',
        ...tlsInitial(request.tls),
        serverName: s.serverName ?? '',
        includeDefaults: s.includeDefaultFields ?? true,
        timeout: s.connectionTimeout ? String(s.connectionTimeout) : '',
        maxSize: s.maxResponseMessageSize ? String(s.maxResponseMessageSize) : '',
      },
      fields: (v) => [
        { id: 'tls', label: 'TLS', kind: 'toggle', value: Boolean(v.tls), hint: 'grpcs:// and https:// URLs always use TLS' },
        ...(v.tls
          ? ([{ id: 'strict', label: 'Verify certificate', kind: 'toggle', value: Boolean(v.strict), hint: 'Turn off for self-signed development certificates' }] as FormField[])
          : []),
        ...(v.tls ? tlsFileFields(v) : []),
        ...(v.tls
          ? ([
              {
                id: 'serverName',
                label: 'Server name',
                kind: 'text',
                value: String(v.serverName ?? ''),
                placeholder: 'from the URL',
                hint: 'TLS name and :authority to use instead of the URL host (tunnels, port-forwards, proxies)',
              },
            ] as FormField[])
          : []),
        ...schemaFormFields(v, `${inherited} from collection`),
        { id: 'includeDefaults', label: 'Emit default fields', kind: 'toggle', value: Boolean(v.includeDefaults), hint: 'Show zero-valued fields in responses' },
        { id: 'timeout', label: 'Connect timeout', kind: 'text', value: String(v.timeout ?? ''), placeholder: 'none (ms)', hint: 'Milliseconds to wait for the channel to connect' },
        { id: 'maxSize', label: 'Max response size', kind: 'text', value: String(v.maxSize ?? ''), placeholder: 'default 4 MB (bytes)' },
      ],
      onSave: (v) => {
        pop();
        const num = (x: unknown) => (Number(x) > 0 ? Number(x) : undefined);
        updateRequest(activeId, (r) => {
          const settings = { ...r.settings, secureConnection: Boolean(v.tls), includeDefaultFields: Boolean(v.includeDefaults) };
          if (v.tls) settings.strictSSL = Boolean(v.strict);
          else delete settings.strictSSL;
          settings.connectionTimeout = num(v.timeout);
          settings.maxResponseMessageSize = num(v.maxSize);
          settings.serverName = v.tls && String(v.serverName ?? '').trim() ? String(v.serverName).trim() : undefined;
          for (const k of Object.keys(settings) as Array<keyof typeof settings>) if (settings[k] === undefined) delete settings[k];
          return { ...r, settings, schema: schemaFromForm(v), tls: tlsFromForm(v) };
        });
      },
    });
  };

  const editCollectionSettings = (c: Collection) => {
    const src = c.schema;
    push({
      type: 'form',
      title: `Collection settings · ${c.name}`,
      initial: {
        source: src?.type ?? 'reflection',
        protoFiles: src?.type === 'proto' ? src.files.join(', ') : '',
        importPaths: src?.type === 'proto' ? src.importPaths.join(', ') : '',
        protosets: src?.type === 'protoset' ? src.files.join(', ') : '',
        ...tlsInitial(c.tls),
      },
      fields: (v) => [...schemaFormFields(v), ...tlsFileFields(v)],
      // (TLS files here apply to both the gRPC and HTTP requests in the collection.)
      onSave: (v) => {
        pop();
        c.schema = schemaFromForm(v);
        c.tls = tlsFromForm(v);
        ws.saveCollection(c);
        setToast('Collection settings saved', theme.ok);
      },
    });
  };

  const editVariables = (target: { name: string; variables?: KV[] }, onSave: (kvs: KV[]) => void) => {
    push({
      type: 'kv',
      title: `Variables · ${target.name}`,
      hint: 'Referenced as {{name}} in URL, metadata, auth and message. Environment values override these.',
      rows: (target.variables ?? []).map((v) => ({ key: v.key, value: v.value, disabled: v.disabled, description: v.description })),
      onSave: (rows) => {
        pop();
        onSave(rows.map(kvFromRow));
      },
    });
  };

  const editEnvironment = (e: Environment) => {
    push({
      type: 'kv',
      title: `Environment · ${e.name}`,
      allowSecret: true,
      hint: 'Environment values override collection variables. Mark tokens as secret to mask them.',
      rows: e.values.map((v) => ({ key: v.key, value: v.value, disabled: v.enabled === false, secret: v.type === 'secret', description: v.description })),
      onSave: (rows) => {
        pop();
        e.values = rows.map((r) => ({ key: r.key, value: r.value, enabled: !r.disabled, type: r.secret ? 'secret' : 'default', ...(r.description ? { description: r.description } : {}) }));
        ws.saveEnvironment(e);
      },
    });
  };

  const importPrompt = () =>
    push({
      type: 'prompt',
      title: 'Import Postman v3 collection',
      initial: process.cwd(),
      hint: 'A folder containing postman/collections (and postman/environments), a single collection folder, or an *.environment.yaml file.',
      onSubmit: (path) => {
        pop();
        try {
          const res = ws.importV3(expandHome(path.trim()));
          setExpanded((e) => {
            const next = new Set(e);
            res.collections.forEach((c) => next.add(c.id));
            return next;
          });
          const count = (t: string) => res.collections.reduce((n, c) => n + [...walkItems(c.items)].filter((x) => x.item.type === t).length, 0);
          const parts = [count('http') ? `${count('http')} HTTP` : '', count('grpc') ? `${count('grpc')} gRPC` : ''].filter(Boolean).join(' + ') || 'no';
          setToast(
            `Imported ${res.collections.length} collection(s) (${res.formats.join(', ')}) with ${parts} request(s), ${res.environments.length} environment(s)` +
              (res.replaced.length ? ` · updated: ${res.replaced.join(', ')}` : '') +
              (res.activatedEnvironment ? ` · environment "${res.activatedEnvironment}" activated` : ''),
            theme.ok,
          );
          if (res.warnings.length) push({ type: 'text', title: `Import warnings (${res.warnings.length})`, text: res.warnings.join('\n') });
        } catch (err) {
          setToast(`Import failed: ${(err as Error).message}`, theme.error);
        }
      },
    });

  const exportPrompt = (c: Collection) =>
    push({
      type: 'prompt',
      title: `Export "${c.name}" as Postman v3`,
      initial: process.cwd(),
      hint: 'Workspace root; files are written to <root>/postman/collections/<name>/ and environments to <root>/postman/environments/.',
      onSubmit: (path) => {
        const root = expandHome(path.trim());
        const run = (replaceDir: boolean) => {
          try {
            const written = ws.exportV3(c.id, root, { withEnvironments: true, replace: replaceDir });
            setToast(`Exported to ${written[0]} (secret environment values left blank)`, theme.ok);
          } catch (err) {
            setToast(`Export failed: ${(err as Error).message}`, theme.error);
          }
        };
        const dir = ws.exportDir(c.id, root);
        if (existsSync(dir)) {
          replace({
            type: 'confirm',
            title: 'Replace existing export?',
            message: `${dir} already exists. Its contents will be deleted and rewritten so removed requests don't linger. Continue?`,
            onConfirm: () => {
              pop();
              run(true);
            },
          });
        } else {
          pop();
          run(false);
        }
      },
    });

  const openExternalEditor = () => {
    if (!request) return;
    if (request.type === 'http' && !bodyText(request).editable) return setToast('Pick a text body type (JSON, text, XML…) in Body first', theme.warn);
    const current = request.type === 'grpc' ? request.message : (request.body.content ?? '');
    const ext = request.type === 'http' && request.body.type !== 'json' ? (request.body.type === 'xml' ? '.xml' : request.body.type === 'graphql' ? '.graphql' : '.txt') : '.json';
    const res = editInExternalEditor(current, ext);
    if (res.error) setToast(res.error, theme.error);
    else if (res.text !== undefined) {
      updateRequest(activeId, (r) => ({ ...r, message: res.text! }));
      updateHttp(activeId, (r) => ({ ...r, body: { ...r.body, content: res.text! } }));
    }
    setSpin((n) => n + 1);
  };

  // --- sidebar actions -----------------------------------------------------------
  const sidebarCollections = (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
    const row = treeRow;
    if (key.upArrow || input === 'k') return moveTree(tIndex - 1);
    if (key.downArrow || input === 'j') return moveTree(tIndex + 1);
    if (key.pageUp) return moveTree(tIndex - sidebarList);
    if (key.pageDown) return moveTree(tIndex + sidebarList);
    if (key.home) return moveTree(0);
    if (key.end) return moveTree(tree.length - 1);
    if (input === 'c') {
      return push({
        type: 'prompt',
        title: 'New collection',
        placeholder: 'My API',
        onSubmit: (name) => {
          pop();
          if (!name.trim()) return;
          const col = ws.createCollection(name.trim());
          const next = new Set(expanded).add(col.id);
          setExpanded(next);
          selectTreeId(col.id, buildTree(ws.collections, next));
        },
      });
    }
    if (!row) return;
    const container = containerOf(row)!;
    if (key.leftArrow || input === 'h') {
      if ((row.kind === 'collection' || row.kind === 'folder') && row.expanded) return setExpanded((e) => toggle(e, row.id, false));
      if (row.kind !== 'collection') return selectTreeId(row.parentId);
      return;
    }
    if (key.rightArrow || input === 'l') {
      if ((row.kind === 'collection' || row.kind === 'folder') && !row.expanded) setExpanded((e) => toggle(e, row.id, true));
      return;
    }
    if (key.return || input === ' ') {
      if (row.kind === 'collection' || row.kind === 'folder') return setExpanded((e) => toggle(e, row.id));
      if (row.kind === 'grpc' || row.kind === 'http') {
        openRequest(row.id);
        if (key.return) setFocus('request');
        return;
      }
      return setToast(`${row.hint ?? 'This'} requests are kept for export but can't be sent from here`, theme.muted);
    }
    if (input === 'n') {
      return chooseKind('New request', (kind) =>
        push({
          type: 'prompt',
          title: `New ${kind === 'http' ? 'HTTP' : 'gRPC'} request name`,
          placeholder: kind === 'http' ? 'List notes' : 'SayHello',
          onSubmit: (name) => {
            pop();
            createRequestIn(container.collectionId, container.parentId, { name: name.trim() || 'New request' }, kind);
            setFocus('request');
            setField('url');
          },
        }),
      );
    }
    if (input === 'f') {
      return push({
        type: 'prompt',
        title: 'New folder name',
        onSubmit: (name) => {
          pop();
          if (!name.trim()) return;
          const folder = ws.addFolder(container.collectionId, container.parentId, name.trim());
          const next = new Set(expanded).add(container.collectionId).add(container.parentId).add(folder.id);
          setExpanded(next);
          selectTreeId(folder.id, buildTree(ws.collections, next));
        },
      });
    }
    if (input === 'r') {
      return push({
        type: 'prompt',
        title: `Rename ${row.kind}`,
        initial: row.label,
        onSubmit: (name) => {
          pop();
          if (!name.trim()) return;
          ws.renameItem(row.id, name.trim());
          if (drafts[row.id]) updateRequest(row.id, (r) => ({ ...r, name: name.trim() }));
        },
      });
    }
    if (input === 'd') {
      return push({
        type: 'confirm',
        title: `Delete ${row.kind}?`,
        message: `Delete "${row.label}"${row.childCount ? ` and its ${row.childCount} item(s)` : ''}? This cannot be undone.`,
        onConfirm: () => {
          pop();
          if (row.kind === 'collection') ws.deleteCollection(row.id);
          else ws.deleteItem(row.id);
          if (activeId && !ws.locate(activeId) && !drafts[activeId]?.scratch) setActiveId(undefined);
          moveTree(tIndex - 1);
        },
      });
    }
    if (input === 'y' && row.kind !== 'collection') {
      const copy = ws.duplicateItem(row.id);
      if (copy) selectTreeId(copy.id, buildTree(ws.collections, expanded));
      return;
    }
    if ((input === 'K' || input === 'J') && row.kind !== 'collection') {
      ws.moveItem(row.id, input === 'K' ? -1 : 1);
      selectTreeId(row.id, buildTree(ws.collections, expanded));
      return;
    }
    if (input === 'v') {
      const c = ws.collection(row.collectionId)!;
      if (row.kind === 'folder' && row.item?.type === 'folder') {
        const folder = row.item;
        return editVariables(folder, (kvs) => {
          folder.variables = kvs;
          ws.saveCollection(c);
        });
      }
      return editVariables(c, (kvs) => {
        c.variables = kvs;
        ws.saveCollection(c);
      });
    }
    if (input === 's') {
      if (row.kind === 'grpc' || row.kind === 'http') {
        // Open it and put the cursor on Settings (the modal needs the request active first).
        openRequest(row.id);
        setFocus('request');
        return setField('settings');
      }
      return editCollectionSettings(ws.collection(row.collectionId)!);
    }
    if (input === 'a' && (row.kind === 'collection' || row.kind === 'folder')) {
      const c = ws.collection(row.collectionId)!;
      const target = row.kind === 'folder' && row.item?.type === 'folder' ? row.item : c;
      return authForm(
        target.auth,
        row.kind === 'folder',
        `${row.kind === 'folder' ? 'Folder' : 'Collection'} auth · ${target.name} (inherited by requests inside)`,
        (a) => {
          target.auth = a;
          ws.saveCollection(c);
        },
        true,
      );
    }
    if (input === 'H' && (row.kind === 'collection' || row.kind === 'folder')) {
      const c = ws.collection(row.collectionId)!;
      const target = row.kind === 'folder' && row.item?.type === 'folder' ? row.item : c;
      return push({
        type: 'kv',
        title: `${row.kind === 'folder' ? 'Folder' : 'Collection'} headers · ${target.name}`,
        hint: 'Sent with every request inside: as HTTP headers, and as gRPC metadata (keys lowercased). A request header with the same name wins.',
        rows: (target.headers ?? []).map((h) => ({ key: h.key, value: h.value, disabled: h.disabled, description: h.description })),
        onSave: (rows) => {
          pop();
          target.headers = rows.length ? rows.map(kvFromRow) : undefined;
          ws.saveCollection(c);
        },
      });
    }
    if (input === 'x') return exportPrompt(ws.collection(row.collectionId)!);
  };

  const sidebarServices = (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
    const row = svcRow;
    if (key.upArrow || input === 'k') return moveSvc(sIndex - 1);
    if (key.downArrow || input === 'j') return moveSvc(sIndex + 1);
    if (key.pageUp) return moveSvc(sIndex - sidebarList);
    if (key.pageDown) return moveSvc(sIndex + sidebarList);
    if (!row) return;
    if (key.leftArrow || input === 'h') {
      if (row.kind === 'service' && row.expanded) return setSvcExpanded((e) => toggle(e, row.id, false));
      if (row.kind === 'method') return moveSvc(services.findIndex((r) => r.id === row.service));
      return;
    }
    if (key.rightArrow || input === 'l') {
      if (row.kind === 'service') setSvcExpanded((e) => toggle(e, row.id, true));
      return;
    }
    if (row.kind === 'service') {
      if (key.return || input === ' ') setSvcExpanded((e) => toggle(e, row.id));
      return;
    }
    const m = row.method!;
    if (key.return) {
      if (!request) return newScratch({ methodPath: m.path, message: methodTemplate(m), name: m.name });
      updateRequest(activeId, (r) => ({ ...r, methodPath: m.path }));
      applyTemplate(m);
      setFocus('request');
      setField('message');
      return;
    }
    if (input === 'd') return push({ type: 'text', title: m.path, text: describeMethod(m) });
    if (input === 'a') {
      const url = request?.url ?? '';
      return chooseCollection(`Add ${m.name} to…`, (collectionId, parentId) => {
        createRequestIn(collectionId, parentId, { name: m.name, url, methodPath: m.path, message: methodTemplate(m), settings: { ...(request?.settings ?? {}) } });
        setSidebarTab('collections');
        setToast(`Added ${m.name}`, theme.ok);
      });
    }
  };

  /** Applies an inline Name/URL edit. HTTP URLs move any ?query into Params, like Postman. */
  const commitEdit = (f: 'name' | 'url', v: string) => {
    setEditing(undefined);
    if (f === 'name') return updateAny(activeId, (r) => ({ ...r, name: v }));
    updateRequest(activeId, (r) => ({ ...r, url: v.trim() }));
    updateHttp(activeId, (r) => {
      const { url, query } = splitQuery(v.trim());
      const params = [...r.queryParams];
      for (const q of query) {
        const i = params.findIndex((p) => p.key === q.key);
        if (i >= 0) params[i] = { ...params[i]!, value: q.value, disabled: false };
        else params.push(q);
      }
      // Keep path variable rows in step with :names in the URL.
      const names = pathVariableNames(url);
      const pathVariables = [...r.pathVariables.filter((p) => names.includes(p.key)), ...names.filter((n) => !r.pathVariables.some((p) => p.key === n)).map((n) => ({ key: n, value: '' }))];
      return { ...r, url, queryParams: params, pathVariables };
    });
  };

  const editCertificate = (entry?: CertificateEntry) =>
    push({
      type: 'form',
      title: entry ? `Certificate · ${entry.host}` : 'New certificate rule',
      initial: { host: entry?.host ?? '', ...tlsInitial(entry) },
      fields: (v) => [
        {
          id: 'host',
          label: 'Host',
          kind: 'text',
          value: String(v.host ?? ''),
          placeholder: 'api.example.com, *.example.com, host:8443',
          hint: 'Exact host, host:port, or *.domain for subdomains; the most specific match wins',
        },
        ...tlsFileFields(v),
      ],
      onSave: (v) => {
        pop();
        const host = String(v.host ?? '').trim();
        if (!host) return setToast('A certificate rule needs a host', theme.warn);
        const tls = tlsFromForm(v) ?? {};
        ws.upsertCertificate({ ...(entry ? { id: entry.id, disabled: entry.disabled } : {}), host, caCert: undefined, clientCert: undefined, clientKey: undefined, pfx: undefined, passphrase: undefined, ...tls });
        if (entry) {
          // upsert merges; clear fields the user emptied
          const saved = ws.settings.certificates.find((c) => c.id === entry.id);
          if (saved) for (const k of TLS_KEYS) if (!tls[k]) delete saved[k];
          ws.saveSettings();
        }
        setToast(`Certificate rule for ${host} saved`, theme.ok);
      },
    });

  /** What will be sent: final headers/metadata with sources, TLS and target. */
  const showPreview = () => {
    if (!request) return;
    const base = { request, ancestors, collection, certificates: ws.settings.certificates };
    let text: (reveal: boolean) => string;
    if (httpReq && httpResolved) {
      const token = httpResolved.oauth ? cachedToken(httpResolved.oauth, ws.home)?.accessToken : undefined;
      text = (reveal) => previewHttp(httpResolved, { ...base, oauthToken: token, reveal });
    } else if (resolved) {
      let target: { address: string; tls: boolean };
      try {
        target = parseTarget(resolved.url, resolved.settings);
      } catch (err) {
        return setToast((err as Error).message, theme.warn);
      }
      const token = resolved.oauth ? cachedToken(resolved.oauth, ws.home)?.accessToken : undefined;
      text = (reveal) => previewGrpc(resolved, { ...base, oauthToken: token, reveal, target });
    } else return;
    push({ type: 'text', title: `What will be sent · ${request.name}`, text: text(false), altText: text(true), altLabel: 'reveal secrets', copy: text(true), wrap: true });
  };

  const requestKeys = (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
    if (!request) {
      if (key.return) chooseKind('New scratch request', (kind) => newScratch({}, kind));
      return;
    }
    const i = Math.max(0, requestFields.indexOf(field));
    if (key.upArrow || input === 'k') return setField(requestFields[clamp(i - 1, 0, requestFields.length - 1)]!);
    if (key.downArrow || input === 'j') return setField(requestFields[clamp(i + 1, 0, requestFields.length - 1)]!);
    if (input === 'o') return openExternalEditor();
    if (input === 'p') return showPreview();
    if (input === 'f') {
      const text = request.type === 'grpc' ? request.message : (request.body.content ?? '');
      const formatted = tryFormatJson(text);
      if (!formatted) return setToast(`${request.type === 'grpc' ? 'Message' : 'Body'} is not valid JSON`, theme.warn);
      updateRequest(activeId, (r) => ({ ...r, message: formatted }));
      updateHttp(activeId, (r) => ({ ...r, body: { ...r.body, content: formatted } }));
      return;
    }
    if (request.type === 'grpc') {
      if (input === 't') return applyTemplate();
      if (input === 'd' && method) return push({ type: 'text', title: method.path, text: describeMethod(method) });
    }
    if (!key.return) return;
    switch (field) {
      case 'name':
      case 'url':
        setEditValue(request[field]);
        setEditing(field);
        return;
      case 'method':
        return request.type === 'http' ? pickHttpMethod() : void pickMethod();
      case 'metadata':
        return editMetadata();
      case 'params':
        return editParams();
      case 'pathvars':
        return editPathVars();
      case 'headers':
        return editHeaders();
      case 'body':
        return editBody();
      case 'auth':
        return editAuth();
      case 'settings':
        return editSettings();
      case 'captures':
        return editCaptures();
      case 'scripts':
        return editScripts();
      case 'message':
        if (request.type === 'http') {
          if (request.body.type === 'urlencoded' || request.body.type === 'formdata') return editBodyFields(request.body.type);
          if (!bodyText(request).editable) return editBody();
        }
        return setMessageEditing(true);
    }
  };

  const result = activeId ? results[activeId] : undefined;
  const respLines = useMemo(() => responseLines(result, responseTab), [result, responseTab]);
  const maxResponseOffset = Math.max(0, respLines.length - responseBody);

  const valueLines = useMemo(() => respLines.flatMap((l, i) => (l.path ? [i] : [])), [respLines]);
  // Leave select mode when the response or tab changes.
  useEffect(() => setSelecting(false), [activeId, result?.startedAt, responseTab]);

  const moveSel = (to: number) => {
    setSelCursor(to);
    setResponseOffset((o) => clamp(scrollInto(to, o, responseBody), 0, maxResponseOffset));
  };
  const startSelect = () => {
    if (responseTab !== 'messages' || !valueLines.length) return setToast('No response values to select', theme.muted);
    moveSel(valueLines.find((i) => i >= responseOffset) ?? valueLines[0]!);
    setSelecting(true);
  };
  /** Returns true when the key was handled by select mode. */
  const selectKeys = (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): boolean => {
    const line = respLines[selCursor];
    const nearest = (target: number) =>
      valueLines.reduce((best, i) => (Math.abs(i - target) < Math.abs(best - target) ? i : best), valueLines[0] ?? 0);
    if (key.escape || input === 'q') return (setSelecting(false), true);
    if (key.upArrow || input === 'k') return (moveSel([...valueLines].reverse().find((i) => i < selCursor) ?? selCursor), true);
    if (key.downArrow || input === 'j') return (moveSel(valueLines.find((i) => i > selCursor) ?? selCursor), true);
    if (key.pageUp) return (moveSel(nearest(selCursor - responseBody)), true);
    if (key.pageDown || input === ' ') return (moveSel(nearest(selCursor + responseBody)), true);
    if (key.home || input === 'g') return (moveSel(valueLines[0] ?? 0), true);
    if (key.end || input === 'G') return (moveSel(valueLines.at(-1) ?? 0), true);
    if (!line?.path) return false;
    if (key.return) return (valueActions(line.path, line.value), true);
    if (input === 'y') {
      const text = valueToString(line.value);
      setToast(copyToClipboard(text) ? `Copied ${truncate(text, 60)}` : 'No clipboard tool found', theme.ok);
      return true;
    }
    if (input === 'v') return (saveVariable(line.path, line.value, false, false), true);
    if (input === 'u') return (useInTab(line.path, line.value, false), true);
    return false;
  };

  const responseKeys = (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
    if (key.return || input === 'v') return startSelect();
    const scroll = (n: number) => setResponseOffset((o) => clamp(o + n, 0, maxResponseOffset));
    if (key.upArrow || input === 'k') return scroll(-1);
    if (key.downArrow || input === 'j') return scroll(1);
    if (key.pageUp) return scroll(-responseBody);
    if (key.pageDown || input === ' ') return scroll(responseBody);
    if (key.home || input === 'g') return setResponseOffset(0);
    if (key.end || input === 'G') return setResponseOffset(maxResponseOffset);
    if (input === 'm' || key.leftArrow || key.rightArrow) {
      setResponseOffset(0);
      return setResponseTab((t) => (t === 'messages' ? 'metadata' : 'messages'));
    }
    if (input === 's' && isHttpResult(result)) return saveResponseBody();
    if (input === 'y') {
      if (!respLines.length) return;
      const text =
        responseTab === 'messages' && result
          ? isHttpResult(result)
            ? result.body.toString('utf8')
            : result.messages.map((m) => JSON.stringify(m, null, 2)).join('\n')
          : respLines.map((l) => l.text).join('\n');
      setToast(copyToClipboard(text) ? 'Copied to clipboard' : 'No clipboard tool found (pbcopy, wl-copy, xclip, xsel)', theme.ok);
    }
  };

  // --- input routing ---------------------------------------------------------------
  const noModal = modals.length === 0;
  const textMode = !!editing || messageEditing;

  // Always-on: ctrl+c cancels a call, closes a modal, or quits.
  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;
    if (cancelRunning()) return;
    if (modals.length) return pop();
    if (editing) return setEditing(undefined);
    exit();
  });

  // Send/save work everywhere, including while typing.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'r') {
        if (editing) commitEdit(editing, editValue);
        void send();
      } else if (key.ctrl && input === 's') {
        save();
      }
    },
    { isActive: noModal },
  );

  useInput(
    (_, key) => {
      if (key.escape) setEditing(undefined);
    },
    { isActive: noModal && !!editing },
  );

  useInput(
    (input, key) => {
      // alt+1…9 jumps to a tab (terminals that send Alt as Meta)
      if (key.meta && /^[1-9]$/.test(input)) {
        const id = tabs[Number(input) - 1];
        if (id) openRequest(id);
        return;
      }
      if ((key.ctrl || key.meta) && !key.escape) return;
      if (selecting && focus === 'response' && selectKeys(input, key)) return;
      if (input === ']') return switchTab(1);
      if (input === '[') return switchTab(-1);
      if (input === '}') return moveTab(1);
      if (input === '{') return moveTab(-1);
      if (input === 'T') return pickTab();
      if (input === 'w') return activeId ? closeTabs([activeId], 'tab') : undefined;
      if (input === 'W') return activeId ? closeTabs(tabs.filter((t) => t !== activeId), 'other tabs') : undefined;
      if (key.tab) {
        const order: Focus[] = sidebarHidden ? ['request', 'response'] : ['sidebar', 'request', 'response'];
        const next = (order.indexOf(focus) + (key.shift ? -1 : 1) + order.length) % order.length;
        return setFocus(order[next]!);
      }
      if (input === '?') return push({ type: 'help' });
      if (input === 'q') return exit();
      if (input === 'P') return push({ type: 'certs' });
      if (input === 'C') {
        if (httpReq && httpResolved) {
          const cmd = toCurl(httpResolved, { oauthToken: httpResolved.oauth ? cachedToken(httpResolved.oauth, ws.home)?.accessToken : undefined });
          const notes = httpResolved.missingVars.length ? [`# unresolved: ${httpResolved.missingVars.map((v) => `{{${v}}}`).join(', ')}`, ''] : [];
          return push({ type: 'text', title: `curl · ${httpReq.name}`, text: [...notes, cmd].join('\n'), copy: cmd, wrap: true });
        }
        if (!request || !resolved) return setToast('Open a request first', theme.warn);
        const cmd = toGrpcurl(resolved, {
          clientStreaming: method ? isClientStreaming(method.kind) : undefined,
          oauthToken: resolved.oauth ? cachedToken(resolved.oauth, ws.home)?.accessToken : undefined,
        });
        const notes = [
          resolved.missingVars.length ? `# unresolved: ${resolved.missingVars.map((v) => `{{${v}}}`).join(', ')}` : '',
          resolved.schema.type === 'reflection' ? '# uses server reflection; add -proto/-protoset if the server has none' : '',
        ].filter(Boolean);
        return push({ type: 'text', title: `grpcurl · ${request.name}`, text: [...notes, ...(notes.length ? [''] : []), cmd].join('\n'), copy: cmd, wrap: true });
      }
      if (input === 'L') {
        const next = sideBySide ? 'stacked' : 'side-by-side';
        setLayout(next);
        ws.saveState({ layout: next });
        return setToast(`Layout: ${next}`, theme.info);
      }
      if (input === 'B') {
        const hidden = !sidebarHidden;
        setSidebarHidden(hidden);
        ws.saveState({ sidebarHidden: hidden });
        if (hidden && focus === 'sidebar') setFocus('request');
        return;
      }
      if (input === '1' || input === '2') {
        if (sidebarHidden) {
          setSidebarHidden(false);
          ws.saveState({ sidebarHidden: false });
        }
        setFocus('sidebar');
        return setSidebarTab(input === '1' ? 'collections' : 'services');
      }
      if (input === 'e') return push({ type: 'env' });
      if (input === 'N') return chooseKind('New scratch request', (kind) => newScratch({}, kind));
      if (input === 'R') return void ensureSchema(true);
      if (input === 'i') return importPrompt();
      if (key.escape && focus !== 'sidebar') return setFocus('sidebar');
      if (focus === 'sidebar') return sidebarTab === 'collections' ? sidebarCollections(input, key) : sidebarServices(input, key);
      if (focus === 'request') return requestKeys(input, key);
      return responseKeys(input, key);
    },
    { isActive: noModal && !textMode },
  );

  // --- render ------------------------------------------------------------------------
  const dirtyIds = new Set(Object.keys(drafts).filter(isDirty));
  const breadcrumb = !request
    ? ''
    : drafts[request.id]?.scratch
      ? 'scratch · ctrl+s to save into a collection'
      : [collection?.name, ...ancestors.map((a) => a.name)].filter(Boolean).join(' › ');

  const authSummary = (() => {
    if (!request) return '';
    const eff = effectiveAuth(request, ancestors, collection);
    const label = (a: Auth | undefined) => {
      if (!a) return 'none';
      if (a.type === 'bearer') return `bearer ${a.credentials?.find((c) => c.key === 'token')?.value.replace(/^(?!\{\{).+/, '••••') ?? ''}`;
      if (a.type === 'basic') return `basic (${a.credentials?.find((c) => c.key === 'username')?.value ?? ''})`;
      if (a.type === 'apikey') return `api key → ${a.credentials?.find((c) => c.key === 'key')?.value || 'x-api-key'}`;
      if (a.type === 'oauth2') {
        const o = oauthFields(a);
        return o.grantType === 'client_credentials' || (!o.accessToken && o.tokenUrl) ? `oauth2 client credentials (${o.tokenUrl || 'no token URL'})` : 'oauth2 access token';
      }
      return a.type;
    };
    if (request.auth && request.auth.type !== 'inherit') return label(request.auth.type === 'noauth' ? undefined : request.auth);
    return `inherit → ${label(eff)}`;
  })();

  const settingsSummary = (() => {
    if (httpReq) {
      const s = httpReq.settings;
      const parts = [s.followRedirects === false ? 'no redirects' : `follow redirects${s.maxRedirects !== undefined ? ` (max ${s.maxRedirects})` : ''}`];
      if (s.strictSSL === false) parts.push('TLS not verified');
      parts.push(s.timeout ? `timeout ${s.timeout}ms` : 'no timeout');
      return parts.join(' · ');
    }
    const request = grpcReq;
    if (!request || !resolved) return '';
    const s = request.settings;
    const tls = resolved.url.match(/^(grpcs|https):\/\//i) || s.secureConnection;
    const parts = [tls ? (s.strictSSL === false ? 'TLS (no verify)' : 'TLS') : 'plaintext'];
    parts.push(request.schema ? sourceLabel(request.schema) : collection ? `${sourceLabel(collection.schema)} (collection)` : 'reflection');
    if (s.connectionTimeout) parts.push(`timeout ${s.connectionTimeout}ms`);
    if (s.includeDefaultFields === false) parts.push('hide defaults');
    return parts.join(' · ');
  })();

  const capturesSummary = request?.captures?.length
    ? request.captures.map((c) => `{{${c.variable}}} ← ${c.path}${c.source === 'script' ? ' (from script)' : ''}`).join(', ')
    : 'none · pick a response value (enter in the response pane) to add';

  const scriptsSummary = (() => {
    if (!request) return '';
    const own = (request.scripts ?? []).map((s) => `${scriptKind(s)} (${s.code.split('\n').length} lines)`);
    const inherited = (['before', 'after'] as const).flatMap((phase) => scriptsFor(phase, { ...request, scripts: [] }, ancestors, collection)).length;
    const extra = inherited ? ` + ${inherited} from folder/collection` : '';
    return own.length ? own.join(', ') + extra : `none${extra} · enter to add a JS/TS script (e.g. save a token from the response)`;
  })();

  const servicesStatus = {
    state: (httpReq ? 'error' : urlMissingMessage ? 'error' : (schemaState?.state ?? 'idle')) as 'idle' | 'loading' | 'ready' | 'error',
    message: httpReq ? 'Service discovery is for gRPC requests. Switch to a gRPC tab to browse its services.' : (urlMissingMessage ?? schemaState?.error),
    target: resolved ? (resolved.schema.type === 'reflection' ? `reflection @ ${resolved.url || '(no url)'}` : sourceLabel(resolved.schema)) : undefined,
  };

  const hints = (() => {
    if (editing) return 'enter: apply · esc: cancel · ctrl+r: apply & send';
    if (messageEditing) return 'esc: done · enter on {{var}}: set value · ctrl+f: format · ctrl+r: send · ctrl+s: save';
    if (focus === 'sidebar' && sidebarTab === 'collections')
      return 'enter: open · n: request · f: folder · c: collection · r: rename · d: delete · v: vars · a: auth · H: headers · s: settings · x: export';
    if (focus === 'sidebar') return 'enter: use method · d: describe · a: add to collection · R: refresh';
    if (focus === 'request' && httpReq) return 'enter: edit · p: preview · o: $EDITOR · f: format · C: curl · P: certs · ctrl+r: send · ctrl+s: save';
    if (focus === 'request') return 'enter: edit · p: preview · t: template · o: $EDITOR · d: describe · C: grpcurl · ctrl+r: send · ctrl+s: save';
    if (selecting) return '↑↓: move between values · enter: use value… · y: copy · v: save as {{var}} · u: use in another tab · esc: done';
    if (isHttpResult(result)) return '↑↓: scroll · enter: select a value · m: body/headers · y: copy · s: save body to file';
    return '↑↓: scroll · enter: select a value · m: messages/metadata · y: copy all';
  })();

  const top = modals.at(-1);
  const renderModal = () => {
    if (!top) return null;
    switch (top.type) {
      case 'help':
        return <TextViewerModal title="Keyboard shortcuts" text={HELP} width={modalWidth} height={modalHeight} onClose={pop} />;
      case 'text':
        return (
          <TextViewerModal
            title={top.title}
            text={top.text}
            width={modalWidth}
            height={modalHeight}
            onClose={pop}
            render={top.json ? (line, w) => <JsonLine line={line} width={w} /> : undefined}
            wrap={top.wrap}
            altText={top.altText}
            altLabel={top.altLabel}
            onCopy={
              top.copy !== undefined
                ? () => setToast(copyToClipboard(top.copy!) ? 'Copied to clipboard' : 'No clipboard tool found (pbcopy, wl-copy, xclip, xsel)', theme.ok)
                : undefined
            }
          />
        );
      case 'prompt':
        return <PromptModal title={top.title} initial={top.initial} hint={top.hint} placeholder={top.placeholder} width={Math.min(modalWidth, 80)} onSubmit={top.onSubmit} onCancel={pop} />;
      case 'confirm':
        return <ConfirmModal title={top.title} message={top.message} width={Math.min(modalWidth, 70)} onConfirm={top.onConfirm} onCancel={pop} />;
      case 'picker':
        return (
          <PickerModal
            title={top.title}
            items={top.items}
            width={modalWidth}
            height={modalHeight}
            emptyText={top.emptyText}
            initialIndex={top.initialIndex}
            footer={top.footer}
            onSelect={top.onSelect}
            onCancel={pop}
          />
        );
      case 'form':
        return <FormModal title={top.title} width={Math.min(modalWidth, 84)} fields={top.fields} initial={top.initial} onSave={top.onSave} onCancel={pop} />;
      case 'kv':
        return (
          <KVEditorModal
            title={top.title}
            rows={top.rows}
            width={modalWidth}
            height={modalHeight}
            allowSecret={top.allowSecret}
            hint={top.hint}
            keyLabel={top.keyLabel}
            valueLabel={top.valueLabel}
            onSave={top.onSave}
            onCancel={pop}
          />
        );
      case 'certs':
        return (
          <CertManager
            certificates={ws.settings.certificates}
            width={modalWidth}
            height={modalHeight}
            onClose={pop}
            onEdit={editCertificate}
            onToggle={(c) => {
              c.disabled = !c.disabled;
              ws.saveSettings();
            }}
            onDelete={(c) =>
              push({
                type: 'confirm',
                title: 'Delete certificate rule?',
                message: `Delete the rule for ${c.host}? (The files themselves are not touched.)`,
                onConfirm: () => {
                  pop();
                  ws.removeCertificate(c.id);
                },
              })
            }
          />
        );
      case 'env':
        return (
          <EnvManager
            environments={ws.environments}
            activeId={ws.state.activeEnvironmentId}
            width={Math.min(modalWidth, 70)}
            height={Math.min(modalHeight, ws.environments.length + 6)}
            onClose={pop}
            onActivate={(id) => {
              ws.setActiveEnvironment(id);
              pop();
              setToast(id ? `Environment: ${ws.activeEnvironment?.name}` : 'No environment', theme.ok);
            }}
            onEdit={editEnvironment}
            onCreate={() =>
              push({
                type: 'prompt',
                title: 'New environment',
                placeholder: 'Local',
                onSubmit: (name) => {
                  pop();
                  if (name.trim()) editEnvironment(ws.createEnvironment(name.trim()));
                },
              })
            }
            onRename={(e) =>
              push({
                type: 'prompt',
                title: 'Rename environment',
                initial: e.name,
                onSubmit: (name) => {
                  pop();
                  if (!name.trim()) return;
                  e.name = name.trim();
                  ws.saveEnvironment(e);
                },
              })
            }
            onDelete={(e) =>
              push({
                type: 'confirm',
                title: 'Delete environment?',
                message: `Delete "${e.name}"?`,
                onConfirm: () => {
                  pop();
                  ws.deleteEnvironment(e.id);
                },
              })
            }
          />
        );
    }
  };

  return (
    <Box flexDirection="column" width={cols} height={totalHeight}>
      <Box width={cols} height={1} overflow="hidden">
        <Text backgroundColor={theme.accent} color="black" bold>
          {' ◆ ferry '}
        </Text>
        <Text color={theme.muted}> env </Text>
        <Text color={env ? theme.ok : theme.muted} bold={!!env}>
          {truncate(env ? env.name : 'none', 30)}
        </Text>
        <Text color={theme.muted}> · </Text>
        <Text color={theme.muted} wrap="truncate-end">
          {truncate(
            request
              ? `${request.name}${dirtyIds.has(request.id) ? '*' : ''}  ${
                  httpReq ? `${httpReq.method} ${httpResolved?.url ?? httpReq.url}` : `${resolved?.url ?? ''}${normalizeMethodPath(resolved?.methodPath ?? '')}`
                }`
              : `${ws.collections.length} collection(s)`,
            // title (9) + " env " (5) + env name + " · " (3) + "? help " (7)
            Math.max(10, cols - 24 - Math.min(30, (env?.name ?? 'none').length)),
          )}
        </Text>
        <Box flexGrow={1} />
        <Text color={theme.muted}>? help </Text>
      </Box>

      {top ? (
        <Box height={bodyHeight} width={cols} justifyContent="center" alignItems="center">
          {/* keyed so a replaced modal of the same type remounts with fresh state */}
          <Box key={`${modals.length}:${top.type}:${'title' in top ? top.title : ''}`}>{renderModal()}</Box>
        </Box>
      ) : (
        <Box height={bodyHeight}>
          {sidebarHidden ? null : (
          <Sidebar
            width={sidebarWidth}
            height={bodyHeight}
            focused={focus === 'sidebar'}
            tab={sidebarTab}
            tree={tree}
            treeIndex={tIndex}
            treeOffset={treeOffset}
            services={services}
            serviceIndex={sIndex}
            serviceOffset={svcOffset}
            servicesStatus={servicesStatus}
            activeId={activeId}
            dirtyIds={dirtyIds}
            currentMethod={method?.path}
          />
          )}
          <Box flexDirection="column" width={rightWidth}>
          <TabBar
            width={rightWidth}
            activeId={activeId}
            spinner={SPINNER[spin % SPINNER.length]!}
            tabs={tabs.map((id) => ({
              id,
              label: tabLabel(id),
              dirty: isDirty(id),
              scratch: !!drafts[id]?.scratch,
              status: results[id]?.state,
            }))}
          />
          <Box flexDirection={sideBySide ? 'row' : 'column'} width={rightWidth}>
            {httpReq ? (
              <HttpRequestPanel
                width={requestWidth}
                height={requestHeight}
                focused={focus === 'request'}
                request={httpReq}
                fields={requestFields}
                breadcrumb={breadcrumb}
                dirty={!!activeId && dirtyIds.has(activeId)}
                field={field}
                editing={editing}
                editValue={editValue}
                onEditChange={setEditValue}
                onEditSubmit={(v) => commitEdit(editing!, v)}
                messageEditing={messageEditing}
                onMessageChange={(v) => updateHttp(activeId, (r) => ({ ...r, body: { ...r.body, content: v } }))}
                onMessageExit={() => setMessageEditing(false)}
                vars={varLookup}
                onSetVar={setMessageVar}
                resolvedUrl={httpResolved?.url}
                authSummary={authSummary}
                settingsSummary={settingsSummary}
                capturesSummary={capturesSummary}
                scriptsSummary={scriptsSummary}
              />
            ) : (
              <RequestPanel
                width={requestWidth}
                height={requestHeight}
                focused={focus === 'request'}
                request={grpcReq}
                breadcrumb={breadcrumb}
                dirty={!!activeId && dirtyIds.has(activeId)}
                field={field}
                editing={editing}
                editValue={editValue}
                onEditChange={setEditValue}
                onEditSubmit={(v) => commitEdit(editing!, v)}
                messageEditing={messageEditing}
                onMessageChange={(v) => updateRequest(activeId, (r) => ({ ...r, message: v }))}
                onMessageExit={() => setMessageEditing(false)}
                vars={varLookup}
                onSetVar={setMessageVar}
                method={method}
                resolvedUrl={resolved?.url}
                authSummary={authSummary}
                settingsSummary={settingsSummary}
                capturesSummary={capturesSummary}
                scriptsSummary={scriptsSummary}
              />
            )}
            <ResponsePanel
              width={responseWidth}
              height={responseHeight}
              focused={focus === 'response'}
              result={result}
              tab={responseTab}
              offset={clamp(responseOffset, 0, maxResponseOffset)}
              cursor={selecting && focus === 'response' ? selCursor : undefined}
              spinner={SPINNER[spin % SPINNER.length]!}
            />
          </Box>
          </Box>
        </Box>
      )}

      <Box width={cols}>
        {toast ? (
          <Text color={toast.color} wrap="truncate-end">
            {' '}
            {truncate(toast.text, cols - 2)}
          </Text>
        ) : (
          <Text color={theme.muted} wrap="truncate-end">
            {' '}
            {truncate(`tab: focus · ${hints} · e: env · L: layout · q: quit`, cols - 2)}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function kvFromRow(r: KVRow): KV {
  const kv: KV = { key: r.key, value: r.value };
  if (r.disabled) kv.disabled = true;
  if (r.description) kv.description = r.description;
  return kv;
}
