export const theme = {
  accent: '#d97757',
  accentDim: '#9c5a44',
  border: 'gray',
  borderFocus: '#d97757',
  muted: 'gray',
  text: 'white',
  ok: 'green',
  warn: 'yellow',
  error: 'red',
  info: 'cyan',
  json: {
    key: 'cyan',
    string: 'green',
    number: 'yellow',
    literal: 'magenta',
    punct: 'gray',
  },
  kind: {
    unary: 'cyan',
    server_streaming: 'green',
    client_streaming: 'yellow',
    bidi_streaming: 'magenta',
  } as Record<string, string>,
  selection: { bg: '#3a3a3a' },
} as const;

export const icons = {
  collection: '▣',
  folderOpen: '▾',
  folderClosed: '▸',
  grpc: '◆',
  other: '◇',
  service: '⬡',
  method: '·',
  dot: '●',
  dirty: '*',
};
