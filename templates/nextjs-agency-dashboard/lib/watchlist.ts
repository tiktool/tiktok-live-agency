import 'server-only';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REGION, attempt, tt } from './tt';

export interface Watchlist { handles: string[]; source: string; rosterId?: string }

async function fromFile(): Promise<string[]> {
  try {
    const text = await readFile(join(process.cwd(), 'creators.txt'), 'utf8');
    return text.split(/\r?\n/).map((l) => l.trim().replace(/^@/, '')).filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/** Your roster on the Agency plan, else creators.txt, else the top of the region's daily board (real data either way). */
export async function getWatchlist(): Promise<Watchlist> {
  const rosters = await attempt(() => tt.listRosters());
  if (rosters.ok && rosters.data.lists.length) {
    const chosen = rosters.data.lists.find((l) => l.id === process.env.ROSTER_ID) ?? rosters.data.lists.find((l) => l.memberCount > 0) ?? rosters.data.lists[0];
    const roster = await tt.getRoster(chosen.id);
    if (roster.creators.length) return { handles: roster.creators.map((c) => c.uniqueId), source: `Roster "${roster.name}"`, rosterId: roster.id };
  }
  const file = await fromFile();
  if (file.length) return { handles: file, source: 'creators.txt' };
  const board = await attempt(() => tt.leaderboard({ region: REGION }));
  // A missing, wrong or expired key must not break the build or the page: show why instead.
  if (!board.ok) return { handles: [], source: `Could not load the ${REGION} board (${board.error ?? 'plan does not include it'}). Check TIKTOOLS_API_KEY.` };
  const handles = board.data.entries.filter((e) => !e._masked && e.unique_id && !e.unique_id.includes('*')).slice(0, 10).map((e) => e.unique_id);
  return { handles, source: `Top of the ${REGION} daily board. Add your creators to creators.txt or create a roster.` };
}
