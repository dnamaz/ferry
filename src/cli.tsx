#!/usr/bin/env node
import React, { useCallback, useState } from 'react';
import { render } from 'ink';
import { Command, Option } from 'commander';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Environment, type GrpcRequest, type HttpRequest, type SchemaSource, walkItems } from './core/model.js';
import { normalizeMethodPath } from './core/postman-v3.js';
import { type OAuthConfig, hostPort, resolveHttpRequest, resolveRequest } from './core/resolve.js';
import { certificateFor, mergeTls } from './core/tls.js';
import { type Timing, formatPhases } from './core/timing.js';
import { effectiveHttpHeaders, jsonBody, looksBinary, sendHttp } from './http/client.js';
import { toCurl } from './http/curl.js';
import { cachedToken, clearTokens, describeExpiry, getToken, withToken } from './http/oauth.js';
import { maskValue, previewGrpc, previewHttp } from './core/preview.js';
import { parseTarget } from './grpc/connection.js';
import { certSummary } from './ui/components/CertManager.js';
import { Workspace, defaultHome, migrateLegacyHome } from './core/workspace.js';
import { discover } from './grpc/discovery.js';
import { toGrpcurl } from './grpc/grpcurl.js';
import { type CallResult, invoke } from './grpc/invoke.js';
import { evaluateCaptures, evaluateHttpCaptures } from './core/captures.js';
import {
  type ScriptOutcome,
  grpcRequestInfo,
  grpcResponseInfo,
  httpRequestInfo,
  httpResponseInfo,
  runPhase,
  secretMask,
  summarizeOutcome,
  withLocals,
} from './core/scripts.js';
import { describeMethod, kindLabel, methodTemplate } from './grpc/schema.js';
import { App } from './ui/App.js';
import { Splash } from './ui/components/Splash.js';
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, setInkClear } from './ui/terminal.js';

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const migrated = migrateLegacyHome();
if (migrated) process.stderr.write(`ferry: moved your data from ${migrated} to ~/.ferry\n`);

const VERSION = '0.1.0';

/** Shows the start-up splash, then swaps in the app. */
function Root({ workspace, splash }: { workspace: Workspace; splash: boolean }) {
  const [showSplash, setShowSplash] = useState(splash);
  const done = useCallback(() => setShowSplash(false), []);
  return showSplash ? <Splash version={VERSION} onDone={done} /> : <App workspace={workspace} />;
}

const program = new Command()
  .name('ferry')
  .description('Terminal API client for gRPC and REST — discover services, manage collections, import Postman and Bruno, export Postman.\nRun without a command to open the interactive UI.')
  .option('--home <dir>', 'data directory', defaultHome())
  .version(VERSION);

function writeTiming(t: Timing | undefined): void {
  if (!t) return;
  process.stderr.write(`timing: ${formatPhases(t)}\n`);
  if (t.serverMs !== undefined) process.stderr.write(`server: ${t.serverMs} ms (${t.serverSource})\n`);
}

const ws = () => new Workspace(resolve(program.opts().home as string));

interface TargetOpts {
  plaintext?: boolean;
  tls?: boolean;
  insecure?: boolean;
  proto?: string[];
  importPath?: string[];
  protoset?: string[];
  header?: string[];
  cacert?: string;
  cert?: string;
  key?: string;
  pfx?: string;
  passphrase?: string;
  servername?: string;
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

function targetOptions(cmd: Command): Command {
  return cmd
    .option('--tls', 'use TLS (implied by grpcs://)')
    .option('--insecure', 'TLS without certificate verification')
    .option('--proto <file>', '.proto file instead of reflection (repeatable)', collect)
    .option('-I, --import-path <dir>', 'proto import path (repeatable)', collect)
    .option('--protoset <file>', 'FileDescriptorSet file instead of reflection (repeatable)', collect)
    .option('-H, --header <key:value>', 'metadata entry (repeatable)', collect)
    .option('--cacert <file>', 'CA certificate (PEM)')
    .option('--cert <file>', 'client certificate (PEM)')
    .option('--key <file>', 'client key (PEM)')
    .option('--pfx <file>', 'client PKCS#12 bundle (.p12/.pfx)')
    .option('--passphrase <value>', 'passphrase for the key or bundle')
    .option('--servername <name>', 'TLS server name and :authority override');
}

function sourceFrom(o: TargetOpts): SchemaSource {
  if (o.proto?.length) return { type: 'proto', files: o.proto, importPaths: o.importPath ?? [] };
  if (o.protoset?.length) return { type: 'protoset', files: o.protoset };
  return { type: 'reflection' };
}

function headersFrom(o: TargetOpts) {
  return (o.header ?? []).map((h) => {
    const i = h.indexOf(':');
    if (i < 0) throw new Error(`Invalid header "${h}", expected key:value`);
    return { key: h.slice(0, i).trim(), value: h.slice(i + 1).trim() };
  });
}

function settingsFrom(o: TargetOpts) {
  const tls = o.tls || o.insecure;
  return { secureConnection: tls ?? false, ...(o.insecure ? { strictSSL: false } : {}), ...(o.servername ? { serverName: o.servername } : {}) };
}

/** Command-line TLS files over any per-host certificate rule for the target. */
function tlsFrom(o: TargetOpts, url?: string) {
  const own = { caCert: o.cacert, clientCert: o.cert, clientKey: o.key, pfx: o.pfx, passphrase: o.passphrase };
  if (!url) return own;
  const { host, port } = hostPort(url);
  return mergeTls(certificateFor(ws().settings.certificates, host, port), own);
}

const print = (v: unknown) => process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);

async function withErrors(fn: () => Promise<void> | void) {
  try {
    await fn();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// --- discovery ---------------------------------------------------------------

targetOptions(program.command('list').argument('<url>', 'host:port or grpcs://host').description('List services and methods')).action((url: string, o: TargetOpts) =>
  withErrors(async () => {
    const schema = await discover({ source: sourceFrom(o), url, settings: settingsFrom(o), tls: tlsFrom(o, url), metadata: headersFrom(o) });
    for (const s of schema.services) {
      print(s.name);
      for (const m of s.methods) print(`  ${m.name.padEnd(32)} ${kindLabel(m.kind).padEnd(14)} ${m.desc.input.typeName} → ${m.desc.output.typeName}`);
    }
  }),
);

targetOptions(
  program
    .command('describe')
    .argument('<url>')
    .argument('<method>', 'pkg.Service/Method')
    .option('--template', 'print an example request message instead')
    .option('--proto-names', 'template uses proto field names (tenant_id) instead of JSON names (tenantId)')
    .description('Show the proto definition of a method'),
).action((url: string, methodPath: string, o: TargetOpts & { template?: boolean; protoNames?: boolean }) =>
  withErrors(async () => {
    const schema = await discover({ source: sourceFrom(o), url, settings: settingsFrom(o), tls: tlsFrom(o, url), metadata: headersFrom(o) });
    const m = schema.findMethod(normalizeMethodPath(methodPath));
    if (!m) throw new Error(`method ${methodPath} not found`);
    print(o.template ? methodTemplate(m, { protoNames: o.protoNames }) : describeMethod(m));
  }),
);

targetOptions(
  program
    .command('call')
    .argument('<url>')
    .argument('<method>', 'pkg.Service/Method')
    .option('-d, --data <json>', 'request message (JSON; array for client streaming); "@file" reads a file, "-" reads stdin', '{}')
    .option('--deadline <ms>', 'call deadline in milliseconds')
    .option('-v, --verbose', 'print headers, trailers and status to stderr')
    .option('--proto-names', 'print response fields with proto names (tenant_id) instead of JSON names (tenantId)')
    .description('Invoke a method'),
).action((url: string, methodPath: string, o: TargetOpts & { data: string; deadline?: string; verbose?: boolean; protoNames?: boolean }) =>
  withErrors(async () => {
    const schema = await discover({ source: sourceFrom(o), url, settings: settingsFrom(o), tls: tlsFrom(o, url), metadata: headersFrom(o) });
    const method = schema.findMethod(normalizeMethodPath(methodPath));
    if (!method) throw new Error(`method ${methodPath} not found`);
    const message = await readData(o.data);
    await runCall({ url, settings: settingsFrom(o), tls: tlsFrom(o, url), schema, method, message, metadata: headersFrom(o), deadlineMs: o.deadline ? Number(o.deadline) : undefined, protoFieldNames: o.protoNames }, !!o.verbose);
  }),
);

async function readData(data: string): Promise<string> {
  if (data === '-') {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (data.startsWith('@')) return (await import('node:fs')).readFileSync(data.slice(1), 'utf8');
  return data;
}

async function runCall(opts: Parameters<typeof invoke>[0], verbose: boolean, after?: (r: CallResult) => void | Promise<void>) {
  let printed = 0;
  const handle = invoke({
    ...opts,
    onUpdate: (r) => {
      // Stream messages as they arrive.
      for (; printed < r.messages.length; printed++) print(r.messages[printed]);
    },
  });
  process.once('SIGINT', () => handle.cancel());
  const r = await handle.done;
  for (; printed < r.messages.length; printed++) print(r.messages[printed]);
  if (verbose) {
    for (const [k, v] of r.headers) process.stderr.write(`< ${k}: ${v}\n`);
    for (const [k, v] of r.trailers) process.stderr.write(`< (trailer) ${k}: ${v}\n`);
    process.stderr.write(`status: ${r.codeName ?? r.state} (${r.durationMs} ms, sent ${r.requestBytes ?? 0} bytes, received ${r.responseBytes ?? 0} bytes)\n`);
    writeTiming(r.timing);
  }
  if (r.state !== 'cancelled' && r.code !== undefined) await after?.(r);
  if (r.error) throw new Error(r.error);
  if (r.state !== 'done') {
    process.stderr.write(`${r.codeName ?? r.state}: ${r.details ?? ''}\n`);
    process.exit(r.code && r.code > 0 ? Math.min(r.code, 125) : 1);
  }
}

// --- collections -------------------------------------------------------------

program
  .command('import')
  .argument('<path>', 'Postman v3 folder, *.postman_collection.json, Bruno folder (bruno.json / opencollection.yml), environment file, or a folder holding any of these')
  .description('Import Postman (v2.1 JSON, v3 YAML) or Bruno (.bru, YAML) collections and environments')
  .action((path: string) =>
    withErrors(() => {
      const res = ws().importPath(resolve(path));
      print(`format: ${res.formats.join(', ')}`);
      for (const c of res.collections) {
        const items = [...walkItems(c.items)].map((x) => x.item);
        const parts = [
          ['http', 'HTTP'],
          ['grpc', 'gRPC'],
          ['other', 'other (kept, not sendable)'],
        ]
          .map(([t, label]) => [items.filter((i) => i.type === t).length, label] as const)
          .filter(([n]) => n)
          .map(([n, label]) => `${n} ${label}`);
        print(`collection  ${c.name}  (${parts.join(', ') || 'empty'})`);
      }
      for (const e of res.environments) print(`environment ${e.name}  (${e.values.length} value(s))`);
      if (res.replaced.length) print(`updated existing: ${res.replaced.join(', ')}`);
      if (res.activatedEnvironment) print(`active environment: ${res.activatedEnvironment}`);
      for (const w of res.warnings) process.stderr.write(`warning: ${w}\n`);
    }),
  );

program
  .command('export')
  .argument('<collection>', 'collection name or id')
  .argument('[dir]', 'output folder (v3: workspace root, writes <dir>/postman/collections/<name>/)', '.')
  .addOption(new Option('-f, --format <format>', 'postman-v3 (YAML, HTTP + gRPC) or postman-v2 (v2.1 JSON, HTTP only)').choices(['postman-v3', 'postman-v2', 'v3', 'v2.1']).default('postman-v3'))
  .option('--with-environments', 'also write the environments')
  .option('--replace', 'v3: delete an existing export of this collection first')
  .option('--include-secrets', 'write values of secret-typed environment variables (blanked by default)')
  .description('Export a collection as Postman v3 YAML or v2.1 JSON')
  .action((name: string, dir: string, o: { format: string; withEnvironments?: boolean; replace?: boolean; includeSecrets?: boolean }) =>
    withErrors(() => {
      const w = ws();
      const found = w.findByPath(name);
      if (!found) throw new Error(`collection "${name}" not found`);
      if (o.format === 'postman-v2' || o.format === 'v2.1') {
        const { written, skipped } = w.exportV2(found.collection.id, resolve(dir), o);
        for (const p of written) print(p);
        if (skipped.length) process.stderr.write(`warning: v2.1 has no gRPC requests; skipped ${skipped.length}: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}\n`);
        return;
      }
      for (const p of w.exportV3(found.collection.id, resolve(dir), o)) print(p);
    }),
  );

program
  .command('ls')
  .description('List collections, requests and environments')
  .action(() =>
    withErrors(() => {
      const w = ws();
      for (const c of w.collections) {
        print(c.name);
        for (const { item, ancestors } of walkItems(c.items)) {
          const indent = '  '.repeat(ancestors.length + 1);
          if (item.type === 'folder') print(`${indent}${item.name}/`);
          else if (item.type === 'grpc') print(`${indent}${item.name}  ${item.methodPath}`);
          else if (item.type === 'http') print(`${indent}${item.name}  ${item.method} ${item.url}`);
          else print(`${indent}${item.name}  (${item.kind})`);
        }
      }
      if (w.environments.length) {
        print('');
        for (const e of w.environments) print(`env: ${e.name}${e.id === w.state.activeEnvironmentId ? ' (active)' : ''}`);
      }
    }),
  );

program
  .command('env')
  .argument('[name-or-file]', 'environment name, or a *.environment.yaml file to import; "none" to deactivate')
  .description('List environments, or set the active one')
  .action((arg?: string) =>
    withErrors(() => {
      const w = ws();
      if (arg && arg !== 'none') {
        let env = w.environments.find((e) => e.name.toLowerCase() === arg.toLowerCase() || e.id === arg);
        if (!env) {
          // Accept a path to an environment file, with or without the .environment.yaml suffix.
          const file = [arg, `${arg}.environment.yaml`, `${arg}.environment.yml`].map((p) => resolve(p)).find((p) => existsSync(p) && statSync(p).isFile());
          if (file) {
            const res = w.importV3(file);
            env = w.environments.find((e) => e.name === res.environments[0]?.name);
            print(`imported environment ${env?.name} from ${file}`);
          }
        }
        if (!env) {
          const names = w.environments.map((e) => `"${e.name}"`).join(', ') || 'none imported yet';
          throw new Error(`environment "${arg}" not found (available: ${names}). Pass an environment name or a *.environment.yaml file.`);
        }
        w.setActiveEnvironment(env.id);
      } else if (arg === 'none') {
        w.setActiveEnvironment(undefined);
      }
      for (const e of w.environments) print(`${e.id === w.state.activeEnvironmentId ? '*' : ' '} ${e.name}`);
    }),
  );

program
  .command('snippet')
  .aliases(['curl', 'grpcurl'])
  .argument('<path>', '"Collection/Folder/Request" (names, case-insensitive)')
  .option('-e, --env <name>', 'environment name (defaults to the active one)')
  .description('Print the equivalent curl (HTTP) or grpcurl (gRPC) command for a saved request')
  .action((path: string, o: { env?: string }) =>
    withErrors(() => {
      const w = ws();
      const { item, loc, environment } = findSendable(w, path, o.env);
      const ctx = { collection: loc.collection, ancestors: loc.ancestors, environment, certificates: w.settings.certificates };
      if (item.type === 'http') {
        const r = resolveHttpRequest(item, ctx);
        warn(r);
        print(toCurl(r, { oauthToken: r.oauth ? cachedToken(r.oauth, w.home)?.accessToken : undefined }));
        return;
      }
      const r = resolveRequest(item, ctx);
      warn(r);
      print(toGrpcurl(r, { oauthToken: r.oauth ? cachedToken(r.oauth, w.home)?.accessToken : undefined }));
    }),
  );

function findSendable(w: Workspace, path: string, envName?: string) {
  const found = w.findByPath(path);
  if (!found?.item || (found.item.type !== 'grpc' && found.item.type !== 'http')) throw new Error(`request "${path}" not found (use ferry ls)`);
  const loc = w.locate(found.item.id)!;
  const environment = envName ? w.environments.find((e) => e.name.toLowerCase() === envName.toLowerCase()) : w.activeEnvironment;
  if (envName && !environment) throw new Error(`environment "${envName}" not found`);
  return { item: found.item, loc, environment };
}

function warn(r: { missingVars: string[]; warnings: string[] }) {
  if (r.missingVars.length) process.stderr.write(`warning: unresolved variables: ${r.missingVars.join(', ')}\n`);
  for (const w of r.warnings) process.stderr.write(`warning: ${w}\n`);
}

async function oauthToken(w: Workspace, cfg: OAuthConfig | undefined, verbose?: boolean): Promise<string | undefined> {
  if (!cfg) return undefined;
  const t = await getToken(cfg, w.home);
  if (verbose) process.stderr.write(`oauth2: ${t.fromCache ? 'cached' : 'fetched'} token from ${cfg.tokenUrl} (${describeExpiry(t)})\n`);
  return t.accessToken;
}

function reportCaptures(w: Workspace, results: ReturnType<typeof evaluateCaptures>, collectionId: string, environment?: Environment) {
  for (const c of results) {
    if (c.value === undefined) {
      process.stderr.write(`capture {{${c.variable}}} failed: ${c.error}\n`);
      continue;
    }
    const where = w.setVariable(c.variable, c.value, { collectionId, environment });
    process.stderr.write(`captured {{${c.variable}}} = ${c.value}${where ? ` (${where})` : ''}\n`);
  }
}

/** Prints script output to stderr; failed scripts or tests make the exit code 1. */
function reportScripts(outcome: ScriptOutcome | undefined, environment?: Environment) {
  if (!outcome) return;
  for (const line of outcome.logs) process.stderr.write(`script: ${line}\n`);
  const { text, ok } = summarizeOutcome(outcome, secretMask(environment));
  if (text) process.stderr.write(`${text}\n`);
  if (!ok) process.exitCode = 1;
}

type Located = NonNullable<ReturnType<Workspace['locate']>>;

/** Runs pre-request scripts; returns the environment to resolve with (including pm.variables values). */
async function preRequest(w: Workspace, req: HttpRequest | GrpcRequest, loc: Located, environment: Environment | undefined, info: Parameters<typeof runPhase>[1]['info']) {
  const outcome = await runPhase('before', { store: w, request: req, collection: loc.collection, ancestors: loc.ancestors, environment, info });
  reportScripts(outcome, environment);
  if (outcome?.error) throw new Error(`request not sent: ${outcome.error}`);
  return { ran: !!outcome, environment: withLocals(environment, outcome?.locals ?? {}) };
}

async function runHttp(
  w: Workspace,
  item: HttpRequest,
  loc: Located,
  environment: Environment | undefined,
  o: { data?: string; verbose?: boolean; output?: string; scripts?: boolean },
) {
  const req: HttpRequest = o.data ? { ...item, body: { ...item.body, type: item.body.type === 'none' ? 'json' : item.body.type, content: await readData(o.data) } } : item;
  const ctx = { collection: loc.collection, ancestors: loc.ancestors, environment, certificates: w.settings.certificates };
  let r = resolveHttpRequest(req, ctx);
  if (o.scripts !== false) {
    const pre = await preRequest(w, req, loc, environment, httpRequestInfo(req.name, r));
    if (pre.ran) r = resolveHttpRequest(req, { ...ctx, environment: pre.environment });
  }
  warn(r);
  const token = await oauthToken(w, r.oauth, o.verbose);
  if (o.verbose) {
    const hs = effectiveHttpHeaders(r, token);
    process.stderr.write(`> ${r.method} ${r.url}\n${hs.map((h) => `> ${h.key}: ${maskValue(h.key, h.value)}`).join('\n')}\n`);
  }
  const handle = sendHttp(r, undefined, { oauthToken: token });
  process.once('SIGINT', () => handle.cancel());
  const res = await handle.done;
  if (res.error) throw new Error(res.error);
  if (o.verbose) {
    process.stderr.write(`< ${res.status} ${res.statusText}\n`);
    for (const [k, v] of res.headers) process.stderr.write(`< ${k}: ${v}\n`);
    process.stderr.write(`(${res.durationMs} ms, sent ${res.requestBytes ?? 0} bytes, received ${res.body.length} bytes)\n`);
    writeTiming(res.timing);
  }
  if (o.output) {
    (await import('node:fs')).writeFileSync(o.output, res.body);
    process.stderr.write(`wrote ${res.body.length} bytes to ${o.output}\n`);
  } else {
    const json = jsonBody(res);
    if (json !== undefined) print(json);
    else if (looksBinary(res.body, res.contentType)) process.stderr.write(`binary body (${res.body.length} bytes, ${res.contentType ?? 'unknown type'}); use -o <file> to save it\n`);
    else process.stdout.write(res.body.toString('utf8') + (res.body.length && !res.body.toString('utf8').endsWith('\n') ? '\n' : ''));
  }
  const ok = res.status !== undefined && res.status < 300;
  if (o.scripts !== false && res.status !== undefined) {
    reportScripts(
      await runPhase('after', { store: w, request: req, collection: loc.collection, ancestors: loc.ancestors, environment, info: httpRequestInfo(req.name, r), response: httpResponseInfo(res) }),
      environment,
    );
  }
  // Captures read from a script that now runs itself; skip them to avoid doing it twice.
  const captures = (item.captures ?? []).filter((c) => o.scripts === false || c.source !== 'script');
  if (ok && captures.length) {
    const json = jsonBody(res);
    if (json === undefined) process.stderr.write('captures skipped: the response body is not JSON\n');
    else reportCaptures(w, evaluateHttpCaptures(captures, json), loc.collection.id, environment);
  }
  if (!ok) {
    if (!o.verbose) process.stderr.write(`${res.status} ${res.statusText}\n`);
    process.exit(res.status !== undefined && res.status >= 400 ? 1 : 0);
  }
}

program
  .command('preview')
  .argument('<path>', '"Collection/Folder/Request"')
  .option('-e, --env <name>', 'environment name (defaults to the active one)')
  .option('--reveal', 'show secret header values')
  .description('Show what a saved request will send: headers/metadata with their source, TLS, target')
  .action((path: string, o: { env?: string; reveal?: boolean }) =>
    withErrors(() => {
      const w = ws();
      const { item, loc, environment } = findSendable(w, path, o.env);
      const ctx = { collection: loc.collection, ancestors: loc.ancestors, environment, certificates: w.settings.certificates };
      const base = { request: item, ancestors: loc.ancestors, collection: loc.collection, certificates: w.settings.certificates, reveal: o.reveal };
      if (item.type === 'http') {
        const r = resolveHttpRequest(item, ctx);
        print(previewHttp(r, { ...base, oauthToken: r.oauth ? cachedToken(r.oauth, w.home)?.accessToken : undefined }));
      } else {
        const r = resolveRequest(item, ctx);
        print(previewGrpc(r, { ...base, oauthToken: r.oauth ? cachedToken(r.oauth, w.home)?.accessToken : undefined, target: parseTarget(r.url, r.settings) }));
      }
    }),
  );

const cert = program.command('cert').description('Per-host client certificates / CAs (applied to gRPC and HTTP)');
cert
  .command('ls')
  .description('List certificate rules')
  .action(() =>
    withErrors(() => {
      const certs = ws().settings.certificates;
      if (!certs.length) return void print('no certificate rules (add one with: ferry cert add <host> --cert ... --key ...)');
      for (const c of certs) print(`${c.disabled ? '○' : '●'} ${c.host.padEnd(30)} ${certSummary(c)}`);
    }),
  );
cert
  .command('add')
  .argument('<host>', 'host, host:port, or *.domain')
  .option('--ca <file>', 'CA certificate (PEM)')
  .option('--cert <file>', 'client certificate (PEM)')
  .option('--key <file>', 'client key (PEM)')
  .option('--pfx <file>', 'client PKCS#12 bundle (.p12/.pfx)')
  .option('--passphrase <value>', 'passphrase for the key or bundle ({{var}} allowed)')
  .description('Add or update the certificate rule for a host')
  .action((host: string, o: { ca?: string; cert?: string; key?: string; pfx?: string; passphrase?: string }) =>
    withErrors(() => {
      const abs = (p?: string) => (p ? resolve(p) : undefined);
      const c = ws().upsertCertificate({ host, caCert: abs(o.ca), clientCert: abs(o.cert), clientKey: abs(o.key), pfx: abs(o.pfx), passphrase: o.passphrase });
      print(`${c.host}: ${certSummary(c)}`);
    }),
  );
cert
  .command('rm')
  .argument('<host>')
  .description('Remove the certificate rule for a host')
  .action((host: string) =>
    withErrors(() => {
      if (!ws().removeCertificate(host)) throw new Error(`no certificate rule for ${host}`);
      print(`removed ${host}`);
    }),
  );

program
  .command('token')
  .argument('<action>', 'clear')
  .description('Manage cached OAuth2 tokens (clear forces the next request to fetch a new one)')
  .action((action: string) =>
    withErrors(() => {
      if (action !== 'clear') throw new Error('usage: ferry token clear');
      print(`cleared ${clearTokens(ws().home)} cached token(s)`);
    }),
  );

program
  .command('run')
  .argument('<path>', '"Collection/Folder/Request" (names, case-insensitive)')
  .option('-e, --env <name>', 'environment name (defaults to the active one)')
  .option('-d, --data <json>', 'override the saved message / body ("@file", "-" for stdin)')
  .option('-o, --output <file>', 'HTTP: write the response body to a file')
  .option('-v, --verbose', 'print request/response headers and status to stderr')
  .option('--no-scripts', "don't run pre-request / post-response scripts")
  .description('Send a saved request (HTTP or gRPC); runs its scripts and captures')
  .action((path: string, o: { env?: string; data?: string; verbose?: boolean; output?: string; scripts?: boolean }) =>
    withErrors(async () => {
      const w = ws();
      const { item, loc, environment } = findSendable(w, path, o.env);
      if (item.type === 'http') return runHttp(w, item, loc, environment, o);
      const req: GrpcRequest = { ...item, ...(o.data ? { message: await readData(o.data) } : {}) };
      const ctx = { collection: loc.collection, ancestors: loc.ancestors, environment, certificates: w.settings.certificates };
      let r = resolveRequest(req, ctx);
      if (o.scripts !== false) {
        const pre = await preRequest(w, req, loc, environment, grpcRequestInfo(req.name, r));
        if (pre.ran) r = resolveRequest(req, { ...ctx, environment: pre.environment });
      }
      warn(r);
      const token = await oauthToken(w, r.oauth, o.verbose);
      const metadata = r.oauth && token ? withToken(r.metadata, r.oauth, token, true) : r.metadata;
      const schema = await discover({ source: r.schema, url: r.url, settings: r.settings, tls: r.tls, metadata, baseDir: r.baseDir });
      const method = schema.findMethod(r.methodPath);
      if (!method) throw new Error(`method ${r.methodPath} not found on ${r.url}`);
      const captures = (item.captures ?? []).filter((c) => o.scripts === false || c.source !== 'script');
      await runCall({ url: r.url, settings: r.settings, tls: r.tls, baseDir: r.baseDir, schema, method, message: r.message, metadata, protoFieldNames: r.protoFieldNames }, !!o.verbose, async (res) => {
        if (o.scripts !== false) {
          const response = grpcResponseInfo(res);
          reportScripts(await runPhase('after', { store: w, request: req, ...ctx, info: grpcRequestInfo(req.name, r), response }), environment);
        }
        if (res.state === 'done' && captures.length) reportCaptures(w, evaluateCaptures(captures, res.messages), loc.collection.id, environment);
      });
    }),
  );

program
  .command('ui', { isDefault: true })
  .description('Open the interactive terminal UI (default)')
  .addOption(new Option('--no-alt-screen', 'render in the main terminal buffer'))
  .addOption(new Option('--no-splash', 'skip the start-up ferry'))
  .action(async (o: { altScreen: boolean; splash: boolean }) => {
    if (!process.stdin.isTTY) {
      process.stderr.write('The interactive UI needs a TTY. Use `ferry --help` for scriptable commands.\n');
      process.exit(1);
    }
    const workspace = ws();
    if (o.altScreen) process.stdout.write(ALT_SCREEN_ON);
    const restore = () => {
      if (o.altScreen) process.stdout.write(ALT_SCREEN_OFF);
    };
    process.on('exit', restore);
    const instance = render(<Root workspace={workspace} splash={o.splash} />, { exitOnCtrlC: false, patchConsole: true });
    setInkClear(() => instance.clear());
    await instance.waitUntilExit();
    restore();
    process.exit(0);
  });

await program.parseAsync();
