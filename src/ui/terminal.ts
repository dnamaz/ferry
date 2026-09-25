import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { which } from './util.js';

export const ALT_SCREEN_ON = '\x1b[?1049h\x1b[2J\x1b[H';
export const ALT_SCREEN_OFF = '\x1b[?1049l';

let clearInk: (() => void) | undefined;

/** Registered by the CLI after `render()` so we can force a full repaint. */
export function setInkClear(fn: () => void): void {
  clearInk = fn;
}

/**
 * Suspends the TUI, opens `$VISUAL`/`$EDITOR` on a temp file, and returns the
 * edited text (or undefined if the editor failed).
 */
export function editInExternalEditor(text: string, extension = '.json'): { text?: string; error?: string } {
  const editor = process.env.VISUAL || process.env.EDITOR || (which('nano') ? 'nano' : 'vi');
  const file = join(tmpdir(), `ferry-${process.pid}-${Date.now()}${extension}`);
  writeFileSync(file, text);
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  try {
    if (stdin.isTTY) stdin.setRawMode(false);
    process.stdout.write(`${ALT_SCREEN_OFF}\x1b[?25h`);
    const res = spawnSync(`${editor} "${file}"`, { shell: true, stdio: 'inherit' });
    if (res.status !== 0) return { error: `${editor} exited with ${res.status ?? res.signal}` };
    return { text: readFileSync(file, 'utf8').replace(/\n$/, '') };
  } finally {
    process.stdout.write(`${ALT_SCREEN_ON}\x1b[?25l`);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    rmSync(file, { force: true });
    clearInk?.();
  }
}

/** Copies text to the system clipboard using whatever tool is available. */
export function copyToClipboard(text: string): boolean {
  const candidates: Array<[string, string[]]> = [
    ['pbcopy', []],
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
    ['clip.exe', []],
  ];
  for (const [cmd, args] of candidates) {
    if (!which(cmd)) continue;
    const res = spawnSync(cmd, args, { input: text });
    if (res.status === 0) return true;
  }
  return false;
}
