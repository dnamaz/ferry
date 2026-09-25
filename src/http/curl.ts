import type { ResolvedHttpRequest } from '../core/resolve.js';
import { shellQuote } from '../grpc/grpcurl.js';

/**
 * Builds an equivalent curl command, one option per line. An OAuth2 token is
 * inlined when given, else referenced as $OAUTH_TOKEN.
 */
export function toCurl(r: ResolvedHttpRequest, options: { oauthToken?: string } = {}): string {
  const opts: string[][] = [];
  const opt = (...parts: string[]) => opts.push(parts);
  const s = r.settings;

  if (r.method !== 'GET') opt('-X', r.method);
  if (s.followRedirects !== false) opt('-L');
  if (s.maxRedirects !== undefined) opt('--max-redirs', String(s.maxRedirects));
  if (s.strictSSL === false) opt('-k');
  if (s.timeout) opt('--max-time', String(s.timeout / 1000));
  const t = r.tls ?? {};
  if (t.caCert) opt('--cacert', shellQuote(t.caCert));
  if (t.pfx) {
    opt('--cert-type', 'P12');
    opt('--cert', shellQuote(t.passphrase ? `${t.pfx}:${t.passphrase}` : t.pfx));
  } else {
    if (t.clientCert) opt('--cert', shellQuote(t.clientCert));
    if (t.clientKey) opt('--key', shellQuote(t.clientKey));
    if (t.passphrase) opt('--pass', shellQuote(t.passphrase));
  }
  for (const h of r.headerSources ?? r.headers.map((x) => ({ ...x, source: 'request' as const }))) {
    const value = h.value.endsWith('<fetched at send time>') ? `${r.oauth?.headerPrefix ?? 'Bearer'} ${options.oauthToken ?? '$OAUTH_TOKEN'}` : h.value;
    // $OAUTH_TOKEN must expand, so that header uses double quotes.
    if (value.includes('$OAUTH_TOKEN')) opt('-H', `"${h.key}: ${value}"`);
    else opt('-H', shellQuote(`${h.key}: ${value}`));
  }

  const b = r.body;
  const hasCT = r.headers.some((h) => h.key.toLowerCase() === 'content-type');
  const ct = (v: string) => !hasCT && opt('-H', shellQuote(`Content-Type: ${v}`));
  switch (b.type) {
    case 'json':
    case 'text':
    case 'xml':
    case 'html':
    case 'javascript': {
      const types = { json: 'application/json', text: 'text/plain', xml: 'application/xml', html: 'text/html', javascript: 'application/javascript' };
      ct(types[b.type]);
      if (b.content) opt('--data-raw', shellQuote(b.content));
      break;
    }
    case 'graphql': {
      ct('application/json');
      let variables: unknown;
      try {
        variables = b.variables?.trim() ? JSON.parse(b.variables) : undefined;
      } catch {
        variables = b.variables;
      }
      opt('--data-raw', shellQuote(JSON.stringify({ query: b.content ?? '', ...(variables === undefined ? {} : { variables }) })));
      break;
    }
    case 'urlencoded':
      for (const f of b.fields ?? []) if (!f.disabled && f.key) opt('--data-urlencode', shellQuote(`${f.key}=${f.value}`));
      break;
    case 'formdata':
      for (const f of b.fields ?? []) if (!f.disabled && f.key) opt('-F', shellQuote(f.type === 'file' ? `${f.key}=@${f.value}` : `${f.key}=${f.value}`));
      break;
    case 'file':
      if (b.content) opt('--data-binary', shellQuote(`@${b.content}`));
      break;
    case 'none':
      break;
  }

  const lines = [`curl ${shellQuote(r.url)}`, ...opts.map((o) => `  ${o.join(' ')}`)];
  return lines.join(' \\\n');
}
