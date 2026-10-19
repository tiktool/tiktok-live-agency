import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { streamBigGifts, firehoseUrl } from '../dist/firehose.mjs';
import { PlanRequiredError } from '../dist/index.mjs';

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    FakeSocket.instances.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  open() { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: 'ready', filter: { mode: 'global' } }) }); }
  frame(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

test('builds the firehose URL with the filter', () => {
  const u = new URL(firehoseUrl('https://api.tik.tools', 'tk', { mode: 'region', region: 'UK+', minDiamonds: 5000 }));
  assert.equal(u.protocol, 'wss:');
  assert.equal(u.pathname, '/firehose/gifters');
  assert.equal(u.searchParams.get('region'), 'UK+');
  assert.equal(u.searchParams.get('min_diamonds'), '5000');
});

test('league mode works without a region', () => {
  const u = new URL(firehoseUrl('https://api.tik.tools', 'tk', { mode: 'league', league: 'A1' }));
  assert.equal(u.searchParams.get('mode'), 'league');
  assert.equal(u.searchParams.get('league'), 'A1');
  assert.equal(u.searchParams.has('region'), false);
});

test('delivers alerts, sends filter updates and closes', () => {
  FakeSocket.instances = [];
  const alerts = [];
  let ready = null;
  const h = streamBigGifts({ apiKey: 'tk', WebSocket: FakeSocket, onReady: (f) => { ready = f; } }, (a) => alerts.push(a));
  const ws = FakeSocket.instances[0];
  ws.open();
  ws.frame({ type: 'gifter_alert', ts: 't', gifter: { username: 'g' }, creator: { uniqueId: 'c' }, gift: { name: 'Lion', totalDiamonds: 29999 } });
  ws.frame({ type: 'filter_updated' });
  h.updateFilter({ mode: 'league', league: 'A1' });
  h.close();
  assert.deepEqual(ready, { mode: 'global' });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].gift.totalDiamonds, 29999);
  assert.deepEqual(ws.sent[0], { type: 'update_filter', mode: 'league', league: 'A1' });
  assert.equal(FakeSocket.instances.length, 1);
});

test('a refused upgrade with 403 reports PlanRequiredError and stops reconnecting', async () => {
  FakeSocket.instances = [];
  const errors = [];
  streamBigGifts({ apiKey: 'tk', WebSocket: FakeSocket, onError: (e) => errors.push(e) }, () => {});
  const ws = FakeSocket.instances[0];
  ws.emit('unexpected-response', {}, { statusCode: 403 });
  ws.onclose?.({ code: 1006 });
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(errors[0] instanceof PlanRequiredError);
  assert.equal(FakeSocket.instances.length, 1);
});

test('reconnects after a drop', async () => {
  FakeSocket.instances = [];
  const h = streamBigGifts({ apiKey: 'tk', WebSocket: FakeSocket }, () => {});
  FakeSocket.instances[0].open();
  FakeSocket.instances[0].onclose?.({ code: 1006 });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(FakeSocket.instances.length, 2);
  h.close();
});
