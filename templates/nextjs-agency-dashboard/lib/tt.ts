import 'server-only';
import { AgencyClient, PlanRequiredError, TikToolsError } from 'tiktok-live-agency';

// One server-only client. The key never reaches the browser: this module cannot be imported by a Client Component.
export const tt = new AgencyClient();

export const REGION = process.env.REGION || 'UK+';

const PLAN_LABELS: Record<string, string> = {
  sandbox: 'Sandbox', basic: 'Basic', pro: 'Pro', ultra: 'Ultra', agency_global: 'Agency', admin: 'Admin',
};
export const planLabel = (tier?: string) => (tier ? PLAN_LABELS[tier] ?? tier : 'Unknown');

export type Locked = { tier: string; url: string };
export type Result<T> = { ok: true; data: T } | { ok: false; locked?: Locked; error?: string };

/** Runs a call and turns "your plan does not include this" into data the page can render as an upgrade card. */
export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof PlanRequiredError) return { ok: false, locked: { tier: planLabel(err.requiredTier), url: err.upgradeUrl } };
    if (err instanceof TikToolsError) return { ok: false, error: err.message };
    throw err;
  }
}
