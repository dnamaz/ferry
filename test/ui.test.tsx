import React from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { walkItems } from '../src/core/model.js';
import { Workspace } from '../src/core/workspace.js';
import { App } from '../src/ui/App.js';
import { ResponsePanel, responseLines } from '../src/ui/components/ResponsePanel.js';
import { ChecklistModal } from '../src/ui/components/Modals.js';

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

  it('with the values of {{vars}} in grey after message lines', () => {
    const ws = workspaceWith('Say hello');
    const item = [...walkItems(ws.collections[0]!.items)].find((x) => x.item.name === 'Say hello')!.item;
    if (item.type === 'grpc') item.message = '{\n  "name": "{{user}}",\n  "token": "{{token}}",\n  "id": "{{$guid}}",\n  "missing": "{{nope}}"\n}';
    ws.saveCollection(ws.collections[0]!);
    ws.saveState({ ...ws.state, layout: 'side-by-side', activeEnvironmentId: ws.environments.find((e) => e.name === 'Local')!.id });
    const out = frame(ws);
    expect(out).toMatch(/"name": "\{\{user\}\}",\s+→ Ada/);
    expect(out).toMatch(/"token": "\{\{token\}\}",\s+→ de/);
    expect(out).not.toContain('demo-token'); // secrets are masked
    expect(out).not.toMatch(/\{\{\$guid\}\}",\s+→/);
    expect(out).not.toMatch(/\{\{nope\}\}",\s+→/);
  });
});

describe('ResponsePanel', () => {
  it('wraps long client errors instead of cutting them off', () => {
    const error = 'Invalid com.example.RunReportRequest: cannot decode field com.example.RunReportRequest.filters from JSON: expected object, got string';
    const result = { state: 'error' as const, error, headers: [], trailers: [], messages: [], sent: 0, startedAt: 0, durationMs: 5 };
    const { lastFrame } = render(<ResponsePanel width={60} height={12} focused={false} result={result} tab="messages" offset={0} spinner="" />);
    const text = lastFrame()!.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s*\n\s*(\/\/)?\s*/g, ' ');
    expect(text).toContain('expected object, got string');
    expect(responseLines(result, 'messages', 56).filter((l) => l.kind === 'error').length).toBeGreaterThan(1);
  });
});

describe('ChecklistModal', () => {
  it('toggles items and submits the ticked ones', async () => {
    let submitted: number[] | undefined;
    const items = [
      { label: 'tenant_id ← [0].tenantId', checked: true },
      { label: 'company_id ← [0].companyId', checked: true },
      { label: 'id ← [0].id', checked: false },
    ];
    const app = render(<ChecklistModal title="Fill" items={items} width={60} height={10} onSubmit={(c) => (submitted = c)} onCancel={() => {}} />);
    expect(app.lastFrame()).toContain('[x] tenant_id');
    expect(app.lastFrame()).toContain('enter: apply 2');
    const key = async (k: string) => {
      app.stdin.write(k);
      await new Promise((r) => setTimeout(r, 20));
    };
    await key('\u001B[B'); // down to company_id
    await key(' '); // untick
    await key('\u001B[B');
    await key(' '); // tick id
    await key('\r');
    expect(submitted).toEqual([0, 2]);
    app.unmount();
  });
});
