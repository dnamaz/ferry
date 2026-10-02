import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { Splash } from '../src/ui/components/Splash.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('Splash', () => {
  it('draws the ferry and dismisses on any key', async () => {
    const onDone = vi.fn();
    const app = render(<Splash version="9.9.9" onDone={onDone} durationMs={60_000} />);
    const frame = app.lastFrame()!;
    expect(frame).toContain('T R A N S P O R T');
    expect(frame).toContain('[gRPC]');
    expect(frame).toContain('[REST]');
    expect(frame).toContain('ferry v9.9.9');
    await tick();
    app.stdin.write('x');
    await tick();
    expect(onDone).toHaveBeenCalled();
  });

  it('dismisses itself after the duration', async () => {
    const onDone = vi.fn();
    render(<Splash version="0" onDone={onDone} durationMs={10} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(onDone).toHaveBeenCalled();
  });
});
