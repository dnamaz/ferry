import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Environment } from '../../core/model.js';
import { theme } from '../theme.js';
import { clamp, padEnd } from '../util.js';
import { ModalFrame } from './Modals.js';

interface Props {
  environments: Environment[];
  activeId?: string;
  width: number;
  height: number;
  onActivate: (id: string | undefined) => void;
  onEdit: (env: Environment) => void;
  onCreate: () => void;
  onRename: (env: Environment) => void;
  onDelete: (env: Environment) => void;
  onClose: () => void;
}

export function EnvManager({ environments, activeId, width, height, onActivate, onEdit, onCreate, onRename, onDelete, onClose }: Props) {
  // Row 0 is "No environment".
  const initial = Math.max(0, environments.findIndex((e) => e.id === activeId) + 1);
  const [index, setIndex] = useState(initial);
  const count = environments.length + 1;
  const current = clamp(index, 0, count - 1);
  const env = current > 0 ? environments[current - 1] : undefined;

  useInput((input, key) => {
    if ((key.ctrl || key.meta) && !key.escape) return;
    if (key.escape || input === 'q') return onClose();
    if (key.upArrow || input === 'k') return setIndex(clamp(current - 1, 0, count - 1));
    if (key.downArrow || input === 'j') return setIndex(clamp(current + 1, 0, count - 1));
    if (key.return || input === ' ') return onActivate(env?.id);
    if (input === 'n' || input === 'a') return onCreate();
    if (!env) return;
    if (input === 'e') return onEdit(env);
    if (input === 'r') return onRename(env);
    if (input === 'd') return onDelete(env);
  });

  const inner = width - 4;
  return (
    <ModalFrame title="Environments" width={width} height={height} footer="enter: activate · e: edit variables · n: new · r: rename · d: delete · esc: close">
      {[undefined, ...environments].map((e, i) => {
        const selected = i === current;
        const active = (e?.id ?? undefined) === activeId;
        const label = e ? e.name : 'No environment';
        const hint = e ? `${e.values.filter((v) => v.enabled !== false).length} vars` : '';
        return (
          <Box key={e?.id ?? 'none'}>
            <Text color={selected ? theme.accent : undefined}>{selected ? '› ' : '  '}</Text>
            <Text color={active ? theme.ok : theme.muted}>{active ? '● ' : '○ '}</Text>
            <Text bold={selected} color={e ? undefined : theme.muted}>
              {padEnd(label, inner - 6 - hint.length)}
            </Text>
            <Text color={theme.muted}>{hint}</Text>
          </Box>
        );
      })}
    </ModalFrame>
  );
}
