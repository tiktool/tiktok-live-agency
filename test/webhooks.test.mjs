import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhook, toDiscordMessage, signWebhookPayload, WebhookSignatureError } from '../dist/webhooks.mjs';

const secret = 'whsec_0123456789abcdef0123456789abcdef';
const payload = JSON.stringify({
  event_id: 'evt_1', event: 'live.start', occurred_at: '2026-10-19T10:00:00Z',
  creator: { unique_id: 'some_creator', nickname: 'Some' },
  live: { room_id: '7', started_at: '2026-10-19T10:00:00Z', live_url: 'https://www.tiktok.com/@some_creator/live' },
});
const now = 1792400000;

// Reference signer using the documented algorithm, so the verifier is checked independently.
function serverSign(body, ts, key = secret) {
  return `t=${ts},v1=${createHmac('sha256', key).update(`${ts}.${body}`).digest('hex')}`;
}

test('accepts a signature made by the server algorithm', async () => {
  const ev = await verifyWebhook(payload, serverSign(payload, now), secret, { now });
  assert.equal(ev.event, 'live.start');
  assert.equal(ev.creator.unique_id, 'some_creator');
});

test('reads the header from Fetch Headers and from a Node headers object', async () => {
  const sig = serverSign(payload, now);
  await verifyWebhook(payload, new Headers({ 'X-Tiktool-Signature': sig }), secret, { now });
  await verifyWebhook(Buffer.from(payload), { 'x-tiktool-signature': sig }, secret, { now });
  await verifyWebhook(new TextEncoder().encode(payload).buffer, { 'X-TIKTOOL-SIGNATURE': [sig] }, secret, { now });
});

test('accepts fields in any order with spaces and several v1 values', async () => {
  const good = serverSign(payload, now).split(',')[1];
  await verifyWebhook(payload, ` v1=${'0'.repeat(64)} , ${good} , t=${now} `, secret, { now });
});

test('adds the whsec_ prefix the server adds to a caller-supplied secret', async () => {
  const supplied = 'my_own_secret_value_1234';
  const sig = serverSign(payload, now, `whsec_${supplied}`);
  await verifyWebhook(payload, sig, supplied, { now });
});

test('rejects a tampered body, a wrong secret, a stale timestamp and a malformed header', async () => {
  const sig = serverSign(payload, now);
  await assert.rejects(verifyWebhook(payload.replace('some_creator', 'other'), sig, secret, { now }), WebhookSignatureError);
  await assert.rejects(verifyWebhook(payload, sig, 'whsec_wrong_secret_value', { now }), WebhookSignatureError);
  await assert.rejects(verifyWebhook(payload, sig, secret, { now: now + 301 }), /tolerance/);
  await assert.rejects(verifyWebhook(payload, 'v1=abc', secret, { now }), /Malformed/);
  await assert.rejects(verifyWebhook(payload, {}, secret, { now }), /Missing/);
  await assert.rejects(verifyWebhook(JSON.parse(payload), sig, secret, { now }), /raw request body/);
});

test('signWebhookPayload matches the server signer', async () => {
  assert.equal(await signWebhookPayload(payload, secret, now), serverSign(payload, now));
});

test('toDiscordMessage formats each event and escapes markdown', () => {
  const ev = JSON.parse(payload);
  const m = toDiscordMessage(ev);
  assert.equal(m.content, '@some\\_creator is LIVE: https://www.tiktok.com/@some_creator/live');
  assert.deepEqual(m.allowed_mentions, { parse: [] });
  assert.match(toDiscordMessage({ ...ev, event: 'live.end', live: { duration_seconds: 4980 } }).content, /after 1h 23m/);
  assert.match(toDiscordMessage({ ...ev, event: 'live.gift.high_value', gift: { name: 'Lion', diamonds: 29999, gifter: { unique_id: 'whale' } } }).content, /Lion \(29,999 diamonds\) from @whale/);
  assert.match(toDiscordMessage({ ...ev, is_test: true }).content, /^\[test\]/);
  assert.match(toDiscordMessage({ ...ev, event: 'creator.eligible', eligible: { username: 'new_one', current_league: 'A1', region: 'UK+', current_snapshot_score: 60000 } }).content, /New recruit lead: @new\\_one/);
});
