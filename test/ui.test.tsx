import React from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { walkItems } from '../src/core/model.js';
import { Workspace } from '../src/core/workspace.js';
import { App } from '../src/ui/App.js';

const EXAMPLES = join(import.meta.dirname, '..', 'examples');
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Workspace with the example collection imported and `name` open in a tab. */
function workspaceWith(name?: string): Workspace {
  const home = mkdtempSync(join(tmpdir(), 'ferry-ui-'));
  homes.push(home);
  const ws = new Workspace(home);
  ws.importPath(EXAMPLES);
  if (name) {
    const item = [...walkItems(ws.collections[0]!.items)].find((x) => x.item.name === name)!.item;
    ws.saveState({ openTabs: [item.id], lastRequestId: item.id });
  }
  return ws;
}

const frame = (ws: Workspace) => {
  const app = render(<App workspace={ws} />);
  const out = app.lastFrame() ?? '';
  app.unmount();
  return out;
};

describe('App renders', () => {
  it('with no request open', () => {
    expect(frame(workspaceWith())).toContain('Select a request in the sidebar');
  });

  it('with a gRPC request open', () => {
    const out = frame(workspaceWith('Say hello'));
    expect(out).toContain('Say hello');
    expect(out).toContain('demo.greeter.v1.Greeter/SayHello');
  });

  it('with an HTTP request open', () => {
    const out = frame(workspaceWith('List notes'));
    expect(out).toContain('List notes');
    expect(out).toContain('GET');
  });

  it('with a Scripts row on gRPC and HTTP requests', () => {
    expect(frame(workspaceWith('Say hello'))).toMatch(/Scripts\s+none · enter to add a JS\/TS script/);
    const ws = workspaceWith('List notes');
    const item = [...walkItems(ws.collections[0]!.items)].find((x) => x.item.name === 'List notes')!.item;
    if (item.type === 'http') item.scripts = [{ type: 'afterResponse', code: "bru.setEnvVar('a', 1);\nbru.setEnvVar('b', 2);" }];
    expect(frame(ws)).toMatch(/Scripts\s+post-response \(2 lines\)/);
  });
});
