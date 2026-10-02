import { performance } from 'node:perf_hooks';

/**
 * Where a request's time went. Phases are consecutive: each starts where the previous one ended,
 * so they add up to the total.
 *
 *   prepare   encode the message / build the body, until the request is handed to the transport
 *   dns       resolve the host name
 *   connect   TCP handshake
 *   tls       TLS handshake
 *   http2     HTTP/2 connection preface and SETTINGS exchange (gRPC)
 *   send      upload the request body (HTTP, when there is one)
 *   wait      request sent → response headers: one network round trip plus server time
 *   receive   response headers → end of the response (body, trailers, stream messages)
 */
export type PhaseName = 'prepare' | 'redirect' | 'dns' | 'connect' | 'tls' | 'http2' | 'send' | 'wait' | 'receive';

export interface TimingPhase {
  name: PhaseName;
  ms: number;
}

export interface Timing {
  phases: TimingPhase[];
  /** the request went out on a connection that was already open, so no dns/connect/tls */
  reused?: boolean;
  /** time the server says it spent, from a response header */
  serverMs?: number;
  /** the header `serverMs` came from */
  serverSource?: string;
}

/** Milliseconds since `origin` (a performance.now() value), to 0.1 ms. */
export const since = (origin: number): number => Math.round((performance.now() - origin) * 10) / 10;

/**
 * Builds consecutive phases from the time each one ENDED, in order. A missing end (the phase never
 * happened, e.g. no TLS on a plaintext connection) is skipped and its time falls into the next
 * phase. An end earlier than the previous one is clamped, so a phase is never negative.
 */
export function phasesFrom(ends: Array<[PhaseName, number | undefined]>): TimingPhase[] {
  const phases: TimingPhase[] = [];
  let prev = 0;
  for (const [name, end] of ends) {
    if (end === undefined) continue;
    const at = Math.max(prev, end);
    phases.push({ name, ms: Math.round((at - prev) * 10) / 10 });
    prev = at;
  }
  return phases;
}

/**
 * Server-reported time: Envoy's `x-envoy-upstream-service-time` (ms the upstream took), or the
 * `total` entry of a `Server-Timing` header, else the sum of its `dur` values.
 */
export function serverTime(headers: Array<[string, string]>): Pick<Timing, 'serverMs' | 'serverSource'> {
  const get = (name: string) => headers.find(([k]) => k.toLowerCase() === name)?.[1];
  const envoy = get('x-envoy-upstream-service-time');
  if (envoy !== undefined && /^\d+(\.\d+)?$/.test(envoy.trim())) return { serverMs: Number(envoy), serverSource: 'x-envoy-upstream-service-time' };
  const st = get('server-timing');
  if (st) {
    const entries = st.split(',').map((e) => {
      const [name, ...params] = e.split(';').map((p) => p.trim());
      const dur = params.find((p) => /^dur=/i.test(p))?.slice(4);
      return { name: name?.toLowerCase(), dur: dur !== undefined && dur !== '' && !Number.isNaN(Number(dur)) ? Number(dur) : undefined };
    });
    const total = entries.find((e) => e.name === 'total' && e.dur !== undefined);
    const durs = entries.filter((e) => e.dur !== undefined);
    if (total) return { serverMs: total.dur, serverSource: 'server-timing' };
    if (durs.length) return { serverMs: durs.reduce((s, e) => s + e.dur!, 0), serverSource: 'server-timing' };
  }
  return {};
}

/** One line: `dns 5 · connect 99 · tls 160 · http2 125 · wait 133 · receive 7 ms`. */
export function formatPhases(t: Timing | undefined): string {
  if (!t?.phases.length) return '';
  const shown = t.phases.filter((p) => p.ms >= 0.5 || p.name === 'wait');
  return `${shown.map((p) => `${p.name} ${Math.round(p.ms)}`).join(' · ')} ms${t.reused ? ' (reused connection)' : ''}`;
}
