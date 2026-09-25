import type { GrpcSettings, SchemaSource, TlsFiles } from '../core/model.js';
import { createClient, toMetadata } from './connection.js';
import { loadProtoFiles, loadProtosets } from './proto-files.js';
import { reflect } from './reflection.js';
import { Schema } from './schema.js';
import { explainTlsError } from '../core/tls.js';

export interface DiscoverOptions {
  source: SchemaSource;
  url: string;
  settings?: GrpcSettings;
  tls?: TlsFiles;
  metadata?: Array<{ key: string; value: string }>;
  /** base directory for relative proto paths */
  baseDir?: string;
}

const cache = new Map<string, Promise<Schema>>();

export function cacheKey(o: DiscoverOptions): string {
  if (o.source.type === 'reflection') {
    return JSON.stringify(['r', o.url, o.settings?.secureConnection ?? false, o.settings?.serverName ?? '', o.tls ?? {}]);
  }
  return JSON.stringify([o.source, o.baseDir]);
}

/** Loads (and caches) the schema for a request. Pass `refresh` to bypass the cache. */
export function discover(opts: DiscoverOptions, refresh = false): Promise<Schema> {
  const key = cacheKey(opts);
  if (!refresh && cache.has(key)) return cache.get(key)!;
  const promise = load(opts);
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}

async function load(opts: DiscoverOptions): Promise<Schema> {
  const { source } = opts;
  switch (source.type) {
    case 'proto':
      return new Schema(await loadProtoFiles(source.files, source.importPaths, opts.baseDir));
    case 'protoset':
      return new Schema(loadProtosets(source.files, opts.baseDir));
    case 'reflection': {
      const client = createClient(opts.url, opts.settings, opts.tls, opts.baseDir);
      try {
        const { files, services } = await reflect(client, toMetadata(opts.metadata ?? []));
        return new Schema(files, services);
      } catch (err) {
        throw new Error(explainTlsError((err as Error).message));
      } finally {
        client.close();
      }
    }
  }
}

export function clearDiscoveryCache(): void {
  cache.clear();
}
