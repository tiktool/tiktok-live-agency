import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTracker, classifyRows, AgencyClient } from '../dist/index.mjs';
import { mockFetch, quiet } from './helpers.mjs';

const poll = (live = [], offline = [], unknown = []) => classifyRows([
  ...live.map((id) => ({ unique_id: id, is_live: true, room_id: `r_${id}` })),
  ...offline.map((id) => ({ unique_id: id, is_live: false })),
  ...unknown.map((id) => ({ unique_id: id, is_live: null, check_failed: true })),
]);

test('first poll seeds state without firing', () => {
  const t = new LiveTracker();
  assert.deepEqual(t.update(poll(['a'], ['b'])), []);
  assert.equal(t.isLive('a'), true);
});

test('fires live when a creator comes online', () => {
  const t = new LiveTracker();
  t.update(poll([], ['a']));
  const ev = t.update(poll(['a']));
  assert.equal(ev.length, 1);
  assert.deepEqual({ type: ev[0].type, creator: ev[0].creator, room_id: ev[0].room_id }, { type: 'live', creator: 'a', room_id: 'r_a' });
});

test('an unknown check never flips state', () => {
  const t = new LiveTracker();
  t.update(poll(['a']));
  assert.deepEqual(t.update(poll([], [], ['a'])), []);
  assert.equal(t.isLive('a'), true);
});

test('end fires only after two offline polls in a row', () => {
  const t = new LiveTracker();
  t.update(poll(['a']));
  assert.deepEqual(t.update(poll([], ['a'])), []);
  const ev = t.update(poll([], ['a']));
  assert.equal(ev[0].type, 'end');
  assert.equal(ev[0].room_id, 'r_a');
  assert.deepEqual(t.update(poll([], ['a'])), []);
});

test('a live poll between offline polls resets the end streak', () => {
  const t = new LiveTracker();
  t.update(poll(['a']));
  t.update(poll([], ['a']));
  assert.deepEqual(t.update(poll(['a'])), []);
  assert.deepEqual(t.update(poll([], ['a'])), []);
});

test('watchLive falls back to per-creator checks on Sandbox and stops cleanly', async () => {
  const status = (live) => ({ body: { status_code: 0, data: { unique_id: 'a', is_live: live, live_status: live ? 'live' : 'offline', room_id: live ? '9' : null } } });
  const f = mockFetch([
    { body: { status_code: 0, data: { tier: 'sandbox', bulk_check_limit: 0, api: {}, websocket: {} } } },
    { status: 403, body: { error: 'Basic-tier endpoint', required_tier: 'basic' } },
    status(false),
  ]);
  const tt = new AgencyClient({ apiKey: 'tk', fetch: f, logger: quiet });
  const watcher = tt.watchLive(['a'], { intervalSeconds: 30, onError: (e) => { throw e; } });
  await new Promise((r) => setTimeout(r, 100));
  watcher.stop();
  assert.equal(f.calls[2].url.pathname, '/webcast/live_status');
  assert.equal(f.remaining(), 0);
});
