'use client';

import { useEffect, useState } from 'react';

interface Row { unique_id: string; is_live: boolean | null; user_count: number | null; room_id: string | null }
interface Payload { source: string; mode: string; rows: Row[]; checkedAt: string; error?: string }

const REFRESH_MS = 60_000;

export function LiveBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      fetch('/api/live', { signal: controller.signal, cache: 'no-store' })
        .then((r) => r.json())
        .then((p: Payload) => {
          if (p.error) setError(p.error);
          else { setData(p); setError(null); }
        })
        .catch((e: Error) => { if (e.name !== 'AbortError') setError(e.message); });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, []);

  if (error) return <div className="panel p-5 text-sm">Could not load: {error}</div>;
  if (!data) return <div className="panel p-5 text-sm muted">Checking...</div>;
  const sorted = [...data.rows].sort((a, b) => Number(b.is_live === true) - Number(a.is_live === true));
  return (
    <div className="panel overflow-x-auto">
      <div className="px-3 py-2 text-xs muted">
        {data.source}. Checked {new Date(data.checkedAt).toLocaleTimeString()}
        {data.mode === 'single' ? ' (first 10 creators; bulk checks need the Basic plan)' : ''}
      </div>
      <table className="data">
        <thead><tr><th>Creator</th><th>Status</th><th>Viewers</th><th>Watch</th></tr></thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.unique_id}>
              <td>@{r.unique_id}</td>
              <td>
                {r.is_live === true ? <span className="flex items-center gap-2"><span className="live-dot" />Live</span>
                  : r.is_live === false ? <span className="muted">Offline</span>
                  : <span className="muted">Unknown</span>}
              </td>
              <td className="tabular-nums">{r.user_count?.toLocaleString('en-US') ?? '-'}</td>
              <td>{r.is_live ? <a className="link text-sm" href={`https://www.tiktok.com/@${r.unique_id}/live`} target="_blank" rel="noreferrer">Open</a> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
