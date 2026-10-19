import Link from 'next/link';
import { isFreeToJoin } from 'tiktok-live-agency';
import { REGION, attempt, tt } from '@/lib/tt';
import { ErrorCard, UnlockCard } from '@/components/Cards';

export const revalidate = 60;

const PAGE_SIZE = 50;

export default async function Recruit({ searchParams }: { searchParams: Promise<{ region?: string; page?: string }> }) {
  const sp = await searchParams;
  const region = (sp.region || REGION).toUpperCase();
  const page = Math.max(1, Number(sp.page) || 1);
  const [regions, recruit] = await Promise.all([
    attempt(() => tt.listRegions()),
    attempt(() => tt.findCreatorsToRecruit({ region, page, limit: PAGE_SIZE })),
  ]);

  // Lower plans: league members and board dropouts are the next best recruiting signal (some names hidden).
  const fallback = !recruit.ok
    ? await Promise.all([
        attempt(() => tt.leagueMembers({ region, league: 'A1' })),
        attempt(() => tt.droppedOutCreators({ region })),
      ])
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <h1 className="text-xl font-semibold">Find creators</h1>
        <form className="ml-auto flex items-center gap-2 text-sm" method="get">
          <label htmlFor="region" className="muted">Region</label>
          <select id="region" name="region" defaultValue={region} className="panel px-2 py-1">
            {(regions.ok ? regions.data : [{ region, region_label: region, live_count: 0 }]).map((r) => (
              <option key={r.region} value={r.region}>{r.region_label} ({r.region})</option>
            ))}
          </select>
          <button className="panel px-3 py-1" type="submit">Show</button>
        </form>
      </div>

      {recruit.ok ? (
        <>
          <div className="flex items-center gap-4 text-sm">
            <span className="muted">{recruit.data.total.toLocaleString('en-US')} candidates in {recruit.data.region_matched ?? region}</span>
            <a className="link ml-auto" href={`/api/recruit.csv?region=${encodeURIComponent(region)}`}>Download CSV</a>
          </div>
          <div className="panel overflow-x-auto">
            <table className="data">
              <thead><tr><th>Creator</th><th>League</th><th>Score</th><th>Backstage</th><th /></tr></thead>
              <tbody>
                {recruit.data.results.map((r) => (
                  <tr key={r.username}>
                    <td>@{r.username}</td>
                    <td>{r.current_league ?? '-'}</td>
                    <td className="tabular-nums">{r.current_snapshot_score.toLocaleString('en-US')}</td>
                    <td>{isFreeToJoin(r) ? <span className="accent">Free to join</span> : <span className="muted">{r.backstage}</span>}</td>
                    <td><Link className="link text-sm" href={`/creator/${encodeURIComponent(r.username)}`}>Details</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs muted">Free to join is the last verdict your Backstage extension recorded, not a live invite check.</p>
          <div className="flex gap-4 text-sm">
            {page > 1 ? <Link className="link" href={`/recruit?region=${encodeURIComponent(region)}&page=${page - 1}`}>Previous</Link> : null}
            <span className="muted">Page {page} of {Math.max(1, recruit.data.total_pages)}</span>
            {page < recruit.data.total_pages ? <Link className="link" href={`/recruit?region=${encodeURIComponent(region)}&page=${page + 1}`}>Next</Link> : null}
          </div>
        </>
      ) : recruit.locked ? (
        <UnlockCard title="Creators to recruit with Backstage verdicts" locked={recruit.locked} />
      ) : (
        <ErrorCard title="Creators to recruit" error={recruit.error ?? ''} />
      )}

      {fallback ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="panel overflow-x-auto">
            <div className="px-3 py-2 text-sm muted">League A1 in {region}</div>
            {fallback[0].ok ? (
              <table className="data">
                <thead><tr><th>#</th><th>Creator</th><th>Score</th></tr></thead>
                <tbody>{fallback[0].data.entries.slice(0, 25).map((e) => (
                  <tr key={`${e.rank}-${e.unique_id}`}><td>{e.rank}</td><td>{e._masked ? <span className="muted">hidden on your plan</span> : `@${e.unique_id}`}</td><td className="tabular-nums">{e.score.toLocaleString('en-US')}</td></tr>
                ))}</tbody>
              </table>
            ) : <p className="p-3 text-sm muted">{fallback[0].locked ? `Needs ${fallback[0].locked.tier}` : fallback[0].error}</p>}
          </div>
          <div className="panel overflow-x-auto">
            <div className="px-3 py-2 text-sm muted">Dropped below the {region} board</div>
            {fallback[1].ok ? (
              <table className="data">
                <thead><tr><th>Creator</th><th>Peak</th><th>To re-enter</th></tr></thead>
                <tbody>{fallback[1].data.movers.slice(0, 25).map((m, i) => (
                  <tr key={`${i}-${m.unique_id}`}><td>{m.unique_id ? `@${m.unique_id}` : <span className="muted">hidden</span>}</td><td>#{m.peak_rank}</td><td className="tabular-nums">{m.diamonds_to_reenter.toLocaleString('en-US')}</td></tr>
                ))}</tbody>
              </table>
            ) : <p className="p-3 text-sm muted">{fallback[1].locked ? `Needs ${fallback[1].locked.tier}` : fallback[1].error}</p>}
          </div>
        </div>
      ) : null}
    </div>
  );
}
