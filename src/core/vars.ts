import { randomUUID, randomInt } from 'node:crypto';
import type { KV } from './model.js';

/** Ordered list of scopes; later scopes win (collection < folder < environment). */
export type VarScope = { name: string; values: Array<{ key: string; value: string; disabled?: boolean; enabled?: boolean }> };

export interface Resolver {
  resolve(input: string): string;
  lookup(name: string): string | undefined;
  missing: Set<string>;
}

const DYNAMIC: Record<string, () => string> = {
  $guid: () => randomUUID(),
  $randomUUID: () => randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(randomInt(0, 1001)),
};

export function createResolver(scopes: VarScope[]): Resolver {
  const table = new Map<string, string>();
  for (const scope of scopes) {
    for (const v of scope.values) {
      if (v.disabled || v.enabled === false || !v.key) continue;
      table.set(v.key, v.value);
    }
  }
  const missing = new Set<string>();

  const lookup = (name: string): string | undefined => {
    if (table.has(name)) return table.get(name);
    const dyn = DYNAMIC[name];
    return dyn ? dyn() : undefined;
  };

  const resolve = (input: string, depth = 0): string =>
    input.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, name: string) => {
      const value = lookup(name);
      if (value === undefined) {
        missing.add(name);
        return match;
      }
      // Allow variables that reference other variables, with a recursion guard.
      return depth < 5 && value.includes('{{') ? resolve(value, depth + 1) : value;
    });

  return { resolve: (s) => resolve(s), lookup, missing };
}

export function resolveKVs(kvs: KV[], resolver: Resolver): Array<{ key: string; value: string }> {
  return kvs
    .filter((kv) => !kv.disabled && kv.key)
    .map((kv) => ({ key: resolver.resolve(kv.key), value: resolver.resolve(kv.value) }));
}

/** Variable names referenced in a string, for highlighting. */
export function referencedVars(input: string): string[] {
  return [...input.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1]!);
}
