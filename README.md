# Automatic Sports Card Listing

Internal handoff README for the current working version of the app.

This project is a Node.js web app for ingesting card images, extracting metadata, pulling comps, pricing cards, creating eBay drafts/listings, monitoring live listings, and reporting sold inventory. It supports sports cards and has partial support for trading cards such as Pokemon, Magic, Yu-Gi-Oh!, Star Wars, Marvel, and similar categories.

## What this app does

1. Authenticates an admin user with Google OAuth.
2. Connects to Google Drive for bulk image imports.
3. Creates batches of cards and stores front/back images.
4. Runs OCR / vision extraction to identify the card.
5. Matches cards to a normalized card identity.
6. Pulls active listings and sold comps from eBay and Apify.
7. Prices cards based on sold comps and active inventory.
8. Builds eBay item specifics, descriptions, offers, and publishing payloads.
9. Monitors eBay listings and sales activity.
10. Stores app state locally and can mirror or read from Supabase.

## Current stack

| Area | Current implementation |
| --- | --- |
| Runtime | Node.js, ESM modules |
| HTTP server | Native `node:http` |
| Frontend | Static HTML/CSS/JS served from `public/` |
| Persistence | `data/state.json` plus optional Supabase snapshot/table sync |
| Image storage | Local disk in `data/images/` plus optional Supabase Storage |
| Authentication | Signed session cookie + Google OAuth |
| Drive import | Google Drive API |
| Marketplace | eBay Sell APIs + eBay Browse APIs |
| Sold comp ingestion | SoldComps (`api.sold-comps.com`) for per-card sold comps; Apify eBay sold listings actor for the market-heat feature only |
| OCR / vision | Surya OCR, macOS Vision OCR, optional OpenAI vision |

## High-level architecture

| File | Responsibility |
| --- | --- |
| [src/server.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/server.js) | Loads `.env`, imports the app, starts HTTP server, triggers startup sync to Supabase |
| [src/app.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/app.js) | Main request handler, route definitions, auth gates, UI bootstrap, batch/card/listing endpoints |
| [src/lib/store.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/lib/store.js) | Local state read/write, backup rotation, Supabase snapshot sync, optional table sync |
| [src/lib/storage.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/lib/storage.js) | Saves uploaded images to disk and optionally to Supabase Storage |
| [src/jobs/pipeline.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/jobs/pipeline.js) | Card processing pipeline for OCR, matching, comps, pricing |
| [src/services/ocr.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/services/ocr.js) | OCR / vision extraction |
| [src/services/matching.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/services/matching.js) | Card identity matching |
| [src/services/pricing.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/services/pricing.js) | Pricing math |
| [src/services/apify.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/services/apify.js) | Sold comp parsing, market heat, SoldComps sold-listing fetches (module/function names still carry the historical "Apify" branding — see the naming note at the top of the file) |
| [src/services/comps.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/services/comps.js) | Combines active comps and sold comps into a runtime market view |
| [src/services/ebay.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/services/ebay.js) | eBay auth, inventory, offers, publish flow, listing monitoring, sales ingestion |
| [src/services/ebay-browse.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/services/ebay-browse.js) | eBay Browse active and sold listing search |
| [src/services/drive.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/services/drive.js) | Google Drive OAuth, folder scan/import/move helpers |
| [src/services/auth.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/services/auth.js) | Session cookie and Google login flow |
| [src/services/ximilar-grading.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/services/ximilar-grading.js) | Ximilar's async "card-grader" AI grade-estimation client (submit/poll/parse) |
| [src/routes/grading-routes.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/routes/grading-routes.js) | Grading tab's review-queue routes (`/api/grading/*`) — pull from Drive, submit for AI grading, transfer to the listing pipeline, discard |

## Runtime model

The request flow is:

1. `src/server.js` loads `.env`.
2. The server imports `src/app.js`.
3. `src/app.js` checks auth for most routes.
4. Route handlers read and mutate state through `withState()` in `src/lib/store.js`.
5. State writes always hit local JSON.
6. If Supabase is configured, writes are also mirrored to a snapshot table and optionally to relational tables.

## Source of truth and storage behavior

**Decided policy: local JSON (`data/state.json`) is the fast primary store for the running process; Supabase is a synchronously-written durability replica and cold-start recovery source — not something the app re-reads from on every request, but also not merely best-effort on writes.** This app runs as a single long-lived instance (not horizontally scaled), so there's no multi-writer scenario that would require treating Supabase as authoritative for reads during normal operation. Writes are a different story: see point 4.

1. Local state lives in `data/state.json`.
2. Local image files live in `data/images/`.
3. On every write, the app writes local JSON first (fast, and the copy every read within this process trusts — see point 6).
4. **Writes to Supabase's `state_snapshots` table are awaited, not fire-and-forget** (see `writeState()` in [src/lib/store.js](src/lib/store.js)). `withState()`'s internal queue already serializes every state-mutating call one at a time, so awaiting this doesn't introduce new concurrency risk — it means an API call that changes state doesn't finish until that change is durably in Supabase too (or the attempt has failed/timed out — see point 5), closing the window where a lost local disk between a local write and its Supabase mirror could mean a write existed nowhere durable. The tradeoff: every state-mutating request now includes a Supabase round-trip in its latency (typically well under a second, but real) — during a batch of many sequential card-processing writes, that adds up. Reads are unaffected; the read-side fix (point 6) is what resolved the original Kong load issue and is orthogonal to this.
5. A Supabase write failure or timeout is logged, not thrown — the local write already succeeded, so callers don't see a spurious failure for a durability-layer hiccup. If `SUPABASE_ENABLE_RELATIONAL_SYNC=1`, that additional relational-table sync (`card_items`, `offers`, `comps`, etc.) remains fire-and-forget — it's a supplementary denormalized view, not the primary snapshot, so it doesn't need to block the write path.
6. On reads: the app reconciles local vs. Supabase **once per process lifetime** (the first `readState()` call after boot — see `hasHydratedFromSupabase` in [src/lib/store.js](src/lib/store.js)), preferring whichever looks fresher (by audit-event count / most-recent timestamps). After that one reconciliation, every subsequent read for the rest of that process's life comes from local JSON only — it does **not** re-fetch the multi-MB Supabase snapshot on every request. (An earlier version did re-fetch on every read, which was hammering Supabase/Kong with near-continuous full-snapshot reads; that's what the `hasHydratedFromSupabase` cache fixed. That fix is about reads and is unaffected by point 4's change to the write path.)
7. If Supabase is missing, unreachable, or times out during that one startup reconciliation, the app falls back to local JSON for the rest of the process's life.
8. On startup, [src/server.js](src/server.js) calls `syncLocalToSupabase()` to bootstrap an empty Supabase instance from local data.
9. **Operational caveat:** because writes mirror to the *same shared* Supabase project from both local dev and production (see `SUPABASE_URL` in `.env`), a write from a local dev environment is not sandboxed — it mutates the same `state_snapshots` row production reads on its next reconciliation. Don't assume `READ_STORE=local` makes a script's *writes* safe against production data; it only skips the read side. For one-off data corrections, read/write `data/state.json` directly and push a deliberate, explicit Supabase upsert rather than relying on the reconciliation heuristic to pick the right side.

## Authentication model

There are three separate auth layers.

1. App login
   Uses Google OAuth to authenticate a user email and set a signed session cookie.

2. Google Drive connection
   Uses a separate Drive OAuth flow and stores tokens in `data/drive-tokens.json`.

3. eBay auth
   Uses eBay OAuth for Sell APIs and can also use refresh tokens for long-lived access.

## Main product areas

### Cards

The Cards area is the intake and review workspace.

It supports:

1. Manual batches.
2. Google Drive import.
3. Front/back image pairing.
4. OCR extraction.
5. Metadata review and editing.
6. Reprocessing a card after edits.
7. Manual comp import.

### Listings

The Listings area handles live store management.

It supports:

1. Pulling active eBay listings.
2. Updating prices.
3. Repricing suggestions.
4. Reconciling listings against app-created records.
5. Best-offer enablement.

### Sales

The Sales area pulls sold items from eBay and reports performance.

It currently includes:

1. Sold listing ingestion.
2. Sport/category rollups.
3. Listing-level sales data.
4. Sold amount reporting.

### Market Heat

The Market Heat area builds leaderboards and player-level insights from sold market data.

It uses:

1. Apify sold listing samples.
2. Player insight endpoint (comps only — see `/api/ebay/market-heat/player-insight`).

## Current card processing pipeline

The main processing flow is implemented in [src/jobs/pipeline.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/jobs/pipeline.js).

At a high level:

1. A card item is created with front/back image records.
2. OCR runs using local OCR and optional vision helpers.
3. OCR output is merged into structured metadata.
4. Matching attempts to identify sport, player, year, set, card number, parallel, rookie status, autograph status, and grading state.
5. Live comps are pulled.
6. Sold comps are pulled.
7. Pricing logic calculates a target price and confidence.
8. The card is marked `priced`, `needs_review`, or `listed` depending on downstream state.

## Supported comp sources

### Active comps

Primary source:

1. eBay Browse API

### Sold comps

Primary current source:

1. SoldComps (`api.sold-comps.com`, direct eBay sold-listings API — see `SOLDCOMPS_*` env vars and the naming note at the top of [src/services/apify.js](src/services/apify.js)). Throws a clear quota error (no fallback provider) once SoldComps' local monthly request budget (`SOLDCOMPS_MONTHLY_REQUEST_LIMIT`, currently 2000 to match the live plan — the app tracks its own count in `data/soldcomps-usage.json` and stops calling SoldComps before hitting its real 403) is reached.
2. Apify eBay sold listings actor — market-heat feature only now; no longer used for per-card sold comps.

Important note:

CardHedge and the never-fully-deployed "CardSight" rename have been fully removed (the account was dropped in favor of a SoldComps plan upgrade). Some internal function/variable names in [src/services/apify.js](src/services/apify.js) still carry the historical "Apify" branding from before the SoldComps swap — see the naming note at the top of that file.

## Trading card support status

The app has partial trading card support.

What currently exists:

1. Trading card sport inference in the pipeline and eBay helpers.
2. Category switching for TCG vs non-sport trading cards.
3. Apify sold comp forcing for trading-card style metadata.
4. At least 15 sold comps requested for trading-card Apify lookups.
5. Ximilar identification for TCG cards (Pokemon, Magic, Yu-Gi-Oh!, etc.) via the separate `tcg_id` endpoint (see [src/services/ximilar.js](src/services/ximilar.js)). There's no upload-time "this is a TCG card" flag, so `src/services/ocr.js` tries `sport_id` first (this app is sports-card-first) and only falls back to `tcg_id` when `sport_id` comes back with no usable match — a real sports card should never trigger the fallback since it'll already have a sport_id match.

What is still fragile:

1. OCR accuracy for non-sports and stylized cards.
2. Parallel detection without a strong visual model.
3. Naming consistency between sports and trading-card metadata fields.

## Grading tab (Ximilar AI grade-estimation + physical-grading tracking)

Ximilar has a real, separate "card-grader" product (confirmed against `https://docs.ximilar.com/collectibles/card-grading`, not just marketing copy) that estimates condition for a raw/ungraded card — centering, corners, edges, surface, and a final 1–10 grade plus a `Poor`–`Gem Mint` label. This is now wired up as its own "Grading" tab with two related-but-separate flows:

**1. AI grade-estimate review queue.** Pull candidate raw-card image pairs from Google Drive (reuses the existing `/api/drive/scan` folder scan) into a `gradingItems` queue — separate from `cardItems` until you decide what to do with each one. Per item: optionally click "Get AI Grade" to submit it to Ximilar's card-grader and see the estimate, then either "Transfer to Listing Queue" (creates a real batch + cardItem and runs it through the normal OCR/pricing pipeline) or "Discard". Transfer works regardless of whether an item has been graded yet — grading is optional context, not a gate.

  - It's an async job API, unlike the synchronous `sport_id`/`tcg_id` identification calls in [src/services/ximilar.js](src/services/ximilar.js): `POST https://api.ximilar.com/account/v2/request/` with `type: "card-grader"`, then poll `GET .../account/v2/request/{id}` until `status: "DONE"`. See [src/services/ximilar-grading.js](src/services/ximilar-grading.js) for the client, [src/routes/grading-routes.js](src/routes/grading-routes.js) for the routes.
  - **Separate cost center** — billed independently from the sport_id/tcg_id lookups already in use.
  - **Fire-and-forget, not blocking** — this app has a single global state-mutation queue (`withState()` in [src/lib/store.js](src/lib/store.js)), so the submit route responds `202` immediately and does the actual submit+poll in a detached background task; the frontend polls `GET /api/grading` while any item is mid-job.
  - **Response shape verified against a real completed job** (2026-07-03). Results live at `payload.response.records[]`, one record per submitted image — Ximilar grades front/back independently rather than returning one combined card-level result, so `parseGradingResult()` combines them by taking the worse (lower) grade per category across whichever sides were submitted, matching how professional grading treats the worse side as capping the overall grade. Still defensive against a shape it doesn't recognize (returns nulls rather than throwing).

**2. Physical-grading status tracking.** From the normal card review flow, "Send to Grading" pulls an already-reviewed card out of the listing flow (`status: "sent_to_grading"`) into its own "Sent to Physical Grading" list — for a card actually being submitted to PSA/BGS/etc, not an AI estimate. "Return from Grading" brings it back to `needs_review` so pricing gets a fresh look, and the reviewer fills in the real `candidateGrade`/`gradingCompany`/`certificationNumber` through the existing review panel — those fields already feed [src/services/ebay-condition.js](src/services/ebay-condition.js)'s graded-card condition descriptors, so no new fields or logic were needed there.

## eBay integration areas

The eBay integration is split across multiple responsibilities.

### Auth and setup

Routes:

1. `GET /api/ebay/auth-url`
2. `GET /api/ebay/auth-callback`
3. `POST /api/ebay/refresh-token`
4. `POST /api/ebay/reset-auth`
5. `GET /api/ebay/config`
6. `GET /api/ebay/setup`
7. `POST /api/ebay/auto-configure`

### Listing creation and publishing

Routes:

1. `POST /api/card-items/:id/ebay-preview`
2. `POST /api/card-items/:id/ebay-save`
3. `POST /api/card-items/:id/offer`
4. `POST /api/card-items/:id/offer/auction`
5. `POST /api/offers/:id/publish`
6. `POST /api/batches/:id/offers/create`
7. `POST /api/batches/:id/offers/update-prices`
8. `POST /api/batches/:id/publish`
9. `DELETE /api/offers/:id`

### Listing monitoring and repricing

Routes:

1. `GET /api/ebay/listings`
2. `POST /api/ebay/listings/update-price`
3. `POST /api/ebay/listings/reprice`
4. `POST /api/reconcile-listings`
5. `POST /api/enable-best-offers`

### Sales reporting

Routes:

1. `GET /api/ebay/sales`

### Market heat and player insights

Routes:

1. `GET /api/ebay/market-heat`
2. `GET /api/ebay/market-heat/player-insight`

## Google Drive integration areas

Routes:

1. `GET /api/drive/auth-url`
2. `GET /api/drive/callback`
3. `GET /api/drive/status`
4. `POST /api/drive/disconnect`
5. `POST /api/drive/scan`
6. `POST /api/drive/import`
7. `POST /api/cleanup-listed-drive-cards`

Behavior:

1. The app pairs front/back card images by filename ending in `1` and `2`.
2. Drive tokens are persisted in `data/drive-tokens.json`.
3. Imported images are saved locally and optionally uploaded to Supabase Storage.
4. Cleanup routes can move or rename already-listed files/folders after publishing.

## Card and batch routes

Primary routes:

1. `POST /api/batches`
2. `GET /api/batches/:id`
3. `GET /api/batches/:id/cards`
4. `POST /api/batches/:id/process`
5. `POST /api/batches/:id/checklist`
6. `GET /api/card-items`
7. `GET /api/card-items/:id`
8. `PATCH /api/card-items/:id`
9. `POST /api/card-items/:id/review`
10. `POST /api/card-items/:id/process`
11. `POST /api/card-items/:id/approve`
12. `DELETE /api/card-items/:id`
13. `POST /api/card-items/:id/import-apify-comps`
14. `POST /api/card-items/:id/comp-toggle`

## Admin and diagnostics routes

Routes:

1. `GET /api/health`
2. `GET /health`
3. `GET /api/bootstrap`
4. `POST /api/seed`
5. `GET /api/export-state`
6. `POST /api/import-state`
7. `GET /api/debug/condition-policies`
8. `GET /files/:filename`

## Database schema

The relational schema is defined in [schema.sql](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/schema.sql).

Main tables:

1. `batches`
2. `card_items`
3. `card_images`
4. `card_identities`
5. `comps`
6. `offers`
7. `audit_events`
8. `counters`
9. `state_snapshots`
10. `cardhedge_cache`

Note:

`cardhedge_cache` is a generic keyed cache table (used by the market-heat feature) that predates the CardHedge removal. Renaming/dropping it is a live production schema change and hasn't been done yet — it's cosmetic only (the code just queries it by that literal table name via [src/lib/supabase.js](src/lib/supabase.js)) and can be revisited separately.

## Environment variables

The app loads a root-level `.env` automatically through [src/lib/load-env.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/lib/load-env.js).

### Core app

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port, default `3000` |
| `HOST` | HTTP host, default `localhost` |
| `NODE_ENV` | Enables secure session cookies in production |
| `SESSION_SECRET` | Signs the app session cookie |
| `ADMIN_EMAIL` | Optional email allowlist for app login |

### Google auth and Drive

| Variable | Purpose |
| --- | --- |
| `GOOGLE_DRIVE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_DRIVE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_AUTH_REDIRECT_URI` | Optional override for app login callback |
| `GOOGLE_DRIVE_REDIRECT_URI` | Optional override for Drive callback |
| `DRIVE_FOLDER_ID` | Default Drive folder to import from |
| `GOOGLE_DRIVE_IMPORT_CONCURRENCY` | Drive import concurrency |

### Supabase

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key |
| `SUPABASE_ENABLE_RELATIONAL_SYNC` | Set to `1` to mirror relational tables |
| `SUPABASE_IO_TIMEOUT_MS` | Timeout for snapshot I/O |
| `SUPABASE_FULL_SYNC_TIMEOUT_MS` | Timeout for relational sync |
| `READ_STORE` | Set to `local` to force local JSON reads |

### eBay auth and Sell APIs

| Variable | Purpose |
| --- | --- |
| `EBAY_ENV` | `production` or `sandbox` |
| `EBAY_CLIENT_ID` | eBay client ID |
| `EBAY_CLIENT_SECRET` | eBay client secret |
| `EBAY_USER_ACCESS_TOKEN` | Active user token |
| `EBAY_USER_TOKEN` | Legacy alias for user token |
| `EBAY_REFRESH_TOKEN` | Refresh token for user auth |
| `EBAY_AUTH_SCOPES` | Override requested OAuth scopes |
| `EBAY_REDIRECT_URI` | Explicit auth callback URI |
| `EBAY_REDIRECT_HOST` | Host override for callback construction |
| `EBAY_RUNAME` | eBay RuName |
| `EBAY_RU_NAME` | Alternate env name for RuName |
| `EBAY_MARKETPLACE_ID` | Marketplace, default `EBAY_US` |
| `EBAY_MERCHANT_LOCATION_KEY` | Inventory location |
| `EBAY_PAYMENT_POLICY_ID` | Payment policy |
| `EBAY_FULFILLMENT_POLICY_ID` | Default fulfillment policy |
| `EBAY_FULFILLMENT_POLICY_GROUND_ADVANTAGE_ID` | Ground Advantage policy |
| `EBAY_FULFILLMENT_POLICY_LESS_THAN_20_ID` | Low-price policy |
| `EBAY_FULFILLMENT_POLICY_LESS_THAN_20_MACHINEABLE_ID` | Low-price machineable policy |
| `EBAY_RETURN_POLICY_ID` | Return policy |
| `EBAY_CATEGORY_ID` | Default sports card category |
| `EBAY_TCG_CATEGORY_ID` | Trading card game category |
| `EBAY_NONSPORT_TRADING_CARD_CATEGORY_ID` | Non-sport trading card category |

### eBay read-side tuning

| Variable | Purpose |
| --- | --- |
| `EBAY_BROWSE_ACTIVE_COUNT` | Active comp count target |
| `EBAY_BROWSE_SOLD_COUNT` | Sold comp count target for browse lookups |
| `EBAY_ACTIVE_SOURCE_TIMEOUT_MS` | Active listing source timeout |
| `EBAY_ACTIVE_LISTINGS_TIMEOUT_MS` | Listings page timeout |
| `EBAY_SALES_ANALYTICS_TIMEOUT_MS` | Sales reporting timeout |

### Apify sold comps and market heat

| Variable | Purpose |
| --- | --- |
| `APIFY_TOKEN` | Apify API token |
| `APIFY_EBAY_SOLD_ACTOR_ID` | Sold-listings actor, default `caffein.dev~ebay-sold-listings` |
| `APIFY_EBAY_SOLD_DAYS_TO_SCRAPE` | Sold listing lookback |
| `APIFY_EBAY_SOLD_COUNT` | Base sold comp count target |
| `APIFY_EBAY_SITE` | eBay site, default `ebay.com` |
| `APIFY_EBAY_SORT_ORDER` | Sort order |
| `APIFY_EBAY_ITEM_LOCATION` | Item location filter |
| `APIFY_MARKET_HEAT_SAMPLE_SIZE` | Market heat sample size |
| `MARKET_HEAT_DEFAULT_LIMIT` | Default leaderboard size |
| `MARKET_HEAT_REFRESH_MS` | Market heat cache TTL |

### SoldComps (per-card sold comps)

CardHedge and the never-fully-deployed "CardSight" rename have been fully removed — SoldComps is now the sole per-card sold-comp provider, with no fallback.

| Variable | Purpose |
| --- | --- |
| `SOLDCOMPS_API_KEY` | SoldComps API key |
| `SOLDCOMPS_DAYS_TO_SCRAPE` | Sold listing lookback (falls back to `APIFY_EBAY_SOLD_DAYS_TO_SCRAPE`) |
| `SOLDCOMPS_COUNT` | Sold comp count target (falls back to `APIFY_EBAY_SOLD_COUNT`) |
| `SOLDCOMPS_EBAY_SITE` | eBay site (falls back to `APIFY_EBAY_SITE`) |
| `SOLDCOMPS_SORT_ORDER` | Sort order (falls back to `APIFY_EBAY_SORT_ORDER`) |
| `SOLDCOMPS_ITEM_LOCATION` | Item location filter (falls back to `APIFY_EBAY_ITEM_LOCATION`) |
| `SOLDCOMPS_CATEGORY_ID` | eBay category ID, default `0` |
| `SOLDCOMPS_MONTHLY_REQUEST_LIMIT` | Local monthly request cap, currently 2000 to match the live plan |
| `SOLDCOMPS_REPRICE_LOOKUP_TIMEOUT_MS` | Background reprice hydration lookup timeout |
| `SOLDCOMPS_REPRICE_QUEUE_PAUSE_MS` | Background reprice queue pause between jobs |
| `SOLDCOMPS_REPRICE_SCHEDULES_PER_LOAD` | Max offer hydrations scheduled per `/api/ebay/listings` load |
| `SOLDCOMPS_MANUAL_REPRICE_TIMEOUT_MS` | Manual reprice route lookup timeout |

### OCR / vision

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Enables OpenAI vision helpers |
| `OPENAI_VISION_MODEL` | Vision model name |
| `LOCAL_VISION_OCR` | Toggle macOS Vision OCR |
| `LOCAL_VISION_OCR_TIMEOUT_MS` | Timeout for local Vision OCR |
| `SURYA_OCR` | Toggle Surya OCR |
| `SURYA_OCR_BIN` | Surya CLI path |
| `SURYA_OCR_TIMEOUT_MS` | Surya timeout |
| `SURYA_RUNTIME_HOME` | Runtime HOME override for Surya |
| `SURYA_GGUF_LOCAL_MODEL_PATH` | Optional local model path |
| `SURYA_GGUF_LOCAL_MMPROJ_PATH` | Optional local mmproj path |
| `XDG_CACHE_HOME` | Model cache root |
| `MODEL_CACHE_DIR` | Model cache directory |
| `HF_HUB_OFFLINE` | Offline model mode |

### Pipeline tuning

| Variable | Purpose |
| --- | --- |
| `CARD_PROCESS_CONCURRENCY` | Batch processing concurrency |

### Background schedulers and monitoring

All off by default — see [src/server.js](src/server.js).

| Variable | Purpose |
| --- | --- |
| `SALES_SYNC_INTERVAL_MINUTES` | Enables the eBay sales sync scheduler; set to minutes between runs |
| `REPRICE_INTERVAL_MINUTES` | Enables the unsold-listing repricing scheduler |
| `DATA_HEALTH_CHECK_INTERVAL_MINUTES` | Enables the data-quality scan (see [src/jobs/data-health-check.js](src/jobs/data-health-check.js)) |
| `UPTIME_KUMA_PUSH_URL_SALES_SYNC` | Optional Uptime Kuma Push-monitor URL pinged after each sales-sync run |
| `UPTIME_KUMA_PUSH_URL_REPRICE` | Same, for the repricing scheduler |
| `UPTIME_KUMA_PUSH_URL_DATA_HEALTH_CHECK` | Same, for the data health check |

## Local setup

1. Install Node.js 20+.
2. Run `npm install`.
3. Create a root `.env`.
4. Start the app with `npm run dev` or `npm start`.
5. Open [http://localhost:3000](http://localhost:3000).

## Suggested minimum `.env` for basic local work

```bash
PORT=3000
HOST=localhost
NODE_ENV=development
SESSION_SECRET=change-me
ADMIN_EMAIL=you@example.com
GOOGLE_DRIVE_CLIENT_ID=
GOOGLE_DRIVE_CLIENT_SECRET=
APIFY_TOKEN=
EBAY_ENV=production
EBAY_CLIENT_ID=
EBAY_CLIENT_SECRET=
EBAY_MARKETPLACE_ID=EBAY_US
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run local dev server with watch mode |
| `npm start` | Run production-style server |
| `npm test` | Run Node test suite |
| `npm run test:coverage` | Run tests with coverage |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run format` | Run Prettier |
| `npm run format:check` | Check formatting |

## Tests

Current tests live in `tests/`:

1. `tests/apify.test.js`
2. `tests/matching.test.js`
3. `tests/ocr.test.js`
4. `tests/pricing.test.js`

The existing suite covers utilities and parsing logic more than full integration behavior. There is not a comprehensive end-to-end test harness for auth, Drive import, eBay flows, or browser UI state.

## Supabase migration

The one-off migration script is [scripts/migrate.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/scripts/migrate.js).

What it does:

1. Reads `data/state.json`.
2. Verifies Supabase connectivity.
3. Clears destination tables.
4. Inserts batches, cards, images, comps, offers, and audit events.
5. Uploads image files to the `card-images` bucket.
6. Writes counters and a state snapshot.

## Directory map

| Path | Purpose |
| --- | --- |
| `src/` | Main app source |
| `src/services/` | Integrations and domain services |
| `src/jobs/` | Processing pipeline |
| `src/lib/` | State, storage, env, and HTTP helpers |
| `public/` | Static frontend |
| `data/` | Local JSON state, local image files, Drive tokens, backups |
| `scripts/` | Utilities such as Supabase migration |
| `tests/` | Node test suite |
| `output/`, `outputs/`, `tmp/`, `work/` | Working directories and generated artifacts |

## Important implementation notes for the next coder

1. The server is a plain Node HTTP app, not Express, Next.js, or Fastify.
2. Most product logic is concentrated in one very large file: [src/app.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/app.js) (~4,200 lines as of this writing, down from ~4,543). A `src/routes/` directory now holds two extractions, each verified behaviorally identical (auth gating, response shapes) before and after: [src/routes/drive-routes.js](src/routes/drive-routes.js) (`/api/drive/*` folder-scan/import) and [src/routes/ebay-oauth-routes.js](src/routes/ebay-oauth-routes.js) (`/api/ebay/auth-url`, `/api/ebay/auth-callback`, `/api/ebay/refresh-token`, `/api/ebay/reset-auth`, `/api/ebay/config`, `/api/ebay/setup`, `/api/ebay/auto-configure` — note `/api/ebay/generate-description` and the card-item ebay-preview/ebay-save routes stayed in app.js since they touch `withState`/cardItems rather than pure OAuth/config). Remaining natural split points: auth/session (`/auth/*`, `/login.html` etc. — more tangled with the core dispatch/auth-gating logic than the two done so far, so higher risk), eBay sales/market-heat (`/api/ebay/sales`, `/api/ebay/market-heat*`), eBay listings (`/api/ebay/listings*`), and batches/card-items (`/api/batches`, `/api/card-items`). Keep moving one group at a time, with a test run and a live smoke test after each. Some helpers (like `buildApifyLookupKey`, `buildExternalCompLookupMetadata`) are imported by `src/jobs/sales-sync.js` and `src/jobs/reprice-scheduler.js` and need to land somewhere both app.js and those jobs can still import from.
3. State and persistence are reliable enough to use, but the architecture is still transitional between local JSON and Supabase.
4. Provider naming is inconsistent in places because the code evolved from CardHedge to CardSight to Apify to SoldComps-backed flows (CardHedge/CardSight are now fully removed, but some identifiers still carry the historical "Apify" branding).
5. Trading-card support exists but is still layered on top of a sports-card-first schema.
6. There are duplicate files in the repo with ` 2` in the filename such as `Dockerfile 2`, `schema 2.sql`, `auth 2.js`, and `drive 2.js`. These appear to be stale copies or alternates and should be treated carefully before deletion.
7. Browser/UI behavior depends on app state and authentication, so debugging often requires checking both the route handler and `data/state.json` or Supabase snapshot state.

## Known rough edges

1. `src/app.js` is too large and owns too many responsibilities.
2. Comp/pricing code still carries function/variable naming from earlier provider generations (CardHedge, the never-fully-deployed CardSight rename, and Apify) even though CardHedge/CardSight have been fully removed and SoldComps is the sole per-card sold-comp provider today — see the naming note at the top of [src/services/apify.js](src/services/apify.js).
3. OCR and parallel detection are still the most brittle parts of the workflow.
4. ~~There is no strong integration-test coverage for live eBay and Google flows.~~ Partial improvement: [tests/ebay-oauth.test.js](tests/ebay-oauth.test.js) covers the eBay OAuth code-exchange and refresh-token flows end-to-end against a mocked `fetch` boundary (real request shape, real success/error response handling). Google Drive's OAuth/API calls go through the `googleapis` client rather than a mockable `fetch()`, so testing that flow the same way would need an HTTP-mocking dependency (e.g. `nock`) that isn't currently installed — [tests/drive-match-pairs.test.js](tests/drive-match-pairs.test.js) covers the pure front/back image-pairing logic that flow depends on instead. Listing creation/publish and order-sync flows are still untested.
5. ~~The persistence model should eventually be simplified so there is a clearer primary store.~~ Decided: local JSON is the live source of truth, Supabase is a durability mirror. See "Source of truth and storage behavior" above.

## Recommended handoff priorities

1. Break `src/app.js` into route modules.
2. Normalize comp provider naming to one current vocabulary.
3. ~~Decide whether local JSON or Supabase is the long-term source of truth.~~ Decided — see "Source of truth and storage behavior" above.
4. Add integration smoke tests for Drive import, card processing, eBay listing sync, and sales reporting.
5. Harden trading-card OCR and parallel detection.
6. Add a proper `.env.example` file if this repo will be shared more broadly.

## Quick start for a new engineer

1. Read this README.
2. Read [src/app.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/app.js) and [src/lib/store.js](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/src/lib/store.js) first.
3. Review [schema.sql](/Users/codywise/Desktop/Projects/Personal/automatic-sports-card-listing-i-want/schema.sql) and confirm current Supabase tables.
4. Confirm `.env` values for Google, eBay, Apify, and Supabase.
5. Start the app with `npm run dev`.
6. Verify login, Drive status, eBay status, card processing, listings, sales, and market heat in that order.
