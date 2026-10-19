import { PlanRequiredError } from 'tiktok-live-agency';
import { REGION, tt } from '@/lib/tt';

export const dynamic = 'force-dynamic';

const MAX_PAGES = 10;
const REGION_RE = /^[A-Z0-9+_-]{1,8}$/;

const cell = (v: unknown) => {
  const s = String(v ?? '');
  // Quote everything and neutralise spreadsheet formulas.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export async function GET(req: Request) {
  const region = (new URL(req.url).searchParams.get('region') || REGION).toUpperCase();
  if (!REGION_RE.test(region)) return new Response('invalid region', { status: 400 });
  const lines = ['username,league,score,region,account_region,backstage'];
  try {
    for await (const r of tt.iterCreatorsToRecruit({ region, maxPages: MAX_PAGES })) {
      lines.push([r.username, r.current_league, r.current_snapshot_score, r.region, r.account_region, r.backstage].map(cell).join(','));
    }
  } catch (err) {
    if (err instanceof PlanRequiredError) return new Response(`Needs the ${err.requiredTier} plan: ${err.upgradeUrl}`, { status: 403 });
    return new Response('Could not load creators', { status: 502 });
  }
  return new Response(lines.join('\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="recruit-${region.replace('+', 'plus')}.csv"` },
  });
}
