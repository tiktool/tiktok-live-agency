import { AuthError, PaymentRequiredError, PlanRequiredError, TikToolsError } from './errors.js';
import type { GifterAlert } from './types.js';

export type { GifterAlert } from './types.js';

export interface FirehoseFilter {
  /**
   * global (default): every gift of 1,000+ diamonds. region: gifts to creators in one region (needs region).
   * league: gifts to creators in one league division (needs league; add region to narrow it to one region).
   */
  mode?: 'global' | 'region' | 'league';
  /** Region code such as UK+, US+, DE+. Required with mode region; optional with mode league. */
  region?: string;
  /** League division A1 to D5. Required with mode league; matches gifts whose receiving creator is in that division. */
  league?: string;
  /** Minimum gift size. The publisher floor is 1000 diamonds. */
  minDiamonds?: number;
}

/** Minimal WebSocket surface: the browser/Node 22 global and the `ws` package both fit. */
interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export type WebSocketConstructor = new (url: string) => unknown;

export interface StreamBigGiftsOptions extends FirehoseFilter {
  apiKey?: string;
  baseUrl?: string;
  /** Pass the `ws` package on Node 18/20: `import WebSocket from 'ws'`. Node 22+, browsers and Workers have a global one. */
  WebSocket?: WebSocketConstructor;
  onReady?: (filter: unknown) => void;
  onError?: (error: Error) => void;
  /** Stop reconnecting after this many failed connects in a row before a ready frame. Default 6. */
  maxFailedConnects?: number;
}

export interface FirehoseHandle {
  updateFilter(filter: FirehoseFilter): void;
  close(): void;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export function firehoseUrl(baseUrl: string, apiKey: string, filter: FirehoseFilter): string {
  const u = new URL('/firehose/gifters', baseUrl.replace(/^http/i, 'ws'));
  u.searchParams.set('apiKey', apiKey);
  if (filter.mode) u.searchParams.set('mode', filter.mode);
  if (filter.region) u.searchParams.set('region', filter.region);
  if (filter.league) u.searchParams.set('league', filter.league);
  if (filter.minDiamonds) u.searchParams.set('min_diamonds', String(filter.minDiamonds));
  return u.toString();
}

function handshakeError(status: number): Error {
  const endpoint = '/firehose/gifters';
  if (status === 401) return new AuthError('Firehose rejected the API key', 401, null, endpoint);
  if (status === 402) return new PaymentRequiredError('Firehose needs an active Agency subscription', 402, null, endpoint);
  if (status === 403) return new PlanRequiredError('Firehose is an Agency plan feature', 403, null, endpoint, 'agency_global');
  return new TikToolsError(`Firehose handshake failed with HTTP ${status}`, status, null, endpoint);
}

function envKey(): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.TIKTOOLS_API_KEY;
}

/**
 * Streams big-gift alerts (1,000+ diamonds) from the live gifter firehose. Reconnects with
 * backoff from 1s to 30s. Needs the Agency plan with an active subscription.
 * Each alert carries the receiving creator's league division (classType) when known. Mode league needs
 * league; region is optional there and narrows the division to one region.
 */
export function streamBigGifts(options: StreamBigGiftsOptions, onAlert: (alert: GifterAlert) => void): FirehoseHandle {
  const apiKey = options.apiKey ?? envKey();
  if (!apiKey) throw new AuthError('Set TIKTOOLS_API_KEY or pass apiKey', 401, null, '/firehose/gifters');
  const WS = (options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket) as WebSocketConstructor | undefined;
  if (!WS) {
    throw new TikToolsError('No WebSocket available. On Node 18/20 install ws and pass { WebSocket } from it.', 0, null, '/firehose/gifters');
  }
  const baseUrl = options.baseUrl ?? 'https://api.tik.tools';
  const maxFailed = options.maxFailedConnects ?? 6;
  let filter: FirehoseFilter = { mode: options.mode, region: options.region, league: options.league, minDiamonds: options.minDiamonds };
  let socket: SocketLike | null = null;
  let closed = false;
  let failedConnects = 0;
  let backoff = MIN_BACKOFF_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fatal = false;

  const report = (err: Error) => { if (options.onError) options.onError(err); };

  const scheduleReconnect = () => {
    if (closed || fatal) return;
    if (failedConnects >= maxFailed) {
      report(new TikToolsError(`Firehose could not connect after ${failedConnects} attempts. It needs the Agency plan with an active subscription.`, 0, null, '/firehose/gifters'));
      return;
    }
    const wait = backoff;
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
    timer = setTimeout(connect, wait);
  };

  function connect(): void {
    if (closed) return;
    let ready = false;
    const ws = new (WS as WebSocketConstructor)(firehoseUrl(baseUrl, apiKey as string, filter)) as SocketLike;
    socket = ws;
    if (typeof ws.on === 'function') {
      // The ws package exposes the HTTP status of a refused upgrade; the browser API does not.
      ws.on('unexpected-response', (_req: unknown, res: unknown) => {
        const status = Number((res as { statusCode?: number })?.statusCode) || 0;
        if (status === 401 || status === 402 || status === 403) fatal = true;
        report(handshakeError(status));
      });
    }
    ws.onmessage = (ev) => {
      let msg: { type?: string; filter?: unknown } | null = null;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (!msg) return;
      if (msg.type === 'ready') {
        ready = true;
        failedConnects = 0;
        backoff = MIN_BACKOFF_MS;
        if (options.onReady) options.onReady(msg.filter);
      } else if (msg.type === 'gifter_alert') {
        onAlert(msg as GifterAlert);
      }
    };
    ws.onerror = () => { /* onclose follows and decides about reconnecting */ };
    ws.onclose = () => {
      socket = null;
      if (!ready) failedConnects++;
      scheduleReconnect();
    };
  }

  connect();

  return {
    updateFilter(next: FirehoseFilter) {
      filter = { ...filter, ...next };
      if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'update_filter', mode: filter.mode, region: filter.region, league: filter.league, min_diamonds: filter.minDiamonds }));
      }
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (socket) socket.close(1000, 'client closed');
      socket = null;
    },
  };
}
