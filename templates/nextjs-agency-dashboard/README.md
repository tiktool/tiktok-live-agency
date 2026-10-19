# TikTok LIVE agency dashboard (Next.js)

A dashboard for a TikTok LIVE agency built on [tiktok-live-agency](https://www.npmjs.com/package/tiktok-live-agency). It runs with one environment variable, `TIKTOOLS_API_KEY`, and adapts to your plan: anything your plan does not include shows an "Unlock with ..." card instead of an error. No mock data.

Not affiliated with TikTok or ByteDance.

| Page | What it shows | Plan |
| --- | --- | --- |
| `/` | Live now count, your creators with live status and viewers, diamonds for the last 7 days | any key; live checks Basic; diamonds Agency |
| `/live` | Live board that refreshes every 60 seconds | any key (bulk checks on Basic) |
| `/recruit` | Creators to recruit by region with a Free to join badge, pages, CSV download | Agency; lower plans see league members and board dropouts |
| `/creator/[handle]` | Region, rank, 30-day diamonds chart (incomplete days hatched), top gifters, battle win rate | any key; diamonds, gifters and battles Agency |
| `/api/webhooks/tiktools` | Verifies tik.tools webhooks and forwards go-live alerts to Discord | Basic |

## Deploy to Vercel

1. Import this folder as a new Vercel project.
2. Add the environment variable `TIKTOOLS_API_KEY` (get a key at [tik.tools/pricing](https://tik.tools/pricing)).
3. Deploy.

Which creators it watches: your roster on the Agency plan (set `ROSTER_ID` to choose one), otherwise the handles in `creators.txt`, otherwise the top of your region's daily board.

## Run locally

```bash
cp .env.example .env.local   # paste your key
npm install
npm run dev
```

Node 20.9 or newer.

## Go-live alerts to Discord

1. Set `TIKTOOLS_WEBHOOK_SECRET` (16+ characters) and `DISCORD_WEBHOOK_URL` in Vercel and in `.env.local`.
2. Deploy, then run `npm run setup-alerts -- https://your-app.vercel.app`. It creates a webhook for your roster or `creators.txt` and sends a test delivery.

The route verifies the signature on the raw body, drops duplicate deliveries by `X-Tiktool-Event-Id`, and answers fast.

## Keep the key secret

The key is only read in server code (`lib/tt.ts` imports `server-only`, so a Client Component cannot import it). Never add a `NEXT_PUBLIC_` copy of it. `npm run build` runs `scripts/check-bundle.mjs`, which fails the build if the key or a `NEXT_PUBLIC_*` copy of it would reach the browser.

## Lovable or Bolt

These builders run a Vite app in the browser, so the key must live in a Supabase Edge Function. Ask the builder for: "a Supabase Edge Function that imports AgencyClient from npm:tiktok-live-agency, reads the secret TIKTOOLS_API_KEY, and returns whoIsLive / rosterDiamonds / findCreatorsToRecruit as JSON", then have the pages call that function.

## Rate limits

Pages revalidate every 60 seconds and the live board refreshes every 60 seconds. Diamonds for a roster cost one request per creator, so keep `revalidate` at 60 or higher for big rosters.
