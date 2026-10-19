#!/usr/bin/env node
/**
 * Live end-to-end check of every method in spec/methods.json against https://api.tik.tools.
 *
 *   TIKTOOLS_API_KEY=<key> node e2e/e2e.mjs            (after npm run build)
 *
 * The key is read from the environment only and never printed. The run adapts to the key's plan:
 * a method the plan includes must return the documented shape; a method above the plan must fail
 * with PlanRequiredError (or the documented handshake refusal for the firehose). Write calls create
 * a temporary roster and webhook and delete them again. Exit code 1 on any failure.
 * Run it once per plan you want to cover; `getAccount().tier` tells you which plan a key is on.
 */
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgencyClient, PlanRequiredError, NotFoundError, verifyWebhook, signWebhookPayload, toDiscordMessage, isFreeToJoin,
} from '../dist/index.mjs';

const apiKey = process.env.TIKTOOLS_API_KEY;
if (!apiKey) {
  console.error('Set TIKTOOLS_API_KEY (see the header of this file).');
  process.exit(2);
}
const baseUrl = process.env.TIKTOOLS_BASE_URL || 'https://api.tik.tools';
const region = process.env.E2E_REGION || 'UK+';
const spec = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'methods.json'), 'utf8'));
const RANK = { demo: -1, sandbox: 0, basic: 1, pro: 2, ultra: 3, agency_global: 4, admin: 5 };

const requests = [];
const countingFetch = (url, init) => { requests.push(new URL(url).pathname); return fetch(url, init); };
const tt = new AgencyClient({ apiKey, baseUrl, maxRetries: 6, fetch: countingFetch, logger: () => {} });

const results = [];
const covered = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(cond, message) { if (!cond) throw new Error(message); }
const isArr = Array.isArray;

// Stay under the per-minute limit (Sandbox is 20/min) instead of leaning on 429 retries.
async function pace() {
  const rl = tt.lastRateLimit;
  if (rl && rl.remaining <= 1 && rl.resetAt > Date.now()) await sleep(rl.resetAt - Date.now() + 500);
}

const account = await tt.getAccount();
const tier = account.tier;
const rank = RANK[tier] ?? 0;
console.log(`plan: ${tier} (bulk ${account.bulk_check_limit}, ${account.api?.limit}/min) base ${baseUrl}\n`);
const allows = (minTier) => rank >= RANK[minTier];

async function run(name, fn, assertShape, { gated, notFoundOk } = {}) {
  covered.add(name);
  const m = spec.methods.find((x) => x.name === name);
  if (!m) throw new Error(`unknown method ${name}`);
  const expectGate = gated ?? !allows(m.minTier);
  await pace();
  const started = Date.now();
  try {
    const value = await fn();
    if (expectGate) {
      results.push({ name, ok: false, note: `expected PlanRequiredError on ${tier}, got data` });
    } else {
      assertShape?.(value);
      results.push({ name, ok: true, note: 'data' });
    }
    return value;
  } catch (err) {
    if (expectGate && err instanceof PlanRequiredError) {
      results.push({ name, ok: true, note: `gated: needs ${err.requiredTier ?? m.minTier}` });
    } else if (notFoundOk && err instanceof NotFoundError) {
      // Lower plans may still delete (to clean up after a downgrade); with nothing created there is nothing to find.
      results.push({ name, ok: true, note: 'nothing to delete (404), as expected without a created item' });
    } else {
      results.push({ name, ok: false, note: `${err.name}: ${err.message}`.slice(0, 220) });
    }
    return undefined;
  } finally {
    const r = results[results.length - 1];
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} ${String(Date.now() - started).padStart(5)}ms  ${r.note}`);
  }
}

// -- Account
covered.add('getAccount');
results.push({ name: 'getAccount', ok: typeof tier === 'string' && typeof account.api?.limit === 'number', note: 'data' });
console.log(`${results[0].ok ? 'PASS' : 'FAIL'}  getAccount`);

const regions = await run('listRegions', () => tt.listRegions(), (v) => {
  check(isArr(v) && v.length > 10, `expected many regions, got ${v?.length}`);
  check(typeof v[0].region === 'string' && typeof v[0].live_count === 'number', 'region row shape');
});

// -- Rankings (also gives us real handles)
const board = await run('leaderboard', () => tt.leaderboard({ region }), (v) => {
  check(isArr(v.entries) && v.entries.length > 0, 'entries');
  check(typeof v.entries[0].score === 'number', 'entry score');
});
const handles = (board?.entries ?? []).filter((e) => !e._masked && e.unique_id && !/\*/.test(e.unique_id)).map((e) => e.unique_id);
check(handles.length >= 3, 'need at least 3 unmasked handles from the daily board');
const [h1, h2, h3] = handles;

await run('globalLeaderboard', () => tt.globalLeaderboard({ top: 3 }), (v) => check(isArr(v.regions) && v.regions.length > 10, 'regions'));
await run('clubRankings', () => tt.clubRankings({ region }), (v) => check(isArr(v.entries), 'entries'));
await run('popularLive', () => tt.popularLive({ region }), (v) => check(isArr(v.entries), 'entries'));
await run('gamingRankings', () => tt.gamingRankings({ region }), (v) => check(isArr(v.entries) || isArr(v.games), 'entries or games'));
await run('liveCounts', () => tt.liveCounts(), (v) => check(typeof v.global_live === 'number' && v.regions && typeof v.regions === 'object', 'counts'));
await run('topGifters', () => tt.topGifters({ region, period: 'weekly', limit: 10 }), (v) => {
  check(isArr(v.entries), 'entries');
  if (v.entries[0]) check(typeof v.entries[0].diamonds === 'number', 'diamonds');
});

// -- Recruit
const divisions = await run('leagueDivisions', () => tt.leagueDivisions({ region }), (v) => {
  check(isArr(v.divisions) && v.divisions.length > 0, 'divisions');
  check(typeof v.divisions[0].label === 'string', 'division label');
});
const firstLeague = divisions?.divisions?.[0]?.label ?? 'A1';
const firstClass = divisions?.divisions?.[0]?.classType;
await run('leagueMembers', () => tt.leagueMembers({ region, league: firstLeague }), (v) => {
  check(isArr(v.entries) && v.entries.length > 0, 'entries');
  check('score' in v.entries[0] && 'rank' in v.entries[0], 'entry shape');
});
await run('droppedOutCreators', () => tt.droppedOutCreators({ region }), (v) => check(isArr(v.movers) && typeof v.cutoff_score === 'number', 'movers'));
await run('leagueDropouts', () => tt.leagueDropouts({ region }), (v) => check(isArr(v.divisions), 'divisions'));
await run('gamingDropouts', () => tt.gamingDropouts({ region }), (v) => check(v && typeof v === 'object', 'object'));
await run('boardHistory', () => tt.boardHistory({ region, board: 'leaderboard', window: '6h', mode: 'movers', limit: 10 }), (v) => {
  check(v.mode === 'movers' && isArr(v.movers) && isArr(v.entered), 'movers shape');
});
if (firstClass !== undefined) {
  // League history needs classType; same method, exercised once more for the validation path.
  await tt.boardHistory({ region, board: 'league', classType: firstClass, window: '2h', mode: 'snapshot', limit: 5 }).catch(() => null);
}

const recruit = await run('findCreatorsToRecruit', () => tt.findCreatorsToRecruit({ region: 'UK', limit: 5 }), (v) => {
  check(isArr(v.results) && typeof v.total === 'number' && typeof v.total_pages === 'number', 'page shape');
  if (v.results[0]) check(typeof v.results[0].username === 'string' && typeof v.results[0].backstage === 'string', 'row shape');
});
await run('iterCreatorsToRecruit', async () => {
  const rows = [];
  for await (const r of tt.iterCreatorsToRecruit({ region: 'UK', limit: 3, maxPages: 2 })) rows.push(r);
  return rows;
}, (rows) => check(isArr(rows) && rows.length > 0 && rows.length <= 6, `expected 1-6 rows, got ${rows.length}`));
covered.add('isFreeToJoin');
results.push({ name: 'isFreeToJoin', ok: isFreeToJoin({ backstage: 'eligible' }) && !isFreeToJoin(recruit?.results?.find((r) => r.backstage !== 'eligible') ?? { backstage: 'unchecked' }), note: 'local' });

await run('newCreators', () => tt.newCreators({ region: 'UK', limit: 5 }), (v) => {
  check(isArr(v.results) && typeof v.total === 'number', 'page shape');
  if (v.results[0]) check(typeof v.results[0].first_seen === 'string', 'first_seen');
});
await run('iterNewCreators', async () => {
  const rows = [];
  for await (const r of tt.iterNewCreators({ region: 'UK+', limit: 2, maxPages: 2 })) rows.push(r);
  return rows;
}, (rows) => check(rows.length > 0 && rows.length <= 4, `expected 1-4 rows, got ${rows.length}`));

// -- Vet
const core = await run('getCreator', () => tt.getCreator(h1), (v) => check(v.found === true && typeof v.uniqueId === 'string', 'found creator'));
await run('getCreatorProfile', () => tt.getCreatorProfile(h1), (v) => check(v.profile && typeof v.profile.uniqueId === 'string', 'profile'));
await run('findRenamedCreator', () => tt.findRenamedCreator(h1), (v) => check(typeof v.status === 'string', 'status'));
const profileId = core?.userId ?? core?.user_id;
const probeId = String(profileId ?? '6812345678901234567');
await run('resolveUserIds', () => tt.resolveUserIds([probeId]), (v) => check(v && typeof v === 'object' && v[probeId] && v[probeId].userId === probeId, 'map keyed by id'));

// -- Live
await run('isLive', () => tt.isLive(h1), (v) => check(v === true || v === false || v === null, 'boolean or null'));
await run('isLiveDetailed', () => tt.isLiveDetailed(h2), (v) => check(v.unique_id === h2.toLowerCase() || typeof v.unique_id === 'string', 'unique_id'));
await run('whoIsLive', () => tt.whoIsLive([h1, h2, h3]), (v) => {
  check(v.rows.length === 3, `expected 3 rows, got ${v.rows.length}`);
  check(v.live.length + v.offline.length + v.unknown.length === 3, 'every row classified');
});
await run('watchLive', async () => {
  const before = requests.length;
  const errors = [];
  const w = tt.watchLive([h1, h2], { intervalSeconds: 30, onError: (e) => errors.push(e) });
  for (let i = 0; i < 60 && requests.length === before; i++) await sleep(250);
  await sleep(1500);
  w.stop();
  if (errors.length) throw errors[0];
  return requests.slice(before);
}, (paths) => check(paths.some((p) => p === '/webcast/bulk_live_check' || p === '/webcast/live_status'), 'watchLive made a live check'));

// -- Creator stats (Agency)
const statsHandle = h1;
await run('getCreatorSummary', () => tt.getCreatorSummary(statsHandle, { days: 7 }), (v) => check(v.gifts && typeof v.gifts.diamonds === 'number' && v.battles, 'summary shape'));
await run('getDailyDiamonds', () => tt.getDailyDiamonds(statsHandle, { days: 7 }), (v) => {
  check(typeof v.totalDiamonds === 'number' && isArr(v.buckets), 'daily shape');
  if (v.buckets[0]) check(typeof v.buckets[0].complete === 'boolean', 'complete flag');
});
await run('getCreatorGifters', () => tt.getCreatorGifters(statsHandle, { days: 7, limit: 5 }), (v) => check(isArr(v.gifters), 'gifters'));
await run('getCreatorGifts', () => tt.getCreatorGifts(statsHandle, { days: 7, limit: 5 }), (v) => check(isArr(v.gifts), 'gifts'));
await run('getCreatorBattles', () => tt.getCreatorBattles(statsHandle, { days: 7, limit: 5 }), (v) => check(isArr(v.battles), 'battles'));
await run('getCreatorChat', () => tt.getCreatorChat(statsHandle, { days: 1, limit: 5 }), (v) => check(v && typeof v === 'object' && v.type === 'chat', 'chat response'));
await run('getCreatorActivity', () => tt.getCreatorActivity(statsHandle, { days: 7 }), (v) => check(v && v.type === 'activity', 'activity response'));
await run('getCreatorGoals', () => tt.getCreatorGoals(statsHandle, { days: 7, limit: 5 }), (v) => check(v && v.type === 'goals', 'goals response'));

// -- Rosters (Agency): temporary roster, removed at the end
let rosterId = null;
try {
  await run('listRosters', () => tt.listRosters(), (v) => check(isArr(v.lists) && typeof v.maxLists === 'number', 'index shape'));
  const created = await run('createRoster', () => tt.createRoster(`sdk-e2e-${Date.now()}`), (v) => check(v.ok === true && typeof v.id === 'string', 'created'));
  rosterId = created?.id ?? null;
  const rid = rosterId ?? 'sdk-e2e-missing';
  await run('addToRoster', () => tt.addToRoster(rid, [h1, h2]), (v) => check(v.ok === true && v.changed === 2, `changed ${v.changed}`));
  await run('getRoster', () => tt.getRoster(rid), (v) => check(isArr(v.creators) && v.creators.length === 2, `members ${v.creators?.length}`));
  await run('rosterDiamonds', () => tt.rosterDiamonds(rid, { days: 7 }), (v) => {
    check(typeof v.totalDiamonds === 'number' && v.creators.length + v.failed.length === 2, 'two creators accounted for');
    check(v.failed.length === 0, `failed: ${JSON.stringify(v.failed)}`);
  });
  await run('removeFromRoster', () => tt.removeFromRoster(rid, [h2]), (v) => check(v.ok === true && v.action === 'remove', 'removed'));
} finally {
  await run('deleteRoster', () => tt.deleteRoster(rosterId ?? 'sdk-e2e-missing'), (v) => check(v.ok === true, 'deleted'));
}

// -- Eligibility (Agency)
await run('getEligibility', () => tt.getEligibility([h1, h2]), (v) => check(v.verdicts && typeof v.verdicts === 'object', 'verdicts object'));
await run('getEligibilityAccounts', () => tt.getEligibilityAccounts(), (v) => check(isArr(v.accounts) && typeof v.rosterTotal === 'number', 'accounts shape'));

// -- Webhooks (Basic): temporary webhook, removed at the end
let webhookId = null;
const ownSecret = `sdk_e2e_${Date.now()}_secret`;
try {
  await run('listWebhooks', () => tt.listWebhooks(), (v) => check(isArr(v.webhooks) && v.limits && typeof v.limits.maxTargets === 'number', 'list shape'));
  const created = await run('createWebhook', () => tt.createWebhook({
    url: 'https://example.com/tiktools-sdk-e2e', events: ['live.start'], creators: [h1], secret: ownSecret, name: 'sdk e2e (temporary)',
  }), (v) => check(v.ok === true && typeof v.webhook?.id === 'string' && v.secret === `whsec_${ownSecret}`, 'created with own secret'));
  webhookId = created?.webhook?.id ?? null;
  const wid = webhookId ?? '00000000-0000-0000-0000-000000000000';
  await run('updateWebhook', () => tt.updateWebhook(wid, { events: ['live.start', 'live.end'], active: false }), (v) => {
    check(v.ok === true && v.webhook.event_types.includes('live.end'), 'updated events');
  });
  const tested = await run('testWebhook', () => tt.testWebhook(wid), (v) => check(typeof v.ok === 'boolean' && v.sent && typeof v.sent.signature === 'string', 'test result with signature'));
  // The signature the server just produced must verify with the secret we chose.
  covered.add('verifyWebhook');
  if (tested?.sent?.payload) {
    const raw = typeof tested.sent.payload === 'string' ? tested.sent.payload : JSON.stringify(tested.sent.payload);
    const header = tested.sent.signature ?? tested.sent.headers?.['X-Tiktool-Signature'];
    try {
      const ev = await verifyWebhook(raw, header, ownSecret);
      results.push({ name: 'verifyWebhook', ok: ev.event === 'live.start', note: 'verified a real server signature' });
    } catch (err) {
      results.push({ name: 'verifyWebhook', ok: false, note: `server signature did not verify: ${err.message}` });
    }
  } else {
    const raw = JSON.stringify({ event_id: 'e', event: 'live.start', occurred_at: new Date().toISOString(), creator: { unique_id: h1 }, live: { room_id: '1', started_at: '', live_url: '' } });
    const ev = await verifyWebhook(raw, await signWebhookPayload(raw, ownSecret), ownSecret);
    results.push({ name: 'verifyWebhook', ok: ev.event === 'live.start', note: 'local signature (webhooks not on this plan)' });
  }
  console.log(`${results.at(-1).ok ? 'PASS' : 'FAIL'}  verifyWebhook            ${results.at(-1).note}`);
  covered.add('toDiscordMessage');
  const msg = toDiscordMessage({ event_id: 'e', event: 'live.start', occurred_at: '', creator: { unique_id: h1 }, live: { room_id: '1', started_at: '', live_url: `https://www.tiktok.com/@${h1}/live` } });
  results.push({ name: 'toDiscordMessage', ok: msg.content.includes('is LIVE'), note: 'local' });
} finally {
  await run('deleteWebhook', () => tt.deleteWebhook(webhookId ?? '00000000-0000-0000-0000-000000000000'), (v) => check(v.ok === true, 'deleted'), { notFoundOk: !webhookId });
}

// -- Firehose (Agency + active subscription)
covered.add('streamBigGifts');
const fhMin = spec.methods.find((m) => m.name === 'streamBigGifts').minTier;
if (allows(fhMin)) {
  const outcome = await new Promise((resolve) => {
    let alerts = 0;
    const timer = setTimeout(() => { h.close(); resolve({ ok: false, note: 'no ready frame within 20s' }); }, 20000);
    const h = tt.streamBigGifts({ mode: 'global', maxFailedConnects: 1, onReady: () => {
      setTimeout(() => { clearTimeout(timer); h.close(); resolve({ ok: true, note: `ready, ${alerts} alerts in 8s` }); }, 8000);
    }, onError: (e) => { clearTimeout(timer); h.close(); resolve({ ok: false, note: e.message }); } }, () => { alerts++; });
  });
  results.push({ name: 'streamBigGifts', ...outcome });
} else {
  // Browsers and Node's global WebSocket hide the refusal status, so read it from a raw upgrade request.
  const status = await new Promise((resolve) => {
    const u = new URL(`/firehose/gifters?apiKey=${encodeURIComponent(apiKey)}`, baseUrl);
    const req = httpsRequest(u, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('response', (res) => { resolve(res.statusCode); res.resume(); });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
    req.on('error', () => resolve(0));
    req.end();
  });
  results.push({ name: 'streamBigGifts', ok: status === 403 || status === 402, note: `gated: handshake HTTP ${status}` });
}
console.log(`${results.at(-1).ok ? 'PASS' : 'FAIL'}  streamBigGifts           ${results.at(-1).note}`);

// -- Coverage and summary
const missing = spec.methods.map((m) => m.name).filter((n) => !covered.has(n));
for (const n of missing) results.push({ name: n, ok: false, note: 'not exercised by the E2E' });
const failed = results.filter((r) => !r.ok);
const gated = results.filter((r) => r.ok && r.note.startsWith('gated'));
console.log(`\n${results.length - failed.length}/${results.length} passed on plan ${tier} (${gated.length} gated as documented, ${requests.length} requests)`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name}: ${f.note}`);
  process.exit(1);
}
