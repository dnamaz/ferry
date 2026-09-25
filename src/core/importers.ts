/**
 * One entry point for every supported collection format. Detects the format
 * from the path and its contents:
 *
 *   Postman v3 YAML       postman/collections/**, *.request.yaml, *.environment.yaml
 *   Postman v2.x JSON     *.postman_collection.json, *.postman_environment.json
 *   Bruno .bru            a folder with bruno.json
 *   Bruno OpenCollection  a folder with opencollection.yml
 *   Bruno env JSON        { name, variables: [...] }
 *
 * A folder that is none of these is scanned (up to three levels), so pointing at
 * e.g. a repo's `postman/` directory imports everything inside it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  brunoEnvironmentJson,
  bruEnvironment,
  importBruCollection,
  importOpenCollection,
  isBruCollection,
  isBrunoEnvironmentJson,
  isOpenCollection,
  ocEnvironment,
} from './bruno.js';
import type { Collection, Environment } from './model.js';
import { importPostmanV2Collection, importPostmanV2Environment, isPostmanV2Collection, isPostmanV2Environment } from './postman-v2.js';
import { type ImportResult, importV3 } from './postman-v3.js';

export type ImportFormat = 'postman-v3' | 'postman-v2' | 'bruno' | 'opencollection';

export interface AnyImportResult extends ImportResult {
  formats: ImportFormat[];
}

const FORMAT_LABEL: Record<ImportFormat, string> = {
  'postman-v3': 'Postman v3',
  'postman-v2': 'Postman v2',
  bruno: 'Bruno',
  opencollection: 'Bruno YAML',
};

function looksLikeV3(dir: string): boolean {
  if (existsSync(join(dir, 'postman', 'collections')) || existsSync(join(dir, 'postman', 'environments'))) return true;
  if (['postman', 'collections'].includes(basename(dir)) && readdirSync(dir).some((e) => statSync(join(dir, e)).isDirectory() && existsSync(join(dir, e, '.resources')))) return true;
  if (existsSync(join(dir, '.resources'))) return true;
  return readdirSync(dir).some((f) => /\.(request|environment)\.ya?ml$/i.test(f));
}

function findUp(start: string, test: (dir: string) => boolean): string | undefined {
  for (let d = start; ; d = dirname(d)) {
    if (test(d)) return d;
    if (dirname(d) === d) return undefined;
  }
}

export function importAny(path: string): AnyImportResult {
  if (!existsSync(path)) throw new Error(`Path not found: ${path}`);
  const out: AnyImportResult = { collections: [], environments: [], warnings: [], formats: [] };
  const origin = new Map<Collection, ImportFormat>();
  const envOrigin = new Map<Environment, ImportFormat>();
  const add = (format: ImportFormat, collections: Collection[], environments: Environment[], warnings: string[] = []) => {
    for (const c of collections) origin.set(c, format);
    for (const e of environments) envOrigin.set(e, format);
    out.collections.push(...collections);
    out.environments.push(...environments);
    out.warnings.push(...warnings);
    if ((collections.length || environments.length) && !out.formats.includes(format)) out.formats.push(format);
  };
  const addV3 = (p: string) => {
    const r = importV3(p);
    add('postman-v3', r.collections, r.environments, r.warnings);
  };
  const addBru = (dir: string) => {
    const warnings: string[] = [];
    const r = importBruCollection(dir, warnings);
    add('bruno', [r.collection], r.environments, warnings);
  };
  const addOC = (dir: string) => {
    const warnings: string[] = [];
    const r = importOpenCollection(dir, warnings);
    add('opencollection', [r.collection], r.environments, warnings);
  };
  const addJson = (file: string, strict: boolean) => {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      if (strict) throw new Error(`${file}: not valid JSON (${(err as Error).message})`);
      return;
    }
    const warnings: string[] = [];
    if (isPostmanV2Collection(doc)) add('postman-v2', [importPostmanV2Collection(doc, dirname(file), warnings)], [], warnings);
    else if (isPostmanV2Environment(doc)) add('postman-v2', [], [importPostmanV2Environment(doc)]);
    else if (isBrunoEnvironmentJson(doc)) add('bruno', [], [brunoEnvironmentJson(doc)]);
    else if (strict) throw new Error(`${file}: not a Postman collection/environment or Bruno environment`);
  };

  if (statSync(path).isFile()) {
    const base = basename(path);
    if (/\.json$/i.test(base)) addJson(path, true);
    else if (/\.bru$/i.test(base)) {
      if (basename(dirname(path)) === 'environments') add('bruno', [], [bruEnvironment(path)]);
      else {
        const root = findUp(dirname(path), isBruCollection);
        if (!root) throw new Error(`${path}: no bruno.json found in any parent folder`);
        addBru(root);
      }
    } else if (/^opencollection\.ya?ml$/i.test(base)) addOC(dirname(path));
    else if (/\.ya?ml$/i.test(base) && basename(dirname(path)) === 'environments' && isOpenCollection(dirname(dirname(path)))) {
      add('opencollection', [], [ocEnvironment(path)]);
    } else addV3(path);
  } else if (isBruCollection(path)) addBru(path);
  else if (isOpenCollection(path)) addOC(path);
  else if (looksLikeV3(path)) addV3(path);
  else {
    // A plain folder: import whatever it holds, a few levels deep.
    const scan = (dir: string, depth: number) => {
      for (const entry of readdirSync(dir).sort()) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry.startsWith('.') || entry === 'node_modules') continue;
          if (isBruCollection(full)) addBru(full);
          else if (isOpenCollection(full)) addOC(full);
          else if (looksLikeV3(full)) addV3(full);
          else if (depth > 1) scan(full, depth - 1);
        } else if (/\.json$/i.test(entry)) addJson(full, false);
      }
    };
    scan(path, 3);
    if (!out.collections.length && !out.environments.length) {
      throw new Error(`No Postman (v2.1 JSON or v3 YAML) or Bruno collections found under ${path}`);
    }
  }

  // The same collection often ships in several formats (e.g. Postman and Bruno);
  // keep them apart by labelling duplicates with their format.
  const byName = new Map<string, Collection[]>();
  for (const c of out.collections) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const c of group.slice(1)) c.name = `${c.name} (${FORMAT_LABEL[origin.get(c)!]})`;
  }
  // Environments: drop exact duplicates, label same-named ones by format.
  const signature = (e: Environment) => JSON.stringify(e.values.map((v) => [v.key, v.value, v.enabled !== false]).sort());
  const kept: Environment[] = [];
  for (const e of out.environments) {
    const same = kept.filter((k) => k.name === e.name);
    if (same.some((k) => signature(k) === signature(e))) continue;
    if (same.length) e.name = `${e.name} (${FORMAT_LABEL[envOrigin.get(e)!]})`;
    kept.push(e);
  }
  out.environments = kept;
  return out;
}
