import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type CertificateEntry,
  type Collection,
  type Environment,
  type Folder,
  type Item,
  type SendableRequest,
  clone,
  findItem,
  newCollection,
  newFolder,
  newId,
  renumber,
  sortItems,
  walkItems,
} from './model.js';
import { referencedVars } from './vars.js';
import { type AnyImportResult, importAny } from './importers.js';
import { exportPostmanV2Collection, exportPostmanV2Environment } from './postman-v2.js';
import { collectionExportDir, exportCollectionV3, exportEnvironmentV3 } from './postman-v3.js';

/** Workspace-wide settings (settings.json). */
export interface Settings {
  certificates: CertificateEntry[];
}

export interface AppState {
  activeEnvironmentId?: string;
  lastRequestId?: string;
  expanded?: string[];
  /** request/response arrangement in the UI */
  layout?: 'stacked' | 'side-by-side';
  sidebarHidden?: boolean;
  /** open request tabs (saved requests only; scratch tabs are not persisted) */
  openTabs?: string[];
}

export function defaultHome(): string {
  return process.env.FERRY_HOME ?? process.env.GRPC_CLIENT_HOME ?? join(homedir(), '.ferry');
}

/**
 * One-time move of the data directory from the app's old name
 * (~/.grpc-client) to ~/.ferry. Returns the old path when it moved.
 */
export function migrateLegacyHome(): string | undefined {
  if (process.env.FERRY_HOME || process.env.GRPC_CLIENT_HOME) return undefined;
  const legacy = join(homedir(), '.grpc-client');
  const current = join(homedir(), '.ferry');
  if (!existsSync(legacy) || existsSync(current)) return undefined;
  try {
    renameSync(legacy, current);
    return legacy;
  } catch {
    return undefined;
  }
}

/**
 * On-disk store: one JSON file per collection and per environment.
 *
 *   ~/.ferry/
 *     collections/<id>.json
 *     environments/<id>.json
 *     state.json
 */
export class Workspace {
  collections: Collection[] = [];
  environments: Environment[] = [];
  state: AppState = {};
  settings: Settings = { certificates: [] };
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(readonly home: string = defaultHome()) {
    mkdirSync(join(home, 'collections'), { recursive: true });
    mkdirSync(join(home, 'environments'), { recursive: true });
    this.collections = this.readAll<Collection>('collections').sort((a, b) => a.name.localeCompare(b.name));
    this.environments = this.readAll<Environment>('environments').sort((a, b) => a.name.localeCompare(b.name));
    const settingsPath = join(home, 'settings.json');
    if (existsSync(settingsPath)) {
      try {
        this.settings = { certificates: [], ...JSON.parse(readFileSync(settingsPath, 'utf8')) };
      } catch {
        this.settings = { certificates: [] };
      }
    }
    const statePath = join(home, 'state.json');
    if (existsSync(statePath)) {
      try {
        this.state = JSON.parse(readFileSync(statePath, 'utf8'));
      } catch {
        this.state = {};
      }
    }
  }

  // --- change notification (for useSyncExternalStore) ---------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // --- persistence ---------------------------------------------------------

  private readAll<T>(dir: string): T[] {
    const full = join(this.home, dir);
    return readdirSync(full)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(full, f), 'utf8')) as T];
        } catch {
          return [];
        }
      });
  }

  private write(dir: string, id: string, value: unknown): void {
    const file = join(this.home, dir, `${id}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  }

  saveCollection(c: Collection): void {
    this.write('collections', c.id, c);
    this.changed();
  }

  saveEnvironment(e: Environment): void {
    this.write('environments', e.id, e);
    this.changed();
  }

  saveSettings(): void {
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    this.changed();
  }

  upsertCertificate(entry: Omit<CertificateEntry, 'id'> & { id?: string }): CertificateEntry {
    const existing = entry.id ? this.settings.certificates.find((c) => c.id === entry.id) : this.settings.certificates.find((c) => c.host === entry.host);
    const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== '')) as unknown as CertificateEntry;
    if (existing) Object.assign(existing, clean, { id: existing.id });
    else this.settings.certificates.push({ ...clean, id: newId() });
    this.saveSettings();
    return existing ?? this.settings.certificates.at(-1)!;
  }

  removeCertificate(idOrHost: string): boolean {
    const before = this.settings.certificates.length;
    this.settings.certificates = this.settings.certificates.filter((c) => c.id !== idOrHost && c.host !== idOrHost);
    this.saveSettings();
    return this.settings.certificates.length < before;
  }

  saveState(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    writeFileSync(join(this.home, 'state.json'), JSON.stringify(this.state, null, 2));
    this.changed();
  }

  // --- lookups ---------------------------------------------------------------

  get activeEnvironment(): Environment | undefined {
    return this.environments.find((e) => e.id === this.state.activeEnvironmentId);
  }

  collection(id: string): Collection | undefined {
    return this.collections.find((c) => c.id === id);
  }

  /** Locates a request or folder anywhere in the workspace. */
  locate(itemId: string): { collection: Collection; item: Item; parent: Item[]; ancestors: Folder[] } | undefined {
    for (const collection of this.collections) {
      const found = findItem(collection, itemId);
      if (found) return { collection, ...found };
    }
    return undefined;
  }

  /**
   * Finds a collection by name or id, and optionally a request by slash-separated
   * path. Names may themselves contain "/" (Bruno's "tax_type/{uuid}"), so each
   * level tries the longest run of segments first.
   */
  findByPath(path: string): { collection: Collection; item?: Item } | undefined {
    const segments = path.split('/');
    const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    for (let k = segments.length; k >= 1; k--) {
      const colName = segments.slice(0, k).join('/');
      const collection = this.collections.find((c) => c.id === colName || eq(c.name, colName));
      if (!collection) continue;
      const rest = segments.slice(k);
      if (!rest.length) return { collection };
      const search = (items: Item[], rest: string[]): Item | undefined => {
        for (let n = rest.length; n >= 1; n--) {
          const name = rest.slice(0, n).join('/');
          for (const item of items.filter((i) => i.id === name || eq(i.name, name))) {
            if (n === rest.length) return item;
            if (item.type === 'folder') {
              const found = search(item.items, rest.slice(n));
              if (found) return found;
            }
          }
        }
        return undefined;
      };
      const item = search(collection.items, rest);
      if (item) return { collection, item };
    }
    return undefined;
  }

  // --- mutations ---------------------------------------------------------------

  createCollection(name: string): Collection {
    const c = newCollection(name);
    this.collections.push(c);
    this.collections.sort((a, b) => a.name.localeCompare(b.name));
    this.saveCollection(c);
    return c;
  }

  deleteCollection(id: string): void {
    this.collections = this.collections.filter((c) => c.id !== id);
    rmSync(join(this.home, 'collections', `${id}.json`), { force: true });
    this.changed();
  }

  /** Adds an item to a collection root or a folder (parentId = collection or folder id). */
  addItem(collectionId: string, parentId: string | undefined, item: Item): void {
    const collection = this.collection(collectionId);
    if (!collection) throw new Error('collection not found');
    const parent = parentId && parentId !== collectionId ? findItem(collection, parentId)?.item : undefined;
    const items = parent?.type === 'folder' ? parent.items : collection.items;
    const maxOrder = Math.max(0, ...items.map((i) => i.order ?? 0));
    item.order ??= maxOrder + 1000;
    items.push(item);
    this.saveCollection(collection);
  }

  addFolder(collectionId: string, parentId: string | undefined, name: string): Folder {
    const folder = newFolder(name);
    this.addItem(collectionId, parentId, folder);
    return folder;
  }

  /** Replaces a request with an edited copy (by id). */
  updateRequest(request: SendableRequest): void {
    const loc = this.locate(request.id);
    if (!loc) throw new Error('request not found');
    const index = loc.parent.indexOf(loc.item);
    loc.parent[index] = clone(request);
    this.saveCollection(loc.collection);
  }

  renameItem(itemId: string, name: string): void {
    const collection = this.collection(itemId);
    if (collection) {
      collection.name = name;
      this.saveCollection(collection);
      return;
    }
    const loc = this.locate(itemId);
    if (!loc) return;
    loc.item.name = name;
    this.saveCollection(loc.collection);
  }

  deleteItem(itemId: string): void {
    const loc = this.locate(itemId);
    if (!loc) return;
    loc.parent.splice(loc.parent.indexOf(loc.item), 1);
    this.saveCollection(loc.collection);
  }

  duplicateItem(itemId: string): Item | undefined {
    const loc = this.locate(itemId);
    if (!loc) return undefined;
    const copy = reId(clone(loc.item));
    copy.name = `${loc.item.name} copy`;
    const sorted = sortItems(loc.parent);
    const at = sorted.indexOf(loc.item);
    sorted.splice(at + 1, 0, copy);
    renumber(sorted);
    loc.parent.splice(0, loc.parent.length, ...sorted);
    this.saveCollection(loc.collection);
    return copy;
  }

  moveItem(itemId: string, delta: -1 | 1): void {
    const loc = this.locate(itemId);
    if (!loc) return;
    const sorted = sortItems(loc.parent);
    const i = sorted.indexOf(loc.item);
    const j = i + delta;
    if (j < 0 || j >= sorted.length) return;
    [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
    renumber(sorted);
    loc.parent.splice(0, loc.parent.length, ...sorted);
    this.saveCollection(loc.collection);
  }

  createEnvironment(name: string): Environment {
    const env: Environment = { id: newId(), name, values: [] };
    this.environments.push(env);
    this.environments.sort((a, b) => a.name.localeCompare(b.name));
    this.saveEnvironment(env);
    return env;
  }

  deleteEnvironment(id: string): void {
    this.environments = this.environments.filter((e) => e.id !== id);
    rmSync(join(this.home, 'environments', `${id}.json`), { force: true });
    if (this.state.activeEnvironmentId === id) this.saveState({ activeEnvironmentId: undefined });
    else this.changed();
  }

  /**
   * Sets a variable in `environment` (default: the active one), falling back
   * to the collection's variables. Returns a description of where it went.
   */
  setVariable(name: string, value: string, opts: { collectionId?: string; environment?: Environment } = {}): string | undefined {
    const upsert = <T extends { key: string; value: string }>(list: T[], make: () => T) => {
      const existing = list.find((v) => v.key === name);
      if (existing) {
        existing.value = value;
        if ('disabled' in existing) delete (existing as { disabled?: boolean }).disabled;
        if ('enabled' in existing) (existing as { enabled?: boolean }).enabled = true;
      } else list.push(make());
    };
    const env = opts.environment ?? this.activeEnvironment;
    if (env) {
      upsert(env.values, () => ({ key: name, value, enabled: true, type: 'default' }));
      this.saveEnvironment(env);
      return `environment "${env.name}"`;
    }
    const c = opts.collectionId ? this.collection(opts.collectionId) : undefined;
    if (c) {
      upsert(c.variables, () => ({ key: name, value }));
      this.saveCollection(c);
      return `collection "${c.name}"`;
    }
    return undefined;
  }

  setActiveEnvironment(id: string | undefined): void {
    this.saveState({ activeEnvironmentId: id });
  }

  // --- import / export ---------------------------------------------------------

  /**
   * Imports a v3 collection tree. Collections/environments with the same name
   * are replaced (keeping their ids) so re-importing a git checkout updates in place.
   */
  /** @deprecated use importPath */
  importV3(path: string): AnyImportResult & { replaced: string[]; activatedEnvironment?: string } {
    return this.importPath(path);
  }

  /**
   * Imports any supported format (Postman v2.1/v3, Bruno .bru/YAML). Collections
   * and environments with the same name are replaced (keeping their ids) so
   * re-importing a checkout updates in place.
   */
  importPath(path: string): AnyImportResult & { replaced: string[]; activatedEnvironment?: string } {
    const result = importAny(path);
    const replaced: string[] = [];
    for (const c of result.collections) {
      const existing = this.collections.find((x) => x.name === c.name);
      if (existing) {
        c.id = existing.id;
        c.schema ??= existing.schema;
        c.tls ??= existing.tls;
        replaced.push(c.name);
        this.collections[this.collections.indexOf(existing)] = c;
      } else {
        this.collections.push(c);
      }
      this.write('collections', c.id, c);
    }
    for (const e of result.environments) {
      const existing = this.environments.find((x) => x.name === e.name);
      if (existing) {
        e.id = existing.id;
        replaced.push(`${e.name} (environment)`);
        this.environments[this.environments.indexOf(existing)] = e;
      } else {
        this.environments.push(e);
      }
      this.write('environments', e.id, e);
    }
    this.collections.sort((a, b) => a.name.localeCompare(b.name));
    this.environments.sort((a, b) => a.name.localeCompare(b.name));

    // Collections usually ship with the environment that defines their {{vars}};
    // switch to it unless the active environment already covers them.
    let activatedEnvironment: string | undefined;
    const needed = new Set(result.collections.flatMap((c) => environmentVars(c)));
    if (needed.size && result.environments.length) {
      const coverage = (e?: Environment) => (e ? e.values.filter((v) => v.enabled !== false && needed.has(v.key)).length : 0);
      const best = [...result.environments].sort((a, b) => coverage(b) - coverage(a))[0]!;
      if (coverage(best) > coverage(this.activeEnvironment)) {
        this.state = { ...this.state, activeEnvironmentId: best.id };
        writeFileSync(join(this.home, 'state.json'), JSON.stringify(this.state, null, 2));
        activatedEnvironment = best.name;
      }
    }
    this.changed();
    return { ...result, replaced, activatedEnvironment };
  }

  /** Postman v2.1 JSON export (HTTP requests only). */
  exportV2(collectionId: string, dir: string, opts: { withEnvironments?: boolean; includeSecrets?: boolean } = {}): { written: string[]; skipped: string[] } {
    const c = this.collection(collectionId);
    if (!c) throw new Error('collection not found');
    const { file, skipped } = exportPostmanV2Collection(c, dir);
    const written = [file];
    if (opts.withEnvironments) for (const e of this.environments) written.push(exportPostmanV2Environment(e, dir, opts.includeSecrets));
    return { written, skipped };
  }

  exportDir(collectionId: string, root: string): string {
    const c = this.collection(collectionId);
    if (!c) throw new Error('collection not found');
    return collectionExportDir(c, root);
  }

  /** `replace` removes an existing export first so deleted requests don't linger. */
  exportV3(collectionId: string, root: string, opts: { withEnvironments?: boolean; replace?: boolean; includeSecrets?: boolean } = {}): string[] {
    const c = this.collection(collectionId);
    if (!c) throw new Error('collection not found');
    if (opts.replace) rmSync(collectionExportDir(c, root), { recursive: true, force: true });
    const written = [exportCollectionV3(c, root)];
    if (opts.withEnvironments) for (const e of this.environments) written.push(exportEnvironmentV3(e, root, opts.includeSecrets));
    return written;
  }
}

/** {{vars}} a collection references that its own (and its folders') variables don't define. */
export function environmentVars(c: Collection): string[] {
  const defined = new Set(c.variables.map((v) => v.key));
  const used = new Set<string>();
  for (const { item } of walkItems(c.items)) {
    if (item.type === 'folder') {
      item.variables?.forEach((v) => defined.add(v.key));
      for (const cred of item.auth?.credentials ?? []) for (const n of referencedVars(cred.value)) used.add(n);
    }
    let texts: string[];
    if (item.type === 'grpc') texts = [item.url, item.methodPath, item.message, ...item.metadata.flatMap((m) => [m.key, m.value])];
    else if (item.type === 'http') {
      texts = [
        item.url,
        ...[...item.headers, ...item.queryParams, ...item.pathVariables].flatMap((m) => [m.key, m.value]),
        item.body.content ?? '',
        ...(item.body.fields ?? []).flatMap((f) => [f.key, f.value]),
      ];
    } else continue;
    texts.push(...(item.auth?.credentials ?? []).map((c) => c.value));
    for (const t of texts) for (const name of referencedVars(t)) if (!name.startsWith('$')) used.add(name);
  }
  for (const a of [c.auth]) for (const cred of a?.credentials ?? []) for (const n of referencedVars(cred.value)) used.add(n);
  return [...used].filter((n) => !defined.has(n));
}

function reId<T extends Item>(item: T): T {
  item.id = newId();
  if (item.type === 'folder') item.items.forEach(reId);
  return item;
}
