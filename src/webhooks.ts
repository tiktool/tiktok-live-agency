import { WebhookSignatureError } from './errors.js';
import type { WebhookEvent } from './types.js';

export { WebhookSignatureError } from './errors.js';
export type {
  WebhookEvent, WebhookEventType, LiveStartEvent, LiveEndEvent, PeakViewersEvent,
  HighValueGiftEvent, FollowerMilestoneEvent, CreatorEligibleEvent,
} from './types.js';

export const SIGNATURE_HEADER = 'x-tiktool-signature';
export const EVENT_ID_HEADER = 'x-tiktool-event-id';
export const SECRET_PREFIX = 'whsec_';
export const DEFAULT_TOLERANCE_SECONDS = 300;

type HeaderBag = { get(name: string): string | null } | Record<string, string | string[] | undefined>;
type RawBody = string | Uint8Array | ArrayBuffer;

export interface VerifyOptions {
  /** Reject deliveries whose timestamp is further than this from now. Default 300. */
  toleranceSeconds?: number;
  /** Override the clock (unix seconds), for tests. */
  now?: number;
}

/** Reads a header from a Fetch Headers object or a Node/Express headers object, case-insensitively. */
export function readHeader(headers: HeaderBag, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(n: string): string | null }).get(name);
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] ?? null : v ?? null;
  }
  return null;
}

/** Splits "t=<unix>,v1=<hex>" in any order, tolerating spaces and repeated v1 entries. */
export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = NaN;
  const signatures: string[] = [];
  for (const part of String(header || '').split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1' && value) signatures.push(value.toLowerCase());
  }
  if (!Number.isFinite(timestamp) || !signatures.length) {
    throw new WebhookSignatureError('Malformed X-Tiktool-Signature header (expected t=<unix>,v1=<hex>)');
  }
  return { timestamp, signatures };
}

/** The server signs with the whsec_-prefixed secret even when you supplied it without the prefix. */
export function normalizeSecret(secret: string): string {
  const s = String(secret || '').trim();
  if (!s) throw new WebhookSignatureError('Missing webhook secret');
  return s.startsWith(SECRET_PREFIX) ? s : SECRET_PREFIX + s;
}

const encoder = new TextEncoder();

function toBytes(body: RawBody): Uint8Array {
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new WebhookSignatureError('rawBody must be the raw request body (string, Buffer or ArrayBuffer), not parsed JSON');
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function getSubtle(): Promise<SubtleCrypto> {
  const g = globalThis as { crypto?: { subtle?: SubtleCrypto } };
  if (g.crypto?.subtle) return g.crypto.subtle;
  const nodeCrypto = (await import('node:crypto')) as unknown as { webcrypto: { subtle: SubtleCrypto } };
  return nodeCrypto.webcrypto.subtle;
}

/**
 * Verifies a tik.tools webhook delivery and returns the typed event.
 * Pass the RAW body (await req.text() in Next.js, express.raw() in Express), never re-serialized JSON.
 * Works in Node 18+, Edge runtimes, Cloudflare Workers, Deno and Bun. Uses a constant-time comparison.
 */
export async function verifyWebhook(
  rawBody: RawBody,
  headersOrSignature: HeaderBag | string,
  secret: string,
  options: VerifyOptions = {},
): Promise<WebhookEvent> {
  const header = typeof headersOrSignature === 'string' ? headersOrSignature : readHeader(headersOrSignature, SIGNATURE_HEADER);
  if (!header) throw new WebhookSignatureError('Missing X-Tiktool-Signature header');
  const { timestamp, signatures } = parseSignatureHeader(header);

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (tolerance > 0 && Math.abs(now - timestamp) > tolerance) {
    throw new WebhookSignatureError(`Webhook timestamp is outside the ${tolerance}s tolerance`);
  }

  const bodyBytes = toBytes(rawBody);
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + bodyBytes.length);
  signed.set(prefix, 0);
  signed.set(bodyBytes, prefix.length);

  const subtle = await getSubtle();
  const key = await subtle.importKey('raw', encoder.encode(normalizeSecret(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  let valid = false;
  for (const sig of signatures) {
    const bytes = hexToBytes(sig);
    if (bytes && (await subtle.verify('HMAC', key, bytes as BufferSource, signed as BufferSource))) valid = true;
  }
  if (!valid) throw new WebhookSignatureError('Webhook signature does not match');

  const text = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(bodyBytes);
  try {
    return JSON.parse(text) as WebhookEvent;
  } catch {
    throw new WebhookSignatureError('Webhook body is not valid JSON');
  }
}

/** Produces the header value the server would send. Useful for testing your own endpoint. */
export async function signWebhookPayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  const subtle = await getSubtle();
  const key = await subtle.importKey('raw', encoder.encode(normalizeSecret(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${hex}`;
}

function escapeDiscord(text: string): string {
  return String(text ?? '').replace(/([\\_*~`|>])/g, '\\$1');
}

function formatCount(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-US') : String(n ?? '');
}

function formatDuration(seconds: unknown): string {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export interface DiscordMessage { content: string; allowed_mentions: { parse: string[] } }

/** Formats a webhook event as a Discord webhook body. POST it to your Discord webhook URL. */
export function toDiscordMessage(event: WebhookEvent): DiscordMessage {
  const who = `@${escapeDiscord(event.creator?.unique_id ?? '')}`;
  let content: string;
  switch (event.event) {
    case 'live.start':
      content = `${who} is LIVE: ${event.live?.live_url ?? `https://www.tiktok.com/@${event.creator?.unique_id}/live`}`;
      break;
    case 'live.end': {
      const d = formatDuration(event.live?.duration_seconds);
      content = `${who} ended their LIVE${d ? ` after ${d}` : ''}`;
      break;
    }
    case 'live.peak_viewers':
      content = `${who} passed ${event.peak?.label ?? formatCount(event.peak?.threshold)} viewers (${formatCount(event.peak?.current_count)} watching)`;
      break;
    case 'live.gift.high_value':
      content = `${who} received ${escapeDiscord(event.gift?.name ?? 'a gift')} (${formatCount(event.gift?.diamonds)} diamonds) from @${escapeDiscord(event.gift?.gifter?.unique_id ?? 'someone')}`;
      break;
    case 'creator.follower_milestone':
      content = `${who} reached ${event.milestone?.label ?? formatCount(event.milestone?.threshold)} followers`;
      break;
    case 'creator.eligible': {
      const e = event.eligible;
      content = `New recruit lead: @${escapeDiscord(e?.username ?? '')} (league ${escapeDiscord(e?.current_league ?? '?')}, ${escapeDiscord(e?.region ?? '')}, score ${formatCount(e?.current_snapshot_score)})`;
      break;
    }
    default:
      content = `${who}: ${escapeDiscord(String((event as { event?: string }).event ?? 'event'))}`;
  }
  if (event.is_test) content = `[test] ${content}`;
  return { content, allowed_mentions: { parse: [] } };
}
