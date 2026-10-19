/**
 * Response types. Field names are the API's own, so the docs, the raw JSON and
 * these types always agree. Every interface keeps unknown extra fields.
 */

export type Tier = 'demo' | 'sandbox' | 'basic' | 'pro' | 'ultra' | 'agency_global' | 'admin' | (string & {});

export interface Extra { [key: string]: unknown }

export interface RateLimitInfo { limit: number; remaining: number; resetAt: number }

export interface AccountInfo extends Extra {
  tier: Tier;
  api: { limit: number; remaining: number; reset_at: number };
  websocket: { limit: number; current: number };
  bulk_check_limit: number;
  bulk_check_note?: string;
  evaluation_ends_at?: string;
  evaluation_days_left?: number;
  evaluation_note?: string;
}

export interface RegionInfo extends Extra { region: string; region_label: string; live_count: number }

export interface PageRateLimit { limit: number; remaining: number; reset: number }

export type BackstageVerdict = 'eligible' | 'ineligible' | 'premium_only' | 'checked' | 'unchecked';

export interface RecruitCandidate extends Extra {
  username: string;
  current_league: string | null;
  current_snapshot_score: number;
  region: string;
  live_region: string;
  account_region: string | null;
  account_region_source: string | null;
  backstage: BackstageVerdict;
}

export interface RecruitPage extends Extra {
  status_code: number;
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  returned: number;
  live_region_note?: string;
  backstage_note?: string;
  account_region_resolved?: number;
  region_matched?: string;
  available_regions?: string[];
  results: RecruitCandidate[];
  rate_limit?: PageRateLimit;
}

export interface NewCreator extends Extra {
  username: string;
  display_name: string;
  usd_7d: number;
  usd_30d: number;
  first_seen: string;
  last_active: string;
  region: string;
  backstage: BackstageVerdict;
}

export interface NewCreatorPage extends Extra {
  status_code: number;
  region: string;
  since: string | null;
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  returned: number;
  backstage_note?: string;
  results: NewCreator[];
  rate_limit?: PageRateLimit;
}

export interface LeagueDivision extends Extra { label: string; classType: number; count: number }
export interface LeagueDivisionsResponse extends Extra { status_code: number; region: string; divisions: LeagueDivision[] }

export interface LeagueEntry extends Extra {
  rank: number;
  unique_id: string;
  nickname: string;
  score: number;
  is_live: boolean;
  league: string;
  account_region?: string | null;
  account_region_source?: string | null;
  _masked?: boolean;
  _upgrade_required?: string;
}

export interface LeagueMembersResponse extends Extra {
  status_code: number;
  region: string;
  league: string;
  tier: Tier;
  gated: boolean;
  returned: number;
  entries: LeagueEntry[];
}

export interface Mover extends Extra {
  peak_rank: number;
  unique_id: string;
  nickname: string;
  avatar?: string;
  peak_score: number;
  appearances: number;
  live_now: boolean;
  diamonds_to_reenter: number;
  in_board_now?: boolean;
  in_top99_now?: boolean;
}

export interface RegionMoversResponse extends Extra {
  region: string;
  region_label?: string;
  gated: boolean;
  tier: Tier;
  cutoff_score: number;
  total: number;
  movers: Mover[];
}

export interface LeagueMoversResponse extends Extra {
  region: string;
  divisions: Array<{ class_type: number; league: string; cutoff_score: number; total: number; movers: Mover[] } & Extra>;
}

export interface GamingMoversResponse extends Extra { region: string }

export interface BoardHistoryRow extends Extra {
  unique_id: string;
  nickname?: string;
  avatar?: string;
  room_id?: string | null;
  rank_then?: number | null;
  rank_now?: number | null;
  best_rank?: number;
  score_gain?: number;
  is_live?: boolean;
}

export interface BoardHistoryMovers extends Extra {
  board: string;
  window: string;
  mode: 'movers';
  window_start: string;
  window_end: string;
  entered_count: number;
  left_count: number;
  movers_count: number;
  entered: BoardHistoryRow[];
  left: BoardHistoryRow[];
  movers: BoardHistoryRow[];
}

export interface BoardHistorySnapshot extends Extra {
  board: string;
  mode: 'snapshot';
  at: string;
  count: number;
  entries: Array<{ rank: number; unique_id: string; score: number; is_live: boolean } & Extra>;
}

export interface BoardEntry extends Extra {
  rank: number;
  unique_id: string;
  nickname: string;
  avatar?: string;
  score: number;
  is_live?: boolean;
  room_id?: string | null;
  _masked?: boolean;
}

export interface LeaderboardResponse extends Extra {
  status_code: number;
  type: string;
  region: string;
  region_label?: string;
  gated: boolean;
  tier: Tier;
  updated_at?: string;
  count: number;
  entries: BoardEntry[];
}

export interface GlobalLeaderboardResponse extends Extra {
  tier: Tier;
  gated: boolean;
  total_live: number;
  total_regions: number;
  regions: Array<RegionInfo & { total_score: number; top: BoardEntry[] }>;
}

export interface BoardResponse extends Extra { region?: string; gated?: boolean; count: number; entries: Array<Extra> }

export interface LiveCounts extends Extra { status_code: number; global_live: number; global_live_verified?: number; regions: Record<string, number> }

export interface GifterEntry extends Extra {
  rank: number;
  gifter_id: string;
  unique_id: string;
  nickname: string;
  avatar?: string;
  diamonds: number;
  gifts: number;
  creators_gifted: number;
}

export interface TopGiftersResponse extends Extra { region: string; period: string; tier: Tier; gated: boolean; count: number; entries: GifterEntry[] }

export interface CreatorCore extends Extra {
  found: boolean;
  uniqueId: string;
  nickname?: string;
  avatar?: string;
  region?: string;
  liveRegion?: string;
  currentRank?: number | null;
  earnings?: number | null;
  isLive?: boolean;
  viewerCount?: number | null;
  channels?: Extra[];
}

export interface CreatorProfile extends Extra {
  profile: Extra & { uniqueId: string; nickname?: string; stats?: Extra; isLive?: boolean; privateAccount?: boolean };
  league?: Extra;
  cached?: boolean;
  usage?: { profile_lookups_used: number; profile_lookups_limit: number };
}

export interface RenameLookup extends Extra { status: string; originalUsername: string; currentUsername?: string | null; userId?: string | null; detectedAt?: string | null }

/** Keyed by the user id you passed. username is null when the id could not be resolved. */
export interface ResolvedUser extends Extra { userId: string; username: string | null; nickname: string | null; avatarUrl: string | null; cached?: boolean }

export interface StatsOptions {
  /** 1-90, default 7. Ignored when from/to are given. */
  days?: number;
  /** ISO UTC start (inclusive). Use with `to`; span up to 90 days within the last 90 days. */
  from?: string;
  /** ISO UTC end (exclusive). */
  to?: string;
  /** Rows to return, 1-500. There is no cursor beyond this. */
  limit?: number;
}

export interface CreatorSummary extends Extra {
  creator: string;
  gifts: { events: number; diamonds: number; uniqueGifters: number };
  battles: { total: number; wins: number };
  chat: { messages: number; uniqueChatters: number };
  activity: { likes: number; joins: number };
}

export interface DiamondBucket extends Extra {
  date: string;
  diamonds: number;
  events: number;
  uniqueGifters: number;
  captured: boolean;
  complete: boolean;
  coverage?: Extra;
}

export interface DailyDiamonds extends Extra {
  creator: string;
  timezone: string;
  totalDiamonds: number;
  completeDays: number;
  incompleteDays: number;
  buckets: DiamondBucket[];
}

export interface CreatorGifters extends Extra { creator: string; count: number; gifters: Array<{ uniqueId: string; displayName: string; diamonds: number; gifts: number; lastGiftAt: string } & Extra> }
export interface CreatorGifts extends Extra { creator: string; count: number; gifts: Array<{ giftName: string; sent: number; diamonds: number; senders: number } & Extra> }
export interface CreatorBattles extends Extra { creator: string; count: number; battles: Array<{ battleId: string; opponent: string; ownScore: number; oppScore: number; won: boolean; durationSecs: number; startedAt: string } & Extra> }
export interface CreatorChat extends Extra { creator: string; count?: number; messages?: Array<{ sentAt: string; uniqueId: string; displayName: string; message: string } & Extra> }
export interface CreatorActivity extends Extra { creator: string; count?: number; activity?: Array<{ date: string; likes: number; joins: number } & Extra> }
export interface CreatorGoals extends Extra { creator: string; count?: number; goals?: Extra[] }

export interface RosterSummary extends Extra { id: string; name: string; createdAt: string; memberCount: number; liveCount: number }
export interface RosterIndex extends Extra { lists: RosterSummary[]; total: number; maxLists: number }
export interface RosterCreated extends Extra { ok: boolean; id: string; name: string; memberCount: number }
export interface RosterMember extends Extra {
  uniqueId: string;
  /** Snapshot flag. Confirm with whoIsLive before alerting. */
  isLive: boolean;
  region?: string | null;
  nickname?: string | null;
  avatar?: string | null;
  score?: number | null;
  roomId?: string | null;
  followers?: number | null;
  bio?: string | null;
  diamonds?: number | null;
}
export interface Roster extends Extra { id: string; name: string; memberCount: number; liveCount: number; creators: RosterMember[] }
export interface RosterChange extends Extra { ok: boolean; id: string; action: 'add' | 'remove'; changed: number; memberCount: number }

export interface RosterDiamondsCreator { uniqueId: string; totalDiamonds: number; completeDays: number; incompleteDays: number; buckets: DiamondBucket[] }
export interface RosterDiamonds { days: number; totalDiamonds: number; creators: RosterDiamondsCreator[]; failed: Array<{ uniqueId: string; error: string }> }

export interface LiveStatus extends Extra { unique_id: string; is_live: boolean | null; live_status?: 'live' | 'offline' | 'unknown'; room_id: string | null; cached?: boolean }

export interface LiveCheckRow extends Extra {
  unique_id: string;
  is_live: boolean | null;
  live_status?: string;
  room_id?: string | null;
  user_count?: number | null;
  title?: string | null;
  check_failed?: boolean;
}

export interface WhoIsLiveResult { live: LiveCheckRow[]; offline: LiveCheckRow[]; unknown: LiveCheckRow[]; rows: LiveCheckRow[] }

export interface LiveEvent { type: 'live' | 'end'; creator: string; room_id: string | null; title: string | null; at: string }

export interface GifterAlert extends Extra {
  type: 'gifter_alert';
  ts: string;
  gifter: { username: string; displayName: string; isAnonymous: boolean };
  creator: { uniqueId: string };
  gift: { name: string; totalDiamonds: number };
  /** Receiving creator's region; filled from the creator's ranking region when the gift itself has none. null when unknown. */
  region: string | null;
  /** Receiving creator's current league division (A1 to D5) when the creator is on a league board; null when unknown. */
  classType: number | string | null;
}

export interface EligibilityVerdict extends Extra { creator_unique_id?: string; eligible: boolean; category?: string; anchor_status?: string; display_reason?: string; checked_at?: string }
export interface EligibilityVerdicts extends Extra { verdicts: Record<string, EligibilityVerdict> }
export interface EligibilityAccounts extends Extra { accounts: Array<Extra & { accountId: string; region?: string; cooldown?: unknown }>; rosterTotal: number; premiumTotal: number }

export type WebhookEventType = 'live.start' | 'live.end' | 'live.peak_viewers' | 'live.gift.high_value' | 'creator.follower_milestone' | 'creator.eligible';

export interface Webhook extends Extra {
  id: string;
  target_url: string;
  event_types: WebhookEventType[];
  creators: string[];
  lists?: string[];
  active: boolean;
  secret_preview?: string;
  last_delivery_at?: string | null;
  last_status?: number | null;
  fail_streak?: number;
  name?: string | null;
  description?: string | null;
  created_at?: string;
}

export interface WebhookList extends Extra {
  ok: boolean;
  tier: Tier;
  limits: { tier: string; maxTargets: number; dailyQuota: number; allowedEvents: WebhookEventType[]; enabled: boolean };
  quotaUsed: number;
  webhooks: Webhook[];
}

export interface WebhookCreated extends Extra { ok: boolean; webhook: Webhook; secret: string; secret_note?: string }
export interface WebhookTestResult extends Extra { ok: boolean; http_status: number | null; response_ms: number | null; response_snippet?: string | null; error?: string | null; sent?: Extra }

export interface CreateWebhookOptions {
  url: string;
  events: WebhookEventType[];
  creators?: string[];
  /** Roster ids. Creators added to a roster later are covered automatically. */
  rosters?: string[];
  /** Your own secret (16-200 chars of A-Z a-z 0-9 _ . -). Recreating with the same secret keeps your verifier working. */
  secret?: string;
  bearerToken?: string;
  extraHeaders?: Record<string, string>;
  name?: string;
  description?: string;
}

export type UpdateWebhookPatch = Partial<Omit<CreateWebhookOptions, 'secret'>> & { active?: boolean };

interface WebhookEventBase {
  event_id: string;
  occurred_at: string;
  is_test?: boolean;
  creator: { unique_id: string; nickname?: string; avatar_url?: string; user_id?: string; follower_count?: number };
  _links?: Extra;
  [key: string]: unknown;
}

export interface LiveStartEvent extends WebhookEventBase { event: 'live.start'; live: { room_id: string; started_at: string; live_url: string } }
export interface LiveEndEvent extends WebhookEventBase { event: 'live.end'; live: { room_id: string; started_at?: string; ended_at: string; duration_seconds?: number; live_url?: string } }
export interface PeakViewersEvent extends WebhookEventBase { event: 'live.peak_viewers'; peak: { threshold: number; current_count: number; label: string }; live?: Extra }
export interface HighValueGiftEvent extends WebhookEventBase { event: 'live.gift.high_value'; gift: { name: string; image?: string; diamonds: number; gifter: { unique_id: string; display_name?: string; avatar_url?: string } }; live?: Extra }
export interface FollowerMilestoneEvent extends WebhookEventBase { event: 'creator.follower_milestone'; milestone: { threshold: number; previous_count: number; current_count: number; label: string } }
export interface CreatorEligibleEvent extends WebhookEventBase { event: 'creator.eligible'; eligible: { username: string; current_league: string; current_snapshot_score: number; region: string; reason: 'new_entrant' | 'threshold_crossed' } }

export type WebhookEvent = LiveStartEvent | LiveEndEvent | PeakViewersEvent | HighValueGiftEvent | FollowerMilestoneEvent | CreatorEligibleEvent;
