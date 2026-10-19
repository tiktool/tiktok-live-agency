import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgencyClient, AuthError, PlanRequiredError, NotFoundError, RosterLimitError, ValidationError,
  RateLimitError, ServerError, TikToolsError, isFreeToJoin,
} from '../dist/index.mjs';
import { mockFetch, quiet } from './helpers.mjs';

const client = (fetch, extra = {}) => new AgencyClient({ apiKey: 'tk_test', fetch, logger: quiet, ...extra });

test('sends x-api-key, drops empty query values and joins arrays', async () => {
  const f = mockFetch([{ body: { status_code: 0, entries: [] } }]);
  await client(f).leagueMembers({ region: 'UK+', league: ['A1', 'A2'] });
  const { url, method, headers } = f.calls[0];
  assert.equal(method, 'GET');
  assert.equal(url.origin + url.pathname, 'https://api.tik.tools/webcast/leaderboard/league_divisions');
  assert.equal(url.searchParams.get('league'), 'A1,A2');
  assert.equal(url.searchParams.has('account_region'), false);
  assert.equal(headers['x-api-key'], 'tk_test');
});

test('maps error statuses to typed errors', async () => {
  const cases = [
    [401, { error: 'Invalid API key' }, AuthError],
    [403, { error: 'Evaluation period ended' }, AuthError],
    [403, { error: 'x', required_tier: 'pro', current_tier: 'sandbox', upgrade_url: 'https://tik.tools/pricing' }, PlanRequiredError],
    [404, { error: 'not found' }, NotFoundError],
    [409, { error: 'list limit reached (50)' }, RosterLimitError],
    [400, { error: 'bad' }, ValidationError],
  ];
  for (const [status, body, Type] of cases) {
    const f = mockFetch([{ status, body }]);
    await assert.rejects(client(f).listRosters(), (e) => e instanceof Type && e instanceof TikToolsError && e.status === status);
  }
});

test('PlanRequiredError carries tiers, falling back to the method minimum', async () => {
  const f = mockFetch([
    { status: 403, body: { error: 'Pro tier', required_tier: 'pro', current_tier: 'sandbox' } },
    { status: 403, body: { status_code: -1, error: 'Event history is an Agency-tier feature.' } },
  ]);
  const tt = client(f);
  await assert.rejects(tt.getCreatorProfile('x'), (e) => e.requiredTier === 'pro' && e.currentTier === 'sandbox' && e.upgradeUrl.includes('pricing'));
  await assert.rejects(tt.getCreatorSummary('x'), (e) => e instanceof PlanRequiredError && e.requiredTier === 'agency_global');
});

test('retries 429 and 503 on reads, honouring retry_after', async () => {
  const f = mockFetch([
    { status: 429, body: { error: 'slow down', retry_after: 0.01 } },
    { status: 503, body: { error: 'busy' } },
    { body: { status_code: 0, global_live: 5, regions: {} } },
  ]);
  const res = await client(f).liveCounts();
  assert.equal(res.global_live, 5);
  assert.equal(f.calls.length, 3);
});

test('does not wait on a long retry_after and does not retry writes', async () => {
  const long = mockFetch([{ status: 429, body: { error: 'daily quota', retry_after: 3600 } }]);
  await assert.rejects(client(long).liveCounts(), (e) => e instanceof RateLimitError && e.retryAfter === 3600);
  assert.equal(long.calls.length, 1);

  const write = mockFetch([{ status: 503, body: { error: 'busy' } }]);
  await assert.rejects(client(write).createRoster('Scouting'), ServerError);
  assert.equal(write.calls.length, 1);
});

test('HTTP 200 with a negative status_code raises', async () => {
  const f = mockFetch([{ body: { status_code: -1, error: 'upstream failed' } }]);
  await assert.rejects(client(f).liveCounts(), (e) => e instanceof TikToolsError && e.message === 'upstream failed');
});

test('captures rate limit headers, else the body rate_limit', async () => {
  const f = mockFetch([
    { body: { status_code: 0, regions: {} }, headers: { 'X-RateLimit-Limit': '120', 'X-RateLimit-Remaining': '7', 'X-RateLimit-Reset': '1792427500' } },
    { body: { status_code: 0, results: [], total_pages: 0, rate_limit: { limit: 60000, remaining: 59999, reset: 1792430000 } } },
  ]);
  const tt = client(f);
  await tt.liveCounts();
  assert.deepEqual(tt.lastRateLimit, { limit: 120, remaining: 7, resetAt: 1792427500000 });
  await tt.findCreatorsToRecruit({ region: 'UK' });
  assert.equal(tt.lastRateLimit.limit, 60000);
});

test('getAccount unwraps data and caches for 5 minutes', async () => {
  const f = mockFetch([{ body: { status_code: 0, data: { tier: 'pro', bulk_check_limit: 50, api: {}, websocket: {} } } }]);
  const tt = client(f);
  assert.equal((await tt.getAccount()).tier, 'pro');
  assert.equal((await tt.getAccount()).tier, 'pro');
  assert.equal(f.calls.length, 1);
});

test('whoIsLive chunks by plan size and never counts a failed check as offline', async () => {
  const rows = (ids) => ids.map((id, i) => ({ unique_id: id, is_live: i === 0 ? true : i === 1 ? false : null, check_failed: i === 2 }));
  const f = mockFetch([
    { body: { status_code: 0, data: { tier: 'basic', bulk_check_limit: 3, api: {}, websocket: {} } } },
    (url, init) => ({ body: { status_code: 0, data: rows(JSON.parse(init.body).unique_ids) } }),
    (url, init) => ({ body: { status_code: 0, data: rows(JSON.parse(init.body).unique_ids) } }),
  ]);
  const res = await client(f).whoIsLive(['@A', 'b', 'c', 'd', 'a']);
  assert.equal(f.calls[1].body.unique_ids.length, 3);
  assert.deepEqual(f.calls[2].body.unique_ids, ['d']);
  assert.equal(f.calls[1].body.confirm_negatives, undefined);
  assert.deepEqual(res.live.map((r) => r.unique_id), ['a', 'd']);
  assert.deepEqual(res.offline.map((r) => r.unique_id), ['b']);
  assert.deepEqual(res.unknown.map((r) => r.unique_id), ['c']);
});

test('whoIsLive on Sandbox explains the per-creator alternative', async () => {
  const f = mockFetch([{ status: 403, body: { error: 'Basic-tier endpoint', required_tier: 'basic' } }]);
  await assert.rejects(client(f).whoIsLive(['a'], { chunkSize: 10 }), (e) => e instanceof PlanRequiredError && /isLive/.test(e.message));
});

test('isLive returns null when the API cannot say', async () => {
  const f = mockFetch([
    { body: { status_code: 0, data: { unique_id: 'a', is_live: true, live_status: 'live', room_id: '1' } } },
    { body: { status_code: 0, data: { unique_id: 'a', is_live: null, live_status: 'unknown', room_id: null } } },
    { body: { status_code: 0, data: { unique_id: 'a', is_live: false, room_id: null } } },
  ]);
  const tt = client(f);
  assert.equal(await tt.isLive('a'), true);
  assert.equal(await tt.isLive('a'), null);
  assert.equal(await tt.isLive('a'), false);
  assert.equal(f.calls[0].url.searchParams.get('unique_id'), 'a');
});

test('addToRoster chunks by 200 and sums changed', async () => {
  const handles = Array.from({ length: 450 }, (_, i) => `c${i}`);
  const reply = (url, init) => ({ body: { ok: true, id: 'L1', action: 'add', changed: JSON.parse(init.body).uniqueIds.length, memberCount: 9 } });
  const f = mockFetch([reply, reply, reply]);
  const res = await client(f).addToRoster('L1', handles);
  assert.equal(f.calls.length, 3);
  assert.equal(res.changed, 450);
  assert.equal(f.calls[0].body.action, 'add');
});

test('createWebhook maps friendly names to API fields', async () => {
  const f = mockFetch([{ body: { ok: true, webhook: { id: 'w' }, secret: 'whsec_x' } }]);
  await client(f).createWebhook({ url: 'https://x.dev/hook', events: ['live.start'], rosters: ['L1'], creators: ['@Bob'], bearerToken: 't', secret: 'my_secret_value_123' });
  assert.deepEqual(f.calls[0].body, { target_url: 'https://x.dev/hook', event_types: ['live.start'], creators: ['bob'], lists: ['L1'], secret: 'my_secret_value_123', bearer_token: 't' });
  await assert.rejects(async () => client(mockFetch([])).createWebhook({ url: 'https://x.dev', events: [] }), ValidationError);
});

test('boardHistory needs classType for the league board', () => {
  assert.throws(() => client(mockFetch([])).boardHistory({ region: 'UK+', board: 'league' }), ValidationError);
});

test('newCreators retries a plain country code as its "+" cluster', async () => {
  const f = mockFetch([
    { status: 404, body: { status_code: 1, error: 'No recruit pool for region UK', available_regions: ['UK+', 'DE'] } },
    { body: { status_code: 0, region: 'UK+', results: [], total_pages: 0 } },
  ]);
  const res = await client(f).newCreators({ region: 'UK' });
  assert.equal(res.region, 'UK+');
  assert.equal(f.calls[1].url.searchParams.get('region'), 'UK+');
});

test('iterCreatorsToRecruit walks pages until total_pages', async () => {
  const page = (n) => ({ body: { status_code: 0, page: n, total_pages: 2, results: [{ username: `p${n}`, backstage: n === 1 ? 'eligible' : 'unchecked' }] } });
  const f = mockFetch([page(1), page(2)]);
  const got = [];
  for await (const row of client(f).iterCreatorsToRecruit({ region: 'UK' })) got.push(row);
  assert.deepEqual(got.map((r) => r.username), ['p1', 'p2']);
  assert.equal(f.calls[0].url.searchParams.get('limit'), '100');
  assert.equal(isFreeToJoin(got[0]), true);
  assert.equal(isFreeToJoin(got[1]), false);
});

test('rosterDiamonds totals and sorts, recording per-creator failures', async () => {
  const daily = (url) => {
    const c = url.searchParams.get('creator');
    if (c === 'bad') return { status: 500, body: { error: 'boom' } };
    return { body: { creator: c, type: 'daily', totalDiamonds: c === 'a' ? 10 : 30, completeDays: 7, incompleteDays: 0, buckets: [] } };
  };
  const f = mockFetch([daily, daily, daily, daily, daily]);
  const res = await client(f, { maxRetries: 0 }).rosterDiamonds(['a', 'b', 'bad'], { days: 7, concurrency: 2 });
  assert.equal(res.totalDiamonds, 40);
  assert.deepEqual(res.creators.map((c) => c.uniqueId), ['b', 'a']);
  assert.equal(res.failed[0].uniqueId, 'bad');
});

test('refuses to run in a browser unless explicitly allowed', () => {
  globalThis.window = { document: {} };
  try {
    assert.throws(() => new AgencyClient({ apiKey: 'tk', fetch: mockFetch([]) }), /browser/);
    assert.doesNotThrow(() => new AgencyClient({ apiKey: 'tk', fetch: mockFetch([]), dangerouslyAllowBrowser: true }));
  } finally {
    delete globalThis.window;
  }
});

test('reads TIKTOOLS_API_KEY from the environment', async () => {
  process.env.TIKTOOLS_API_KEY = 'tk_env';
  try {
    const f = mockFetch([{ body: { status_code: 0, regions: {} } }]);
    await new AgencyClient({ fetch: f }).liveCounts();
    assert.equal(f.calls[0].headers['x-api-key'], 'tk_env');
  } finally {
    delete process.env.TIKTOOLS_API_KEY;
  }
});

test('request() reaches unwrapped endpoints', async () => {
  const f = mockFetch([{ body: { status_code: 0, data: [] } }]);
  await client(f).request('GET', '/webcast/gift_info', { query: { region: 'US' } });
  assert.equal(f.calls[0].url.pathname, '/webcast/gift_info');
});
