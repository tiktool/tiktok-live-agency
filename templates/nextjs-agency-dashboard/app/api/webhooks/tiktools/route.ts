import { toDiscordMessage, verifyWebhook, WebhookSignatureError } from 'tiktok-live-agency/webhooks';

export const dynamic = 'force-dynamic';

// Deliveries are retried, so the same event can arrive twice. Remember recent event ids (bounded).
const SEEN_CAP = 1000;
const seen = new Set<string>();

function firstTime(eventId: string): boolean {
  if (seen.has(eventId)) return false;
  seen.add(eventId);
  if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string);
  return true;
}

export async function POST(req: Request) {
  const secret = process.env.TIKTOOLS_WEBHOOK_SECRET;
  if (!secret) return new Response('TIKTOOLS_WEBHOOK_SECRET is not set', { status: 500 });

  const raw = await req.text(); // the raw body; never req.json() before verifying
  let event;
  try {
    event = await verifyWebhook(raw, req.headers, secret);
  } catch (err) {
    if (err instanceof WebhookSignatureError) return new Response('bad signature', { status: 400 });
    throw err;
  }
  if (!firstTime(req.headers.get('x-tiktool-event-id') ?? event.event_id)) return new Response('duplicate');

  const discord = process.env.DISCORD_WEBHOOK_URL;
  if (discord && (event.event === 'live.start' || event.event === 'live.end')) {
    await fetch(discord, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toDiscordMessage(event)) }).catch(() => null);
  }
  return new Response('ok');
}
