import React from 'react';
import { Box, Text } from 'ink';
import type { Collection, Item } from '../../core/model.js';
import { sortItems } from '../../core/model.js';
import type { MethodInfo, Schema } from '../../grpc/schema.js';
import { kindLabel } from '../../grpc/schema.js';
import { icons, theme } from '../theme.js';
import { METHOD_COLORS } from './HttpRequestPanel.js';
import { padEnd, scrollInto, truncate } from '../util.js';

export type SidebarTab = 'collections' | 'services';

export interface TreeRow {
  id: string;
  kind: 'collection' | 'folder' | 'grpc' | 'http' | 'other';
  depth: number;
  label: string;
  collectionId: string;
  /** id of the containing collection or folder (for collections: itself) */
  parentId: string;
  expanded: boolean;
  childCount: number;
  item?: Item;
  hint?: string;
}

export function buildTree(collections: Collection[], expanded: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const addItems = (items: Item[], depth: number, collectionId: string, parentId: string) => {
    for (const item of sortItems(items)) {
      if (item.type === 'folder') {
        const open = expanded.has(item.id);
        rows.push({ id: item.id, kind: 'folder', depth, label: item.name, collectionId, parentId, expanded: open, childCount: item.items.length, item });
        if (open) addItems(item.items, depth + 1, collectionId, item.id);
      } else if (item.type === 'http') {
        rows.push({ id: item.id, kind: 'http', depth, label: item.name, collectionId, parentId, expanded: false, childCount: 0, item });
      } else if (item.type === 'grpc') {
        rows.push({ id: item.id, kind: 'grpc', depth, label: item.name, collectionId, parentId, expanded: false, childCount: 0, item });
      } else {
        rows.push({
          id: item.id,
          kind: 'other',
          depth,
          label: item.name,
          collectionId,
          parentId,
          expanded: false,
          childCount: 0,
          item,
          hint: item.kind.replace(/-request$/, ''),
        });
      }
    }
  };
  for (const c of collections) {
    const open = expanded.has(c.id);
    rows.push({ id: c.id, kind: 'collection', depth: 0, label: c.name, collectionId: c.id, parentId: c.id, expanded: open, childCount: c.items.length });
    if (open) addItems(c.items, 1, c.id, c.id);
  }
  return rows;
}

export interface ServiceRow {
  id: string;
  kind: 'service' | 'method';
  label: string;
  expanded: boolean;
  method?: MethodInfo;
  service: string;
}

export function buildServiceRows(schema: Schema | undefined, expanded: Set<string>): ServiceRow[] {
  if (!schema) return [];
  const rows: ServiceRow[] = [];
  for (const s of schema.services) {
    const open = expanded.has(s.name);
    rows.push({ id: s.name, kind: 'service', label: s.name, expanded: open, service: s.name });
    if (open) for (const m of s.methods) rows.push({ id: m.path, kind: 'method', label: m.name, expanded: false, method: m, service: s.name });
  }
  return rows;
}

interface Props {
  width: number;
  height: number;
  focused: boolean;
  tab: SidebarTab;
  tree: TreeRow[];
  treeIndex: number;
  treeOffset: number;
  services: ServiceRow[];
  serviceIndex: number;
  serviceOffset: number;
  servicesStatus: { state: 'idle' | 'loading' | 'ready' | 'error'; message?: string; target?: string };
  activeId?: string;
  dirtyIds: Set<string>;
  currentMethod?: string;
}

export function Sidebar(props: Props) {
  const { width, height, focused, tab } = props;
  const inner = width - 2;
  const listHeight = Math.max(1, height - 4);

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={focused ? theme.borderFocus : theme.border}>
      <Box>
        <TabLabel label={inner >= 30 ? '1 Collections' : 'Collections'} active={tab === 'collections'} focused={focused} />
        <Text> </Text>
        <TabLabel label={inner >= 30 ? '2 Services' : 'Services'} active={tab === 'services'} focused={focused} />
      </Box>
      <Text color={theme.border}>{'─'.repeat(inner)}</Text>
      {tab === 'collections' ? <TreeList {...props} inner={inner} listHeight={listHeight} /> : <ServiceList {...props} inner={inner} listHeight={listHeight} />}
    </Box>
  );
}

function TabLabel({ label, active, focused }: { label: string; active: boolean; focused: boolean }) {
  return (
    <Text bold={active} color={active ? (focused ? theme.accent : theme.text) : theme.muted} underline={active}>
      {` ${label} `}
    </Text>
  );
}

function TreeList({ tree, treeIndex, treeOffset, inner, listHeight, focused, activeId, dirtyIds }: Props & { inner: number; listHeight: number }) {
  if (tree.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.muted}>No collections yet.</Text>
        <Text color={theme.muted}> </Text>
        <Text color={theme.muted} wrap="wrap">
          c  new collection
        </Text>
        <Text color={theme.muted} wrap="wrap">
          i  import Postman v3
        </Text>
      </Box>
    );
  }
  const offset = scrollInto(treeIndex, treeOffset, listHeight);
  return (
    <Box flexDirection="column">
      {tree.slice(offset, offset + listHeight).map((row, i) => {
        const selected = offset + i === treeIndex;
        const indent = '  '.repeat(row.depth);
        let icon: string;
        let color: string | undefined;
        if (row.kind === 'collection') {
          icon = row.expanded ? icons.folderOpen : icons.folderClosed;
          color = theme.accent;
        } else if (row.kind === 'folder') {
          icon = row.expanded ? icons.folderOpen : icons.folderClosed;
          color = theme.info;
        } else if (row.kind === 'http') {
          // Method badge, padded so names line up: GET  POST PUT  DEL
          const m = (row.item?.type === 'http' ? row.item.method : 'GET').toUpperCase();
          icon = (m === 'DELETE' ? 'DEL' : m === 'OPTIONS' ? 'OPT' : m === 'PATCH' ? 'PTCH' : m).padEnd(4).slice(0, 4);
          color = METHOD_COLORS[m] ?? theme.text;
        } else if (row.kind === 'grpc') {
          icon = icons.grpc;
          color = theme.ok;
        } else {
          icon = icons.other;
          color = theme.muted;
        }
        const dirty = dirtyIds.has(row.id) ? icons.dirty : '';
        const hint = row.hint ? ` ${row.hint}` : (row.kind === 'collection' || row.kind === 'folder') && !row.expanded ? ` ${row.childCount}` : '';
        const iconWidth = icon.length + 1;
        const labelWidth = Math.max(1, inner - indent.length - iconWidth - hint.length - dirty.length);
        const isActive = row.id === activeId;
        return (
          <Box key={row.id}>
            <Text backgroundColor={selected && focused ? theme.selection.bg : undefined} wrap="truncate-end">
              <Text>{indent}</Text>
              <Text color={color}>{icon} </Text>
              <Text bold={row.kind === 'collection' || isActive} color={row.kind === 'other' ? theme.muted : isActive ? theme.accent : undefined} inverse={selected && !focused}>
                {truncate(row.label, labelWidth)}
              </Text>
              <Text color={theme.warn}>{dirty}</Text>
              <Text color={theme.muted}>{padEnd(hint, Math.max(0, inner - indent.length - iconWidth - Math.min(row.label.length, labelWidth) - dirty.length))}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function ServiceList({ services, serviceIndex, serviceOffset, inner, listHeight, focused, servicesStatus, currentMethod }: Props & { inner: number; listHeight: number }) {
  const status = servicesStatus;
  if (status.state !== 'ready' || services.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {status.target ? (
          <Text color={theme.muted} wrap="truncate-end">
            {status.target}
          </Text>
        ) : null}
        {status.state === 'loading' ? <Text color={theme.info}>Discovering services…</Text> : null}
        {status.state === 'error' ? (
          <Text color={theme.error} wrap="wrap">
            {status.message}
          </Text>
        ) : null}
        {status.state === 'idle' ? (
          <Text color={theme.muted} wrap="wrap">
            Set a URL on the request, then press R to discover services via reflection (or configure .proto files in settings).
          </Text>
        ) : null}
        {status.state === 'ready' ? <Text color={theme.muted}>No services found.</Text> : null}
      </Box>
    );
  }
  const offset = scrollInto(serviceIndex, serviceOffset, listHeight - 1);
  return (
    <Box flexDirection="column">
      <Text color={theme.muted} wrap="truncate-end">
        {' '}
        {truncate(status.target ?? '', inner - 1)}
      </Text>
      {services.slice(offset, offset + listHeight - 1).map((row, i) => {
        const selected = offset + i === serviceIndex;
        const bg = selected && focused ? theme.selection.bg : undefined;
        if (row.kind === 'service') {
          return (
            <Text key={row.id} backgroundColor={bg} wrap="truncate-end">
              <Text color={theme.info}>{row.expanded ? icons.folderOpen : icons.folderClosed} </Text>
              <Text bold inverse={selected && !focused}>
                {padEnd(row.label, inner - 2)}
              </Text>
            </Text>
          );
        }
        const kind = row.method!.kind;
        const badge = kindLabel(kind);
        const isCurrent = row.method!.path === currentMethod;
        return (
          <Text key={row.id} backgroundColor={bg} wrap="truncate-end">
            <Text>{'  '}</Text>
            <Text color={theme.kind[kind]}>{icons.grpc} </Text>
            <Text bold={isCurrent} color={isCurrent ? theme.accent : undefined} inverse={selected && !focused}>
              {padEnd(row.label, Math.max(1, inner - 5 - badge.length))}
            </Text>
            <Text color={theme.kind[kind]} dimColor>
              {' '}
              {badge}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
