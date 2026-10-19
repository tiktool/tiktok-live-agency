import type { Locked } from '@/lib/tt';

export function UnlockCard({ title, locked }: { title: string; locked: Locked }) {
  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 text-sm muted">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
        {title}
      </div>
      <p className="mt-2">Unlock with the <strong>{locked.tier}</strong> plan.</p>
      <a className="link text-sm" href={locked.url} target="_blank" rel="noreferrer">See plans</a>
    </div>
  );
}

export function ErrorCard({ title, error }: { title: string; error: string }) {
  return (
    <div className="panel p-5">
      <div className="text-sm muted">{title}</div>
      <p className="mt-2 text-sm">Could not load: {error}</p>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel p-5">
      <div className="text-sm muted">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs muted">{hint}</div> : null}
    </div>
  );
}
