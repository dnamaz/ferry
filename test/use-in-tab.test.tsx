import React from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as grpc from '@grpc/grpc-js';
import { render } from 'ink-testing-library';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDemoServer } from '../examples/server/server.js';
import { walkItems } from '../src/core/model.js';
import { Workspace } from '../src/core/workspace.js';
import { App } from '../src/ui/App.js';

let server: grpc.Server;
let port: number;
let home: string;
beforeAll(async () => ({ server, port } = await startDemoServer(0)));
afterAll(() => {
  server?.forceShutdown();
  if (home) rmSync(home, { recursive: true, force: true });
});

it('fills other matching fields of the target request from the same response', async () => {
  home = mkdtempSync(join(tmpdir(), 'ferry-use-'));
  const ws = new Workspace(home);
  ws.importPath(join(import.meta.dirname, '..', 'examples'));
  const env = ws.environments.find((e) => e.name === 'Local')!;
  ws.setVariable('host', `localhost:${port}`, { environment: env });
  const find = (n: string) => [...walkItems(ws.collections[0]!.items)].find((x) => x.item.name === n)!.item;
  const source = find('Get item');
  const target = find('Update quantity');
  ws.saveState({ activeEnvironmentId: env.id, openTabs: [source.id, target.id], lastRequestId: source.id, layout: 'side-by-side' });

  const app = render(<App workspace={ws} />);
  const until = async (text: string) => {
    for (let i = 0; i < 100 && !app.lastFrame()?.includes(text); i++) await new Promise((r) => setTimeout(r, 30));
    expect(app.lastFrame()).toContain(text);
  };
  const keys = async (...ks: string[]) => {
    for (const k of ks) {
      app.stdin.write(k);
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  await until('Get item');
  await keys('\x12'); // ctrl+r
  await until('OK (0)');
  await keys('\t', '\t', '\r', 'u'); // response pane → select the first value (sku) → use in another request
  await until('Set which field of "Update quantity"');
  await keys('\r'); // item.sku is preselected
  await until('[x] item.sku ← [0].sku');
  expect(app.lastFrame()).toContain('[ ] item.quantity ← [0].quantity  = 42  (now "12")'); // has a value already: not ticked
  await keys('\u001B[B', ' ', '\r'); // tick quantity too
  await until('"quantity": "42"');
  expect(app.lastFrame()).toContain('"sku": "SKU-001"');
  app.unmount();
}, 20_000);
