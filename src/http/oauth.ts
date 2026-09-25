/**
 * OAuth 2.0 client-credentials tokens: fetched from the token URL on first
 * use, cached in <home>/tokens.json (mode 600) until shortly before they
 * expire, and shared by HTTP and gRPC requests.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetch } from 'undici';
import type { OAuthConfig } from '../core/resolve.js';

export interface OAuthToken {
  accessToken: string;
  tokenType?: string;
  /** epoch ms; undefined when the server didn't say */
  expiresAt?: number;
  fetchedAt: number;
}

/** Refresh this long before expiry. */
const SKEW_MS = 30_000;

function cacheFile(home: string): string {
  return join(home, 'tokens.json');
}

/** Tokens for the same endpoint, client and scope share a cache entry (the secret is only hashed in). */
export function tokenKey(cfg: OAuthConfig): string {
  return createHash('sha256')
    .update(JSON.stringify([cfg.tokenUrl, cfg.clientId, cfg.clientSecret, cfg.scope ?? '', cfg.audience ?? '', cfg.clientAuth]))
    .digest('hex')
    .slice(0, 32);
}

function readCache(home: string): Record<string, OAuthToken> {
  try {
    return existsSync(cacheFile(home)) ? JSON.parse(readFileSync(cacheFile(home), 'utf8')) : {};
  } catch {
    return {};
  }
}

function writeCache(home: string, cache: Record<string, OAuthToken>): void {
  writeFileSync(cacheFile(home), JSON.stringify(cache, null, 2), { mode: 0o600 });
  chmodSync(cacheFile(home), 0o600);
}

export function cachedToken(cfg: OAuthConfig, home: string): OAuthToken | undefined {
  const t = readCache(home)[tokenKey(cfg)];
  if (!t) return undefined;
  if (t.expiresAt !== undefined && t.expiresAt - SKEW_MS <= Date.now()) return undefined;
  return t;
}

export function clearTokens(home: string): number {
  const n = Object.keys(readCache(home)).length;
  writeCache(home, {});
  return n;
}

/** Requests a new token (client_credentials grant). */
export async function fetchToken(cfg: OAuthConfig, timeoutMs = 15_000): Promise<OAuthToken> {
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (cfg.scope) form.set('scope', cfg.scope);
  if (cfg.audience) form.set('audience', cfg.audience);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'ferry' };
  if (cfg.clientAuth === 'header') {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64')}`;
  } else {
    form.set('client_id', cfg.clientId);
    form.set('client_secret', cfg.clientSecret);
  }
  let res;
  try {
    res = await fetch(cfg.tokenUrl, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const cause = (err as Error & { cause?: Error }).cause;
    throw new Error(`OAuth2 token request to ${cfg.tokenUrl} failed: ${cause?.message ?? (err as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    // some servers answer form-encoded
    body = Object.fromEntries(new URLSearchParams(text));
  }
  if (!res.ok) {
    const detail = body.error_description ?? body.error ?? text.slice(0, 200);
    throw new Error(`OAuth2 token request to ${cfg.tokenUrl} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  const accessToken = typeof body.access_token === 'string' ? body.access_token : undefined;
  if (!accessToken) throw new Error(`OAuth2 token response from ${cfg.tokenUrl} has no access_token`);
  const expiresIn = Number(body.expires_in);
  const now = Date.now();
  return {
    accessToken,
    tokenType: typeof body.token_type === 'string' ? body.token_type : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    fetchedAt: now,
  };
}

/** Cached token if still valid, else a freshly fetched (and cached) one. */
export async function getToken(cfg: OAuthConfig, home: string, opts: { force?: boolean } = {}): Promise<OAuthToken & { fromCache: boolean }> {
  if (!opts.force) {
    const hit = cachedToken(cfg, home);
    if (hit) return { ...hit, fromCache: true };
  }
  const token = await fetchToken(cfg);
  const cache = readCache(home);
  // Drop expired entries while we're here.
  for (const [k, t] of Object.entries(cache)) if (t.expiresAt !== undefined && t.expiresAt <= Date.now()) delete cache[k];
  cache[tokenKey(cfg)] = token;
  writeCache(home, cache);
  return { ...token, fromCache: false };
}

/** Adds the token's Authorization header unless the request set one explicitly. */
export function withToken<T extends { key: string; value: string }>(headers: T[], cfg: OAuthConfig, token: string, lower = false): Array<{ key: string; value: string }> {
  const key = lower ? 'authorization' : 'Authorization';
  if (headers.some((h) => h.key.toLowerCase() === 'authorization')) return headers;
  return [{ key, value: `${cfg.headerPrefix} ${token}` }, ...headers];
}

export function describeExpiry(t: OAuthToken): string {
  if (!t.expiresAt) return 'no expiry given';
  const s = Math.round((t.expiresAt - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  return s >= 3600 ? `expires in ${Math.round(s / 360) / 10} h` : s >= 60 ? `expires in ${Math.round(s / 60)} min` : `expires in ${s} s`;
}
