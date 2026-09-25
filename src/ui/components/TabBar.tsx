import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { truncate } from '../util.js';

export interface TabInfo {
  id: string;
  label: string;
  dirty: boolean;
  scratch: boolean;
  status?: 'running' | 'done' | 'error' | 'cancelled';
}

const MAX_LABEL = 24;

function glyph(tab: TabInfo, spinner: string): { text: string; color: string } | undefined {
  switch (tab.status) {
    case 'running':
      return { text: spinner, color: theme.info };
    case 'done':
      return { text: '●', color: theme.ok };
    case 'error':
      return { text: '●', color: theme.error };
    case 'cancelled':
      return { text: '●', color: theme.warn };
    default:
      return undefined;
  }
}

const segmentWidth = (t: TabInfo) => truncate(t.label, MAX_LABEL).length + (t.dirty ? 1 : 0) + (t.status ? 2 : 0) + 2;

/**
 * One-line strip of open requests. Scrolls horizontally so the active tab is
 * always visible, with ‹N / N› markers for tabs hidden on either side.
 */
export function TabBar({ tabs, activeId, width, spinner }: { tabs: TabInfo[]; activeId?: string; width: number; spinner: string }) {
  if (tabs.length === 0) {
    return (
      <Box width={width} height={1}>
        <Text color={theme.muted} wrap="truncate-end">
          {' '}No open requests · enter on a request in the sidebar opens a tab · N: scratch request
        </Text>
      </Box>
    );
  }

  const active = Math.max(0, tabs.findIndex((t) => t.id === activeId));
  const hint = ' [ ] switch · T list · w close';
  const widths = tabs.map((t) => segmentWidth(t) + 1); // +1 for the separator
  const room = width - 8; // leaves space for the ‹N and N› markers

  // Grow a window around the active tab: rightwards first, then leftwards.
  let start = active;
  let end = active + 1;
  let used = widths[active]!;
  while (end < tabs.length && used + widths[end]! <= room) used += widths[end++]!;
  while (start > 0 && used + widths[start - 1]! <= room) used += widths[--start]!;
  const showHint = room - used >= hint.length + 2;

  return (
    <Box width={width} height={1}>
      {start > 0 ? <Text color={theme.muted}>‹{start} </Text> : <Text> </Text>}
      {tabs.slice(start, end).map((t, i) => {
        const isActive = start + i === active;
        const g = glyph(t, spinner);
        return (
          <React.Fragment key={t.id}>
            <Text backgroundColor={isActive ? theme.selection.bg : undefined} bold={isActive} color={isActive ? theme.accent : theme.muted} italic={t.scratch}>
              {' '}
              {g ? <Text color={g.color}>{g.text} </Text> : null}
              {truncate(t.label, MAX_LABEL)}
              {t.dirty ? <Text color={theme.warn}>*</Text> : null}{' '}
            </Text>
            <Text color={theme.border}>│</Text>
          </React.Fragment>
        );
      })}
      {end < tabs.length ? <Text color={theme.muted}> {tabs.length - end}›</Text> : null}
      <Box flexGrow={1} />
      {showHint ? <Text color={theme.muted}>{hint} </Text> : null}
    </Box>
  );
}
