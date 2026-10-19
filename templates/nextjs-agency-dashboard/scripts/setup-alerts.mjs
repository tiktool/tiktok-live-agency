// Creates a webhook that sends live.start and live.end for your creators to the deployed dashboard.
//   npm run setup-alerts -- https://your-app.vercel.app
// Reads TIKTOOLS_API_KEY, TIKTOOLS_WEBHOOK_SECRET and optional ROSTER_ID from .env.local. Needs the Basic plan.
import { readFileSync } from 'node:fs';
import { AgencyClient } from 'tiktok-live-agency';

const site = process.argv[2];
if (!site || !/^https:\/\//.test(site)) {
  console.error('Usage: npm run setup-alerts -- https://your-deployed-dashboard');
  process.exit(1);
}
const secret = process.env.TIKTOOLS_WEBHOOK_SECRET;
if (!secret || secret.length < 16) {
  console.error('Set TIKTOOLS_WEBHOOK_SECRET (16+ characters) in .env.local and in your host first.');
  process.exit(1);
}

const tt = new AgencyClient();
const rosterId = process.env.ROSTER_ID;
let creators = [];
try {
  creators = readFileSync('creators.txt', 'utf8').split(/\r?\n/).map((l) => l.trim().replace(/^@/, '')).filter((l) => l && !l.startsWith('#'));
} catch { /* no file */ }
if (!rosterId && !creators.length) {
  console.error('Add handles to creators.txt or set ROSTER_ID.');
  process.exit(1);
}

const { webhook } = await tt.createWebhook({
  url: `${site.replace(/\/+$/, '')}/api/webhooks/tiktools`,
  events: ['live.start', 'live.end'],
  ...(rosterId ? { rosters: [rosterId] } : { creators }),
  secret,
  name: 'Agency dashboard alerts',
});
console.log(`Webhook ${webhook.id} created for ${rosterId ? `roster ${rosterId}` : `${creators.length} creators`}.`);
const test = await tt.testWebhook(webhook.id);
console.log(`Test delivery: HTTP ${test.http_status ?? 'no response'}${test.error ? ` (${test.error})` : ''}`);
