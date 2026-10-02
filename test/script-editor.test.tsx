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

it('edits, checks and test-runs a script in place', async () => {
  home = mkdtempSync(join(tmpdir(), 'ferry-script-'));
  const ws = new Workspace(home);
  ws.importPath(join(import.meta.dirname, '..', 'examples'));
  const env = ws.environments.find((e) => e.name === 'Local')!;
  ws.setVariable('host', `localhost:${port}`, { environment: env });
  const item = [...walkItems(ws.collections[0]!.items)].find((x) => x.item.name === 'Say hello')!.item;
  ws.saveState({ activeEnvironmentId: env.id, openTabs: [item.id], lastRequestId: item.id });

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
  const down = '\u001B[B';

  await until('Say hello');
  await keys('\x12'); // ctrl+r
  await until('OK (0)');
  await keys('\t', ...Array(6).fill(down), '\r'); // request pane → Scripts
  await until('New post-response script');
  await keys('\r');
  await until('post-response script · Say hello');
  await keys(...Array(9).fill(down)); // below the commented example

  await keys("pm.test('greets', () => pm.expect(res.getBody().message).to.include('Ada'");
  await keys('\r', "bru.setEnvVar('greeting', res.getBody().message);");
  await until('✗ line 11:1'); // the missing ")" on line 10 is caught as you type
  await keys('\u001B[A', '\u0005', '));'); // up, ctrl+e: end of line, close the call
  await until('✓ syntax OK');

  await keys('\u0014'); // ctrl+t
  await until('✓ greets');
  expect(app.lastFrame()).toContain('would set {{greeting}} = Bonjour, Ada!');
  expect(ws.environments.find((e) => e.id === env.id)!.values.some((v) => v.key === 'greeting')).toBe(false);

  await keys('\u001B'); // esc: done
  await until('post-response (');
  app.unmount();
}, 20_000);
