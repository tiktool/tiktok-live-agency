import type { DiamondBucket } from 'tiktok-live-agency';

/** Inline SVG bar chart. Incomplete days (capture gaps) are hatched so nobody reads them as a slow day. */
export function DiamondBars({ buckets }: { buckets: DiamondBucket[] }) {
  const w = 720;
  const h = 160;
  const max = Math.max(1, ...buckets.map((b) => b.diamonds));
  const bw = w / Math.max(1, buckets.length);
  return (
    <svg viewBox={`0 0 ${w} ${h + 20}`} className="w-full" role="img" aria-label="Diamonds per day">
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent)" strokeWidth="2" opacity="0.5" />
        </pattern>
      </defs>
      {buckets.map((b, i) => {
        const bh = Math.round((b.diamonds / max) * h);
        return (
          <g key={b.date}>
            <rect x={i * bw + 2} y={h - bh} width={Math.max(1, bw - 4)} height={Math.max(bh, 1)} fill={b.complete ? 'var(--accent)' : 'url(#hatch)'}>
              <title>{`${b.date}: ${b.diamonds.toLocaleString('en-US')} diamonds${b.complete ? '' : ' (incomplete day)'}`}</title>
            </rect>
            {i % Math.ceil(buckets.length / 6) === 0 ? <text x={i * bw + 2} y={h + 16} fontSize="11" fill="var(--muted)">{b.date.slice(5)}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}
