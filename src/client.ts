import {
  NetworkError, NotFoundError, PlanRequiredError, RateLimitError, TikToolsError, ValidationError,
  asBody, errorFromResponse,
} from './errors.js';
import { LiveTracker, MIN_WATCH_INTERVAL_SECONDS, classifyRows, jitter, normalizeHandle, uniqueHandles } from './live.js';
import { streamBigGifts as openFirehose, type FirehoseHandle, type StreamBigGiftsOptions } from './firehose.js';
import type {
  AccountInfo, BoardHistoryMovers, BoardHistorySnapshot, BoardResponse, CreateWebhookOptions, CreatorActivity,
  CreatorBattles, CreatorChat, CreatorCore, CreatorGifters, CreatorGifts, CreatorGoals, CreatorProfile, CreatorSummary,
  DailyDiamonds, EligibilityAccounts, EligibilityVerdicts, GamingMoversResponse, GifterAlert, GlobalLeaderboardResponse,
  LeaderboardResponse, LeagueDivisionsResponse, LeagueMembersResponse, LeagueMoversResponse, LiveCheckRow, LiveCounts,
  LiveEvent, LiveStatus, NewCreator, NewCreatorPage, RateLimitInfo, RecruitCandidate, RecruitPage, RegionInfo,
  RegionMoversResponse, RenameLookup, ResolvedUser, Roster, RosterChange, RosterCreated, RosterDiamonds, RosterIndex,
  StatsOptions, TopGiftersResponse, UpdateWebhookPatch, Webhook, WebhookCreated, WebhookList, WebhookTestResult,
  WhoIsLiveResult,
} from './types.js';

export const VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'https://api.tik.tools';

export interface AgencyClientOptions {
  /** Defaults to process.env.TIKTOOLS_API_KEY. Keep it on the server. */
  apiKey?: string;
  baseUrl?: string;
  /** Retries for 429, 502, 503, 504 and network errors on read calls. Default 2. */
  maxRetries?: number;
  /** Per-request timeout. Default 20000. */
  timeoutMs?: number;
  /** Custom fetch, for tests or proxies. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Allows construction in a browser page. Your key becomes visible to every visitor; do not do this in production. */
  dangerouslyAllowBrowser?: boolean;
  /** Receives one-line notices (fan-out cost warnings). Defaults to console.warn. Pass () => {} to silence. */
  logger?: (message: string) => void;
}

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  /** Retry on 429/5xx/network. Defaults to true for GET. */
  retry?: boolean;
  /** Fallback tier for PlanRequiredError when the server does not name one. */
  minTier?: string;
}

const RETRYABLE_POSTS = new Set(['/webcast/bulk_live_check', '/webcast/resolve_user_ids']);
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRY_WAIT_SECONDS = 60;
const ACCOUNT_CACHE_MS = 5 * 60 * 1000;
const ROSTER_CHUNK = 200;
const ELIGIBILITY_CHUNK = 300;
const FALLBACK_BULK_LIMIT = 10;
// -1 means no plan cap (internal keys); still keep each request a sane size.
const UNLIMITED_BULK_CHUNK = 200;
const FANOUT_WARN_AT = 50;
// Hourly route caps reset within the hour, so a page walk never waits longer than that.
const MAX_PAGE_WAIT_MS = 60 * 60 * 1000;

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

function envKey(): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.TIKTOOLS_API_KEY;
}

function isBrowser(): boolean {
  const g = globalThis as { window?: { document?: unknown } };
  return typeof g.window !== 'undefined' && typeof g.window.document !== 'undefined';
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function statsQuery(type: string, handle: string, opts: StatsOptions = {}): Record<string, unknown> {
  const creator = normalizeHandle(handle);
  if (!creator) throw new ValidationError('A creator handle is required', 400, null, '/webcast/agency/events');
  if ((opts.from && !opts.to) || (!opts.from && opts.to)) {
    throw new ValidationError('Pass both from and to, or neither', 400, null, '/webcast/agency/events');
  }
  return { creator, type, days: opts.from ? undefined : opts.days, from: opts.from, to: opts.to, limit: opts.limit };
}

/** True when a recruit row's last recorded Backstage verdict is eligible. It is not a live invite check. */
export function isFreeToJoin(row: { backstage?: string } | null | undefined): boolean {
  return row?.backstage === 'eligible';
}

export interface WatchLiveOptions {
  /** Seconds between polls. Minimum 30, default 60. */
  intervalSeconds?: number;
  onLive?: (event: LiveEvent) => void;
  onEnd?: (event: LiveEvent) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}

export interface WhoIsLiveOptions {
  /** Re-check offline rows against the room (slower, fewer false offlines). Server default applies when omitted. */
  confirmNegatives?: boolean;
  withTitles?: boolean;
  /** Creators per request. Defaults to your plan's bulk limit. */
  chunkSize?: number;
}

export class AgencyClient {
  readonly baseUrl: string;
  readonly maxRetries: number;
  readonly timeoutMs: number;
  /** Rate-limit state from the last response that carried it. */
  lastRateLimit: RateLimitInfo | null = null;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;
  private accountCache: { at: number; value: AccountInfo } | null = null;

  constructor(options: AgencyClientOptions = {}) {
    this.apiKey = options.apiKey ?? envKey();
    if (this.apiKey && isBrowser() && !options.dangerouslyAllowBrowser) {
      throw new TikToolsError(
        'AgencyClient is running in a browser, which would expose your API key to every visitor. ' +
        'Call it from server code (Next.js Route Handler or Server Component, Supabase Edge Function, an API route) instead.',
        0, null, '',
      );
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.timeoutMs = options.timeoutMs ?? 20000;
    const f = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) throw new TikToolsError('No global fetch found. Use Node 18 or newer, or pass { fetch }.', 0, null, '');
    this.fetchImpl = f;
    this.log = options.logger ?? ((m: string) => console.warn(`[tiktok-live-agency] ${m}`));
  }

  /** Calls any endpoint, including ones this SDK does not wrap yet. Returns the parsed JSON body. */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const verb = method.toUpperCase();
    const url = new URL(path.startsWith('/') ? path : `/${path}`, this.baseUrl + '/');
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const retry = options.retry ?? (verb === 'GET' || RETRYABLE_POSTS.has(url.pathname));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (!isBrowser()) headers['user-agent'] = `tiktok-live-agency/${VERSION}`;
    let payload: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), { method: verb, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (cause) {
        if (retry && attempt < this.maxRetries) { await sleep(this.backoffMs(attempt)); continue; }
        const timedOut = (cause as { name?: string })?.name === 'TimeoutError';
        throw new NetworkError(timedOut ? `Request timed out after ${this.timeoutMs} ms` : `Network error: ${(cause as Error)?.message ?? cause}`, url.pathname, cause);
      }

      const text = await res.text();
      let body: unknown = text;
      if (text) { try { body = JSON.parse(text); } catch { /* keep raw text */ } } else body = null;
      this.captureRateLimit(res, body);

      if (!res.ok) {
        const err = errorFromResponse(res.status, body, url.pathname, res.headers, options.minTier);
        if (retry && attempt < this.maxRetries && RETRYABLE_STATUS.has(res.status)) {
          const wait = err instanceof RateLimitError ? err.retryAfter : this.backoffMs(attempt) / 1000;
          if (wait <= MAX_RETRY_WAIT_SECONDS) { await sleep(wait * 1000 + Math.random() * 250); continue; }
        }
        if (!this.apiKey && res.status === 401) err.message = `${err.message}. Set TIKTOOLS_API_KEY or pass { apiKey }.`;
        throw err;
      }
      const sc = asBody(body).status_code;
      if (typeof sc === 'number' && sc < 0) {
        throw new TikToolsError(String(asBody(body).error ?? 'Request failed'), res.status, body, url.pathname);
      }
      return body as T;
    }
  }

  private backoffMs(attempt: number): number {
    return 500 * 2 ** attempt + Math.random() * 250;
  }

  private captureRateLimit(res: Response, body: unknown): void {
    const limit = Number(res.headers.get('x-ratelimit-limit'));
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (res.headers.get('x-ratelimit-limit') !== null && Number.isFinite(limit)) {
      this.lastRateLimit = { limit, remaining: Number.isFinite(remaining) ? remaining : 0, resetAt: Number.isFinite(reset) ? reset * 1000 : 0 };
      return;
    }
    const rl = asBody(body).rate_limit as { limit?: number; remaining?: number; reset?: number } | undefined;
    if (rl && typeof rl.limit === 'number') {
      this.lastRateLimit = { limit: rl.limit, remaining: rl.remaining ?? 0, resetAt: (rl.reset ?? 0) * 1000 };
    }
  }

  private get<T>(path: string, query?: Record<string, unknown>, minTier?: string): Promise<T> {
    return this.request<T>('GET', path, { query, minTier });
  }

  private unwrap<T>(body: unknown): T {
    const b = body as { data?: unknown };
    return (b && typeof b === 'object' && 'data' in b ? b.data : body) as T;
  }

  // -- Account

  /** Plan, per-minute limit, bulk check size and evaluation end. Cached for 5 minutes. */
  async getAccount(options: { refresh?: boolean } = {}): Promise<AccountInfo> {
    if (!options.refresh && this.accountCache && Date.now() - this.accountCache.at < ACCOUNT_CACHE_MS) return this.accountCache.value;
    const value = this.unwrap<AccountInfo>(await this.get('/webcast/rate_limits', undefined, 'sandbox'));
    this.accountCache = { at: Date.now(), value };
    return value;
  }

  /** Every ranked region: code, label and live count. */
  async listRegions(): Promise<RegionInfo[]> {
    const res = await this.get<GlobalLeaderboardResponse>('/webcast/leaderboard/global', { top: 1 }, 'sandbox');
    return (res.regions ?? []).map((r) => ({ region: r.region, region_label: r.region_label, live_count: r.live_count }));
  }

  // -- Find creators to recruit

  /** One page of recruit candidates. "UK" maps to "UK+" on the server. */
  findCreatorsToRecruit(opts: { region: string; accountRegion?: string; minScore?: number; page?: number; limit?: number }): Promise<RecruitPage> {
    return this.get('/webcast/eligible_creators', {
      region: opts.region, account_region: opts.accountRegion, min_score: opts.minScore, page: opts.page, limit: opts.limit,
    }, 'agency_global');
  }

  /** Yields every recruit candidate page by page. */
  async *iterCreatorsToRecruit(opts: { region: string; accountRegion?: string; minScore?: number; limit?: number; maxPages?: number }): AsyncGenerator<RecruitCandidate> {
    yield* this.paginate((page) => this.findCreatorsToRecruit({ ...opts, page, limit: opts.limit ?? 100 }), opts.maxPages);
  }

  /** Creators who recently entered a region's recruit pool, newest first. */
  async newCreators(opts: { region: string; since?: string; page?: number; limit?: number }): Promise<NewCreatorPage> {
    const query = { region: opts.region, since: opts.since, page: opts.page, limit: opts.limit };
    try {
      return await this.get<NewCreatorPage>('/webcast/creator_digest', query, 'agency_global');
    } catch (err) {
      // Board regions for UK, US, FR ... are clusters with a trailing "+"; retry once like eligible_creators does.
      const avail = (asBody((err as TikToolsError).body).available_regions ?? []) as string[];
      const alt = `${String(opts.region).toUpperCase()}+`;
      if (err instanceof NotFoundError && !opts.region.endsWith('+') && avail.includes(alt)) {
        return this.get<NewCreatorPage>('/webcast/creator_digest', { ...query, region: alt }, 'agency_global');
      }
      throw err;
    }
  }

  async *iterNewCreators(opts: { region: string; since?: string; limit?: number; maxPages?: number }): AsyncGenerator<NewCreator> {
    yield* this.paginate((page) => this.newCreators({ ...opts, page, limit: opts.limit ?? 100 }), opts.maxPages);
  }

  private async *paginate<R>(fetchPage: (page: number) => Promise<{ results: R[]; total_pages: number; rate_limit?: { remaining: number; reset: number } }>, maxPages?: number): AsyncGenerator<R> {
    for (let page = 1; ; page++) {
      const res = await fetchPage(page);
      for (const row of res.results ?? []) yield row;
      if (page >= (res.total_pages ?? 1) || (maxPages && page >= maxPages)) return;
      const rl = res.rate_limit;
      if (rl && rl.remaining <= 0 && rl.reset) {
        const wait = rl.reset * 1000 - Date.now();
        if (wait > 0) await sleep(Math.min(wait, MAX_PAGE_WAIT_MS));
      }
    }
  }

  /** League divisions in a region with member counts. */
  leagueDivisions(opts: { region: string }): Promise<LeagueDivisionsResponse> {
    return this.get('/webcast/leaderboard/league_divisions', { region: opts.region }, 'sandbox');
  }

  /** Creators in league divisions: league "A1", "A1,A2" or "all". Names hidden below Ultra. */
  leagueMembers(opts: { region: string; league: string | string[]; accountRegion?: string }): Promise<LeagueMembersResponse> {
    if (!opts.league || (Array.isArray(opts.league) && !opts.league.length)) {
      throw new ValidationError('league is required (for example "A1" or "all"); use leagueDivisions() to list them', 400, null, '/webcast/leaderboard/league_divisions');
    }
    return this.get('/webcast/leaderboard/league_divisions', { region: opts.region, league: opts.league, account_region: opts.accountRegion }, 'sandbox');
  }

  /** Creators who fell below a region's board cutoff recently. */
  droppedOutCreators(opts: { region: string }): Promise<RegionMoversResponse> {
    return this.get('/webcast/leaderboard/region_movers', { region: opts.region }, 'sandbox');
  }

  /** Per division, creators who dropped out of the league top 99. */
  leagueDropouts(opts: { region: string }): Promise<LeagueMoversResponse> {
    return this.get('/webcast/leaderboard/league_movers', { region: opts.region }, 'sandbox');
  }

  /** Gaming creators who fell off the gaming boards. Beta. */
  gamingDropouts(opts: { region: string }): Promise<GamingMoversResponse> {
    return this.get('/webcast/leaderboard/gaming_movers', { region: opts.region }, 'sandbox');
  }

  /** Board movers or a past snapshot. board "league" needs classType. */
  boardHistory(opts: {
    region: string; board?: 'leaderboard' | 'league' | 'gaming'; window?: '2h' | '6h' | '12h' | '24h' | '3d';
    mode?: 'movers' | 'snapshot'; classType?: number | string; limit?: number; at?: string;
  }): Promise<BoardHistoryMovers | BoardHistorySnapshot> {
    if (opts.board === 'league' && (opts.classType === undefined || opts.classType === '')) {
      throw new ValidationError('board "league" needs classType (from leagueDivisions)', 400, null, '/webcast/board_history');
    }
    return this.get('/webcast/board_history', {
      region: opts.region, board: opts.board, window: opts.window, mode: opts.mode, class_type: opts.classType, limit: opts.limit, at: opts.at,
    }, 'sandbox');
  }

  // -- Rankings and market

  /** A region's board. daily works on any key; weekly, gaming, shopping need Agency; league needs Ultra. */
  leaderboard(opts: { region?: string; type?: 'daily' | 'weekly' | 'league' | 'gaming' | 'shopping'; classType?: number | string } = {}): Promise<LeaderboardResponse> {
    return this.get('/webcast/leaderboard', { region: opts.region ?? 'US+', type: opts.type, class: opts.classType }, 'sandbox');
  }

  globalLeaderboard(opts: { top?: number } = {}): Promise<GlobalLeaderboardResponse> {
    return this.get('/webcast/leaderboard/global', { top: opts.top ?? 10 }, 'sandbox');
  }

  clubRankings(opts: { region: string }): Promise<BoardResponse> {
    return this.get('/webcast/leaderboard/teams', { region: opts.region }, 'sandbox');
  }

  popularLive(opts: { region: string }): Promise<BoardResponse> {
    return this.get('/webcast/leaderboard/popular', { region: opts.region }, 'sandbox');
  }

  gamingRankings(opts: { region: string }): Promise<BoardResponse> {
    return this.get('/webcast/leaderboard/gaming', { region: opts.region }, 'sandbox');
  }

  liveCounts(): Promise<LiveCounts> {
    return this.get('/webcast/live-counts', undefined, 'sandbox');
  }

  /** Biggest gifters in a region (or "GLOBAL"). Pro and up; names unmasked on Agency. */
  topGifters(opts: { region: string; period?: 'daily' | 'weekly' | 'monthly'; limit?: number }): Promise<TopGiftersResponse> {
    return this.get('/webcast/gifters/leaderboard', { region: opts.region, period: opts.period, limit: opts.limit }, 'pro');
  }

  // -- Vet a creator

  getCreator(handle: string): Promise<CreatorCore> {
    return this.get('/webcast/creator-core', { u: normalizeHandle(handle) }, 'sandbox');
  }

  async getCreatorProfile(handle: string): Promise<CreatorProfile> {
    return this.unwrap<CreatorProfile>(await this.get('/webcast/user_profile', { unique_id: normalizeHandle(handle) }, 'pro'));
  }

  async findRenamedCreator(handle: string): Promise<RenameLookup> {
    return this.unwrap<RenameLookup>(await this.get('/webcast/lookup_username', { username: normalizeHandle(handle) }, 'sandbox'));
  }

  /** Map of user id to { userId, username, nickname, avatarUrl }. */
  async resolveUserIds(ids: Array<string | number>): Promise<Record<string, ResolvedUser>> {
    const res = await this.request('POST', '/webcast/resolve_user_ids', { body: { user_ids: ids.map(String) }, minTier: 'basic' });
    return this.unwrap<Record<string, ResolvedUser>>(res);
  }

  // -- Creator stats (Agency)

  getCreatorSummary(handle: string, opts?: StatsOptions): Promise<CreatorSummary> {
    return this.get('/webcast/agency/events', statsQuery('summary', handle, opts), 'agency_global');
  }

  /** Diamonds per UTC day from captured gifts with a complete flag per day. A lower bound, not the Backstage payout figure. */
  getDailyDiamonds(handle: string, opts?: StatsOptions): Promise<DailyDiamonds> {
    return this.get('/webcast/agency/events', statsQuery('daily', handle, opts), 'agency_global');
  }

  getCreatorGifters(handle: string, opts?: StatsOptions): Promise<CreatorGifters> {
    return this.get('/webcast/agency/events', statsQuery('gifters', handle, opts), 'agency_global');
  }

  getCreatorGifts(handle: string, opts?: StatsOptions): Promise<CreatorGifts> {
    return this.get('/webcast/agency/events', statsQuery('gifts', handle, opts), 'agency_global');
  }

  getCreatorBattles(handle: string, opts?: StatsOptions): Promise<CreatorBattles> {
    return this.get('/webcast/agency/events', statsQuery('battles', handle, opts), 'agency_global');
  }

  /** Chat history. Only returns messages for creators on one of your rosters. */
  getCreatorChat(handle: string, opts?: StatsOptions): Promise<CreatorChat> {
    return this.get('/webcast/agency/events', statsQuery('chat', handle, opts), 'agency_global');
  }

  getCreatorActivity(handle: string, opts?: StatsOptions): Promise<CreatorActivity> {
    return this.get('/webcast/agency/events', statsQuery('activity', handle, opts), 'agency_global');
  }

  getCreatorGoals(handle: string, opts?: StatsOptions): Promise<CreatorGoals> {
    return this.get('/webcast/agency/events', statsQuery('goals', handle, opts), 'agency_global');
  }

  // -- Rosters (Agency)

  listRosters(): Promise<RosterIndex> {
    return this.get('/webcast/agency/lists', undefined, 'agency_global');
  }

  createRoster(name: string): Promise<RosterCreated> {
    const clean = String(name || '').trim();
    if (!clean) throw new ValidationError('Roster name is required', 400, null, '/webcast/agency/lists');
    return this.request('POST', '/webcast/agency/lists', { body: { name: clean.slice(0, 60) }, minTier: 'agency_global' });
  }

  getRoster(id: string, opts: { liveOnly?: boolean } = {}): Promise<Roster> {
    return this.get('/webcast/agency/list', { id, live_only: opts.liveOnly ? 1 : undefined }, 'agency_global');
  }

  deleteRoster(id: string): Promise<{ ok: boolean; deleted: boolean }> {
    return this.request('DELETE', '/webcast/agency/list', { query: { id }, minTier: 'agency_global' });
  }

  /** Adds creators. Gift and chat capture for them starts from this moment. */
  addToRoster(id: string, handles: string[]): Promise<RosterChange> {
    return this.changeRoster(id, handles, 'add');
  }

  removeFromRoster(id: string, handles: string[]): Promise<RosterChange> {
    return this.changeRoster(id, handles, 'remove');
  }

  private async changeRoster(id: string, handles: string[], action: 'add' | 'remove'): Promise<RosterChange> {
    const all = uniqueHandles(handles);
    if (!all.length) throw new ValidationError('At least one creator handle is required', 400, null, '/webcast/agency/list/members');
    let last: RosterChange | null = null;
    let changed = 0;
    for (const part of chunk(all, ROSTER_CHUNK)) {
      last = await this.request<RosterChange>('POST', '/webcast/agency/list/members', { body: { id, uniqueIds: part, action }, minTier: 'agency_global' });
      changed += Number(last.changed) || 0;
    }
    return { ...(last as RosterChange), changed };
  }

  /**
   * Diamonds per creator and in total, from getDailyDiamonds for each creator.
   * Costs one request per creator; there is no roster aggregate endpoint yet.
   */
  async rosterDiamonds(rosterIdOrHandles: string | string[], opts: { days?: number; concurrency?: number } = {}): Promise<RosterDiamonds> {
    const days = opts.days ?? 7;
    const handles = Array.isArray(rosterIdOrHandles)
      ? uniqueHandles(rosterIdOrHandles)
      : (await this.getRoster(rosterIdOrHandles)).creators.map((c) => normalizeHandle(c.uniqueId));
    if (handles.length > FANOUT_WARN_AT) {
      this.log(`rosterDiamonds: ${handles.length} creators = ${handles.length} requests. Cache the result instead of calling it on every page view.`);
    }
    const out: RosterDiamonds = { days, totalDiamonds: 0, creators: [], failed: [] };
    let next = 0;
    const worker = async () => {
      while (next < handles.length) {
        const uniqueId = handles[next++];
        try {
          const d = await this.getDailyDiamonds(uniqueId, { days });
          out.creators.push({ uniqueId, totalDiamonds: d.totalDiamonds ?? 0, completeDays: d.completeDays ?? 0, incompleteDays: d.incompleteDays ?? 0, buckets: d.buckets ?? [] });
        } catch (err) {
          if (err instanceof PlanRequiredError) throw err;
          out.failed.push({ uniqueId, error: (err as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, handles.length || 1)) }, worker));
    out.creators.sort((a, b) => b.totalDiamonds - a.totalDiamonds);
    out.totalDiamonds = out.creators.reduce((s, c) => s + c.totalDiamonds, 0);
    return out;
  }

  // -- Live status

  async isLiveDetailed(handle: string): Promise<LiveStatus> {
    const res = await this.get('/webcast/live_status', { unique_id: normalizeHandle(handle) }, 'demo');
    return this.unwrap<LiveStatus>(res);
  }

  /** true, false, or null when it could not be determined. Works with no key. */
  async isLive(handle: string): Promise<boolean | null> {
    const s = await this.isLiveDetailed(handle);
    if (s.is_live === true || s.is_live === false) return s.live_status === 'unknown' ? null : s.is_live;
    return null;
  }

  /** Splits creators into live, offline and unknown. Chunks to your plan's bulk size. Basic and up. */
  async whoIsLive(handles: string[], opts: WhoIsLiveOptions = {}): Promise<WhoIsLiveResult> {
    const all = uniqueHandles(handles);
    const result: WhoIsLiveResult = { live: [], offline: [], unknown: [], rows: [] };
    if (!all.length) return result;
    let size = opts.chunkSize;
    if (!size) {
      const acct = await this.getAccount().catch(() => null);
      const limit = acct?.bulk_check_limit ?? 0;
      size = limit === -1 ? UNLIMITED_BULK_CHUNK : limit > 0 ? limit : FALLBACK_BULK_LIMIT;
    }
    for (const part of chunk(all, size)) {
      let res: { data?: LiveCheckRow[]; partial_failure?: boolean };
      try {
        res = await this.request('POST', '/webcast/bulk_live_check', {
          body: { unique_ids: part, confirm_negatives: opts.confirmNegatives, with_titles: opts.withTitles },
          minTier: 'basic',
        });
      } catch (err) {
        if (err instanceof PlanRequiredError) {
          err.message = `${err.message} On Sandbox, check creators one at a time with isLive(handle) or use watchLive(), which does that for you.`;
        }
        throw err;
      }
      const part_ = classifyRows(Array.isArray(res.data) ? res.data : [], !!res.partial_failure);
      result.live.push(...part_.live);
      result.offline.push(...part_.offline);
      result.unknown.push(...part_.unknown);
      result.rows.push(...part_.rows);
    }
    return result;
  }

  /**
   * Polls creators and calls onLive / onEnd. First poll only seeds state; a failed check never ends a
   * stream; an end needs two offline polls in a row. Uses bulk checks on Basic and up, isLive per
   * creator on Sandbox. Returns stop().
   */
  watchLive(handles: string[], opts: WatchLiveOptions = {}): { stop(): void } {
    const all = uniqueHandles(handles);
    const interval = Math.max(MIN_WATCH_INTERVAL_SECONDS, opts.intervalSeconds ?? 60);
    const tracker = new LiveTracker();
    const controller = new AbortController();
    const signal = controller.signal;
    opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    let bulk = true;

    const pollOnce = async (): Promise<WhoIsLiveResult> => {
      if (bulk) {
        try { return await this.whoIsLive(all); } catch (err) {
          if (!(err instanceof PlanRequiredError)) throw err;
          bulk = false;
        }
      }
      const rows: LiveCheckRow[] = [];
      for (const h of all) {
        if (signal.aborted) break;
        try {
          const s = await this.isLiveDetailed(h);
          rows.push({ unique_id: h, is_live: s.live_status === 'unknown' ? null : s.is_live, room_id: s.room_id });
        } catch (err) {
          if (err instanceof RateLimitError) throw err;
          rows.push({ unique_id: h, is_live: null, check_failed: true });
        }
      }
      return classifyRows(rows);
    };

    const loop = async () => {
      while (!signal.aborted) {
        let waitSeconds = jitter(interval);
        try {
          for (const ev of tracker.update(await pollOnce())) {
            if (ev.type === 'live') opts.onLive?.(ev); else opts.onEnd?.(ev);
          }
        } catch (err) {
          if (err instanceof RateLimitError) waitSeconds = Math.max(waitSeconds, err.retryAfter);
          if (opts.onError) opts.onError(err as Error);
        }
        await sleep(waitSeconds * 1000, signal);
      }
    };
    void loop();
    return { stop: () => controller.abort() };
  }

  // -- Big gifts firehose (Agency)

  /**
   * Real-time alerts for 1,000+ diamond gifts. Node 18/20: pass { WebSocket } from the ws package.
   * Mode region needs region; mode league needs league (region optional). Alerts carry the creator's division in classType.
   */
  streamBigGifts(filter: Omit<StreamBigGiftsOptions, 'apiKey' | 'baseUrl'>, onAlert: (alert: GifterAlert) => void): FirehoseHandle {
    return openFirehose({ ...filter, apiKey: this.apiKey, baseUrl: this.baseUrl }, onAlert);
  }

  // -- Eligibility (stored Backstage verdicts, Agency)

  /** Last verdicts your Backstage extension recorded. Empty when none; does not run a new check. */
  async getEligibility(handles: string[]): Promise<EligibilityVerdicts> {
    const all = uniqueHandles(handles);
    const verdicts: EligibilityVerdicts['verdicts'] = {};
    for (const part of chunk(all, ELIGIBILITY_CHUNK)) {
      const res = await this.get<EligibilityVerdicts>('/eligibility/results', { creators: part.join(',') }, 'agency_global');
      Object.assign(verdicts, res.verdicts ?? {});
    }
    return { verdicts };
  }

  getEligibilityAccounts(): Promise<EligibilityAccounts> {
    return this.get('/eligibility/limits', undefined, 'agency_global');
  }

  // -- Webhooks (Basic and up)

  listWebhooks(): Promise<WebhookList> {
    return this.get('/webcast/webhooks', undefined, 'basic');
  }

  /** Creates a webhook. The response's secret is shown once; pass your own to keep it stable across recreations. */
  createWebhook(opts: CreateWebhookOptions): Promise<WebhookCreated> {
    if (!opts?.url) throw new ValidationError('url is required', 400, null, '/webcast/webhooks');
    if (!opts.events?.length) throw new ValidationError('events is required, for example ["live.start"]', 400, null, '/webcast/webhooks');
    return this.request('POST', '/webcast/webhooks', { body: webhookBody(opts), minTier: 'basic' });
  }

  updateWebhook(id: string, patch: UpdateWebhookPatch): Promise<{ ok: boolean; webhook: Webhook }> {
    const body: Record<string, unknown> = webhookBody(patch);
    if (patch.active !== undefined) body.active = patch.active;
    return this.request('PATCH', `/webcast/webhooks/${encodeURIComponent(id)}`, { body, minTier: 'basic' });
  }

  deleteWebhook(id: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/webcast/webhooks/${encodeURIComponent(id)}`, { minTier: 'basic' });
  }

  testWebhook(id: string): Promise<WebhookTestResult> {
    return this.request('POST', `/webcast/webhooks/${encodeURIComponent(id)}/test`, { body: {}, minTier: 'basic' });
  }
}

function webhookBody(opts: Partial<CreateWebhookOptions>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.url !== undefined) body.target_url = opts.url;
  if (opts.events !== undefined) body.event_types = opts.events;
  if (opts.creators !== undefined) body.creators = uniqueHandles(opts.creators);
  if (opts.rosters !== undefined) body.lists = opts.rosters;
  if (opts.secret !== undefined) body.secret = opts.secret;
  if (opts.bearerToken !== undefined) body.bearer_token = opts.bearerToken;
  if (opts.extraHeaders !== undefined) body.extra_headers = opts.extraHeaders;
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.description !== undefined) body.description = opts.description;
  return body;
}
