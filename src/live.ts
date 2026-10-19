import type { LiveCheckRow, LiveEvent, WhoIsLiveResult } from './types.js';

export const MIN_WATCH_INTERVAL_SECONDS = 30;
/** Offline polls in a row before an end event fires, so one failed check never reads as a stream ending. */
export const END_AFTER_OFFLINE_POLLS = 2;

export function normalizeHandle(handle: string): string {
  return String(handle || '').trim().replace(/^@/, '').toLowerCase();
}

export function uniqueHandles(handles: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const h of handles) {
    const n = normalizeHandle(h);
    if (n) seen.add(n);
  }
  return [...seen];
}

/** A row is unknown when the check failed or the API could not say, never offline. */
export function classifyRows(rows: LiveCheckRow[], partialFailure = false): WhoIsLiveResult {
  const out: WhoIsLiveResult = { live: [], offline: [], unknown: [], rows };
  for (const row of rows) {
    if (row.check_failed || row.is_live === null || row.is_live === undefined || row.live_status === 'unknown') out.unknown.push(row);
    else if (row.is_live === true) out.live.push(row);
    else if (partialFailure && row.live_status !== 'offline') out.unknown.push(row);
    else out.offline.push(row);
  }
  return out;
}

interface CreatorState { live: boolean; offlineStreak: number; roomId: string | null }

/**
 * Turns successive live checks into live / end events. The first update only
 * seeds state, unknown never changes state, and an end needs
 * END_AFTER_OFFLINE_POLLS offline checks in a row.
 */
export class LiveTracker {
  private readonly state = new Map<string, CreatorState>();
  private seeded = false;

  update(result: WhoIsLiveResult, now: Date = new Date()): LiveEvent[] {
    const events: LiveEvent[] = [];
    const at = now.toISOString();
    const firstPass = !this.seeded;
    this.seeded = true;

    for (const row of result.live) {
      const id = normalizeHandle(row.unique_id);
      const prev = this.state.get(id);
      if (!firstPass && (!prev || !prev.live)) {
        events.push({ type: 'live', creator: id, room_id: row.room_id ?? null, title: row.title ?? null, at });
      }
      this.state.set(id, { live: true, offlineStreak: 0, roomId: row.room_id ?? null });
    }

    for (const row of result.offline) {
      const id = normalizeHandle(row.unique_id);
      const prev = this.state.get(id);
      if (!prev) {
        this.state.set(id, { live: false, offlineStreak: 0, roomId: null });
        continue;
      }
      if (!prev.live) continue;
      const streak = prev.offlineStreak + 1;
      if (streak >= END_AFTER_OFFLINE_POLLS) {
        events.push({ type: 'end', creator: id, room_id: prev.roomId, title: null, at });
        this.state.set(id, { live: false, offlineStreak: 0, roomId: null });
      } else {
        this.state.set(id, { ...prev, offlineStreak: streak });
      }
    }

    return events;
  }

  isLive(handle: string): boolean {
    return this.state.get(normalizeHandle(handle))?.live === true;
  }
}

export function jitter(seconds: number, ratio = 0.1, random: () => number = Math.random): number {
  const delta = seconds * ratio;
  return seconds - delta + random() * delta * 2;
}
