import Link from 'next/link';
import { attempt, tt } from '@/lib/tt';
import { getWatchlist } from '@/lib/watchlist';
import { ErrorCard, Stat, UnlockCard } from '@/components/Cards';

export const revalidate = 60;

const fmt = (n: number | null | undefined) => (typeof n === 'number' ? n.toLocaleString('en-US') : '-');

export default async function Overview() {
  const watch = await getWatchlist();
  const handles = watch.handles.slice(0, 50);
  const [live, diamonds] = await Promise.all([
    attempt(() => tt.whoIsLive(handles)),
    attempt(() => tt.rosterDiamonds(handles, { days: 7 })),
  ]);

  // On plans without bulk checks or diamonds, fall back to one lookup per creator (board score + live flag, any key).
  const needCore = !live.ok || !diamonds.ok;
  const core = needCore
    ? await Promise.all(handles.slice(0, 10).map((h) => attempt(() => tt.getCreator(h)).then((r) => [h.toLowerCase(), r] as const)))
    : [];
  const coreBy = new Map(core.map(([h, r]) => [h, r.ok ? r.data : null]));

  const liveBy = new Map((live.ok ? live.data.rows : []).map((r) => [r.unique_id.toLowerCase(), r]));
  const diamondsBy = new Map((diamonds.ok ? diamonds.data.creators : []).map((c) => [c.uniqueId, c]));
  const liveCount = live.ok ? live.data.live.length : core.filter(([, r]) => r.ok && r.data.isLive).length;

  return (
    <div className="space-y-6">
      <p className="text-sm muted">Watching: {watch.source}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Live now" value={String(liveCount)} hint={live.ok ? 'Confirmed by a live check' : 'From board snapshots'} />
        <Stat label="Creators watched" value={String(handles.length)} />
        {diamonds.ok ? (
          <Stat label="Diamonds, last 7 days" value={fmt(diamonds.data.totalDiamonds)} hint="Captured gifts, a lower bound" />
        ) : diamonds.locked ? (
          <UnlockCard title="Diamonds, last 7 days" locked={diamonds.locked} />
        ) : (
          <ErrorCard title="Diamonds" error={diamonds.error ?? ''} />
        )}
      </div>

      <div className="panel overflow-x-auto">
        <table className="data">
          <thead>
            <tr><th>Creator</th><th>Status</th><th>Viewers</th><th>{diamonds.ok ? 'Diamonds 7d' : 'Board score'}</th><th /></tr>
          </thead>
          <tbody>
            {handles.map((h) => {
              const id = h.toLowerCase();
              const row = liveBy.get(id);
              const c = coreBy.get(id);
              const isLive = row ? row.is_live : c?.isLive ?? null;
              return (
                <tr key={id}>
                  <td>@{id}</td>
                  <td>
                    {isLive === true ? (
                      <span className="flex items-center gap-2"><span className="live-dot" />Live</span>
                    ) : isLive === false ? (
                      <span className="flex items-center gap-2 muted"><span className="off-dot" />Offline</span>
                    ) : (
                      <span className="muted">Unknown</span>
                    )}
                  </td>
                  <td className="tabular-nums">{fmt(row?.user_count ?? c?.viewerCount ?? null)}</td>
                  <td className="tabular-nums">{diamonds.ok ? fmt(diamondsBy.get(id)?.totalDiamonds ?? 0) : fmt(c?.earnings ?? null)}</td>
                  <td><Link className="link text-sm" href={`/creator/${encodeURIComponent(id)}`}>Details</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!live.ok && live.locked ? <UnlockCard title="Bulk live checks for your whole roster" locked={live.locked} /> : null}
    </div>
  );
}
