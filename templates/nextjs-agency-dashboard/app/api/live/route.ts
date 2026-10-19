import { NextResponse } from 'next/server';
import { PlanRequiredError } from 'tiktok-live-agency';
import { tt } from '@/lib/tt';
import { getWatchlist } from '@/lib/watchlist';

export const dynamic = 'force-dynamic';

// Sandbox keys check one creator per request; cap it so a refresh stays inside the per-minute limit.
const SINGLE_CHECK_CAP = 10;

export async function GET() {
  const watch = await getWatchlist();
  try {
    const res = await tt.whoIsLive(watch.handles);
    return NextResponse.json({ source: watch.source, mode: 'bulk', rows: res.rows, checkedAt: new Date().toISOString() });
  } catch (err) {
    if (!(err instanceof PlanRequiredError)) return NextResponse.json({ error: (err as Error).message }, { status: 502 });
    const rows = await Promise.all(watch.handles.slice(0, SINGLE_CHECK_CAP).map(async (h) => {
      const s = await tt.isLiveDetailed(h).catch(() => null);
      return { unique_id: h, is_live: s && s.live_status !== 'unknown' ? s.is_live : null, room_id: s?.room_id ?? null, user_count: null };
    }));
    return NextResponse.json({ source: watch.source, mode: 'single', rows, checkedAt: new Date().toISOString() });
  }
}
