import { notFound } from 'next/navigation';
import { attempt, tt } from '@/lib/tt';
import { ErrorCard, Stat, UnlockCard } from '@/components/Cards';
import { DiamondBars } from '@/components/DiamondBars';

export const revalidate = 60;

const HANDLE_RE = /^[a-z0-9._]{1,40}$/;

export default async function CreatorPage({ params }: { params: Promise<{ handle: string }> }) {
  const handle = decodeURIComponent((await params).handle).replace(/^@/, '').toLowerCase();
  if (!HANDLE_RE.test(handle)) notFound();

  const [core, daily, gifters, battles] = await Promise.all([
    attempt(() => tt.getCreator(handle)),
    attempt(() => tt.getDailyDiamonds(handle, { days: 30 })),
    attempt(() => tt.getCreatorGifters(handle, { days: 30, limit: 10 })),
    attempt(() => tt.getCreatorBattles(handle, { days: 30, limit: 500 })),
  ]);
  const c = core.ok ? core.data : null;
  const fights = battles.ok ? battles.data.battles : [];
  const wins = fights.filter((b) => b.won).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">@{handle}</h1>
        {c?.isLive ? <span className="flex items-center gap-2 text-sm"><span className="live-dot" />Live</span> : null}
        <a className="link ml-auto text-sm" href={`https://www.tiktok.com/@${handle}`} target="_blank" rel="noreferrer">TikTok profile</a>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Region" value={c?.region ?? '-'} />
        <Stat label="Current rank" value={c?.currentRank ? `#${c.currentRank}` : '-'} hint="On the region's daily board" />
        {battles.ok
          ? <Stat label="Battle win rate, 30 days" value={fights.length ? `${Math.round((wins / fights.length) * 100)}%` : '-'} hint={`${wins} of ${fights.length}`} />
          : battles.locked ? <UnlockCard title="Battle record" locked={battles.locked} /> : <ErrorCard title="Battles" error={battles.error ?? ''} />}
      </div>

      {daily.ok ? (
        <div className="panel p-5">
          <div className="flex items-baseline gap-3">
            <div className="text-sm muted">Diamonds per day, last 30 days</div>
            <div className="ml-auto text-lg font-semibold tabular-nums">{daily.data.totalDiamonds.toLocaleString('en-US')}</div>
          </div>
          <DiamondBars buckets={daily.data.buckets} />
          <p className="text-xs muted">From captured gifts: a lower bound, not the Backstage payout. Hatched days had capture gaps ({daily.data.incompleteDays} of {daily.data.buckets.length}).</p>
        </div>
      ) : daily.locked ? <UnlockCard title="Diamonds per day" locked={daily.locked} /> : <ErrorCard title="Diamonds" error={daily.error ?? ''} />}

      {gifters.ok ? (
        <div className="panel overflow-x-auto">
          <div className="px-3 py-2 text-sm muted">Top gifters, 30 days</div>
          <table className="data">
            <thead><tr><th>Gifter</th><th>Diamonds</th><th>Gifts</th></tr></thead>
            <tbody>{gifters.data.gifters.map((g) => (
              <tr key={g.uniqueId}><td>@{g.uniqueId}</td><td className="tabular-nums">{g.diamonds.toLocaleString('en-US')}</td><td className="tabular-nums">{g.gifts}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : gifters.locked ? <UnlockCard title="Top gifters" locked={gifters.locked} /> : null}
    </div>
  );
}
