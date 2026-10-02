import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ScriptProblem } from '../../core/scripts.js';
import { theme } from '../theme.js';
import { truncate } from '../util.js';
import { ModalFrame } from './Modals.js';
import { TextEditor } from './TextEditor.js';

export interface OutputLine {
  text: string;
  color?: string;
}

const OUTPUT_ROWS = 6;

/**
 * In-place script editor: JS/TS colors, a syntax check on every change, and a
 * test run (ctrl+t) that executes the script without saving any variables.
 */
export function ScriptEditorModal({
  title,
  initial,
  width,
  height,
  check,
  onTest,
  onExternal,
  onSave,
  onCancel,
}: {
  title: string;
  initial: string;
  width: number;
  height: number;
  check: (code: string) => ScriptProblem | undefined;
  /** what a test run of `code` did, as display lines */
  onTest?: (code: string) => Promise<OutputLine[]>;
  /** edits `code` in $EDITOR; returns the new text, or undefined to keep it */
  onExternal?: (code: string) => string | undefined;
  onSave: (code: string) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState(initial);
  const [output, setOutput] = useState<OutputLine[] | undefined>();
  const [running, setRunning] = useState(false);
  const problem = useMemo(() => check(code), [check, code]);

  useInput((input, key) => {
    if (!key.ctrl) return;
    if (input === 'x') return onCancel();
    if (input === 'o' && onExternal) {
      const next = onExternal(code);
      if (next !== undefined) setCode(next);
      return;
    }
    if (input === 't' && onTest && !running) {
      if (problem) return setOutput([{ text: 'Fix the syntax error first', color: theme.error }]);
      setRunning(true);
      setOutput([{ text: 'running…', color: theme.muted }]);
      onTest(code)
        .then(setOutput, (err: Error) => setOutput([{ text: err.message, color: theme.error }]))
        .finally(() => setRunning(false));
    }
  });

  const inner = width - 4;
  const outputRows = output ? Math.min(OUTPUT_ROWS, output.length) + 1 : 0;
  // border (2) + title + status + footer
  const editorHeight = Math.max(3, height - 5 - outputRows);
  const status = problem ? `✗ ${problem.line ? `line ${problem.line}${problem.column ? `:${problem.column}` : ''}: ` : ''}${problem.message}` : '✓ syntax OK';
  const footer = `esc: done · ${onTest ? 'ctrl+t: test run · ' : ''}${onExternal ? 'ctrl+o: $EDITOR · ' : ''}ctrl+x: discard`;

  return (
    <ModalFrame title={title} width={width} height={height} footer={footer}>
      <Text color={problem ? theme.error : theme.ok} wrap="truncate-end">
        {truncate(status, inner)}
      </Text>
      <TextEditor value={code} onChange={setCode} width={inner} height={editorHeight} active={!running} onExit={() => onSave(code)} json={false} code errorLine={problem?.line} />
      {output ? (
        <Box flexDirection="column">
          <Text color={theme.border}>{'─'.repeat(inner)}</Text>
          {output.slice(0, OUTPUT_ROWS).map((l, i) => (
            <Text key={i} color={l.color} wrap="truncate-end">
              {i === OUTPUT_ROWS - 1 && output.length > OUTPUT_ROWS ? `… ${output.length - OUTPUT_ROWS + 1} more` : truncate(l.text, inner)}
            </Text>
          ))}
        </Box>
      ) : null}
    </ModalFrame>
  );
}
