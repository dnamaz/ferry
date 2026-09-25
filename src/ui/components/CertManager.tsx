import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CertificateEntry } from '../../core/model.js';
import { theme } from '../theme.js';
import { clamp, padEnd, truncate } from '../util.js';
import { ModalFrame } from './Modals.js';

interface Props {
  certificates: CertificateEntry[];
  width: number;
  height: number;
  onEdit: (entry?: CertificateEntry) => void;
  onToggle: (entry: CertificateEntry) => void;
  onDelete: (entry: CertificateEntry) => void;
  onClose: () => void;
}

export function certSummary(c: CertificateEntry): string {
  const parts: string[] = [];
  if (c.pfx) parts.push(`p12 ${c.pfx}`);
  else if (c.clientCert) parts.push(`cert ${c.clientCert}`);
  if (c.caCert) parts.push(`CA ${c.caCert}`);
  if (c.passphrase) parts.push('passphrase');
  return parts.join(' · ') || '(nothing set)';
}

/** Per-host client certificates / CAs, applied to gRPC and HTTP requests to matching hosts. */
export function CertManager({ certificates, width, height, onEdit, onToggle, onDelete, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const current = clamp(index, 0, Math.max(0, certificates.length - 1));
  const entry = certificates[current];

  useInput((input, key) => {
    if ((key.ctrl || key.meta) && !key.escape) return;
    if (key.escape || input === 'q') return onClose();
    if (key.upArrow || input === 'k') return setIndex(clamp(current - 1, 0, certificates.length - 1));
    if (key.downArrow || input === 'j') return setIndex(clamp(current + 1, 0, certificates.length - 1));
    if (input === 'n' || input === 'a') return onEdit(undefined);
    if (!entry) return;
    if (key.return || input === 'e') return onEdit(entry);
    if (input === ' ') return onToggle(entry);
    if (input === 'd') return onDelete(entry);
  });

  const inner = width - 4;
  const hostWidth = Math.min(32, Math.max(12, ...certificates.map((c) => c.host.length + 2)));
  return (
    <ModalFrame title="Certificates (per host)" width={width} height={height} footer="n: add · enter: edit · space: enable/disable · d: delete · esc: close">
      <Text color={theme.muted} wrap="truncate-end">
        Applied to gRPC and HTTP requests whose host matches; request and collection TLS settings override these.
      </Text>
      {certificates.length === 0 ? (
        <Text color={theme.muted}>  none yet — press n to add one (e.g. host *.symmetrydev.com)</Text>
      ) : (
        certificates.map((c, i) => {
          const selected = i === current;
          return (
            <Box key={c.id}>
              <Text color={selected ? theme.accent : undefined}>{selected ? '› ' : '  '}</Text>
              <Text color={c.disabled ? theme.muted : theme.ok}>{c.disabled ? '○ ' : '● '}</Text>
              <Text bold={selected} dimColor={c.disabled}>
                {padEnd(c.host, hostWidth)}
              </Text>
              <Text color={theme.muted} wrap="truncate-end">
                {truncate(certSummary(c), inner - hostWidth - 6)}
              </Text>
            </Box>
          );
        })
      )}
    </ModalFrame>
  );
}
