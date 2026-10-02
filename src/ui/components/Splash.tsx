import React, { useEffect } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { theme } from '../theme.js';

const BOAT = [
  '                                 |>',
  '                               __|__',
  '                              | TLS |',
  '                     _________|_____|_________',
  '                    |  [gRPC]  [gRPC]  [gRPC] |',
  '            ________|_________________________|________',
  '           | [REST] [REST] [REST] [REST] [REST] [REST] |',
  '    _______|___________________________________________|_______',
  '    \\   o  o  o  o     ~ T R A N S P O R T ~     o  o  o  o   /',
  '     \\_______________________________________________________/',
];

const WATER = [
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '  ~~~ HTTP/2 ~~~~~~ protobuf ~~~~~~~ JSON ~~~~~~~ :443 ~~~~~~ :8080 ~~~',
  '~~~~~      ~~~~~~~~       ~~~~~~~~~~       ~~~~~~~~      ~~~~~~   ~~~~',
];

const WIDTH = Math.max(...[...BOAT, ...WATER].map((l) => l.length));
const HEIGHT = BOAT.length + WATER.length + 3;

/** Renders one line, picking out the `[gRPC]` / `[REST]` cargo in its own colour. */
function BoatLine({ line }: { line: string }) {
  const parts = line.split(/(\[gRPC\]|\[REST\])/);
  return (
    <Text color={theme.accent}>
      {parts.map((p, i) =>
        p === '[gRPC]' || p === '[REST]' ? (
          <Text key={i} color={theme.text} bold>
            {p}
          </Text>
        ) : (
          p
        ),
      )}
    </Text>
  );
}

/**
 * Start-up screen: the ferry, held for `durationMs` or until any key. Skipped
 * outright when the terminal is too small to draw it.
 */
export function Splash({ version, onDone, durationMs = 1200 }: { version: string; onDone: () => void; durationMs?: number }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout.columns || 100;
  const rows = stdout.rows || 30;
  const fits = cols >= WIDTH + 2 && rows >= HEIGHT + 1;

  useEffect(() => {
    if (!fits) {
      onDone();
      return;
    }
    const t = setTimeout(onDone, durationMs);
    return () => clearTimeout(t);
  }, [fits, durationMs, onDone]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
    else onDone();
  });

  if (!fits) return null;
  return (
    <Box width={cols} height={Math.max(16, rows - 1)} flexDirection="column" alignItems="center" justifyContent="center">
      <Box flexDirection="column" width={WIDTH}>
        {BOAT.map((l, i) => (
          <BoatLine key={i} line={l} />
        ))}
        {WATER.map((l, i) => (
          <Text key={i} color={theme.info}>
            {l}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>
          ferry v{version} · gRPC and REST from the terminal · press any key
        </Text>
      </Box>
    </Box>
  );
}
