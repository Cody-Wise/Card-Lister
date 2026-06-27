# Automatic Sports Card Listing - Project Handoff

Current date: 2026-06-08

This repo is a local web app for bulk sports card intake, OCR/vision extraction, sold-comp lookup, price calculation, review/editing, and eventual eBay listing creation/publishing. It is designed to let a seller photograph many cards, review or correct the extracted metadata, see the pricing evidence, and then move the cards through eBay inventory and publish flows.

## What the app does

The app supports this loop:

1. Create a batch.
2. Upload front/back images for many cards.
3. Extract card metadata with OCR and OpenAI vision.
4. Match the card against a canonical catalog entry.
5. Pull sold comps from Apify and active listings from eBay Browse.
6. Calculate a recommended price.
7. Store the exact comps used for pricing.
8. Review and edit the card in a dedicated panel.
9. Create eBay draft offers, update prices, and publish.

The codebase is currently in a good working state and the test suite is green.

## Stack

- Node.js ESM app
- No external database; runtime state is stored in JSON on disk
- Local web UI in `public/`
- eBay Inventory API and Browse API integration
- Apify sold-listings actor integration
- OpenAI vision for metadata extraction

## Important runtime files

- [`package.json`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/package.json)
- [`src/server.js`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/src/server.js)
- [`src/app.js`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/src/app.js)
- [`src/jobs/pipeline.js`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/src/jobs/pipeline.js)
- [`src/services/ocr.js`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/src/services/ocr.js)
- [`src/services/apify.js`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/src/services/apify.js)
- [`src/services/ebay-browse.js`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/src/services/ebay-browse.js)
- [`src/services/ebay.js`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/src/services/ebay.js)
- [`src/services/pricing.js`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/src/services/pricing.js)
- [`src/services/matching.js`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/src/services/matching.js)
- [`public/index.html`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/public/index.html)
- [`public/app.js`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/public/app.js)
- [`public/styles.css`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/public/styles.css)
- [`tests/*.test.js`](/Users/codywise/Documents/Codex/2026-06-07/automatic-sports-card-listing-i-want/tests)

## Local run

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

For dev mode with restart-on-change:

```bash
npm run dev
```

For tests:

```bash
npm test
```

## Environment variables

Secrets live in a root-level `.env` file next to `package.json`. The app auto-loads it on startup.

### eBay

Required for live listing creation and publishing:

```bash
EBAY_ENV=production
EBAY_CLIENT_ID=...
EBAY_CLIENT_SECRET=...
EBAY_USER_ACCESS_TOKEN=...
EBAY_MARKETPLACE_ID=EBAY_US
EBAY_MERCHANT_LOCATION_KEY=...
EBAY_CATEGORY_ID=261328
EBAY_PAYMENT_POLICY_ID=...
EBAY_FULFILLMENT_POLICY_ID=...
EBAY_RETURN_POLICY_ID=...
```

### OpenAI

Required for vision extraction:

```bash
OPENAI_API_KEY=...
OPENAI_VISION_MODEL=gpt-4.1
```

### Apify

Required for sold-comp lookup:

```bash
APIFY_TOKEN=...
APIFY_EBAY_SOLD_ACTOR_ID=caffein.dev~ebay-sold-listings
APIFY_EBAY_SOLD_DAYS_TO_SCRAPE=60
APIFY_EBAY_SOLD_COUNT=10
APIFY_EBAY_SITE=ebay.com
APIFY_EBAY_SORT_ORDER=endedRecently
APIFY_EBAY_ITEM_LOCATION=default
```

## Core data model

There is no relational schema; state is stored in `data/state.json`.

Main collections:

- `batches`
- `cardItems`
- `cardImages`
- `cardIdentities`
- `comps`
- `offers`
- `auditEvents`

Image files are saved to `data/images/`.

## Data flow

### 1. Upload

The UI creates a batch and uploads front/back images for one or more cards.

Important user hints supported at upload and review time:

- `Base / no variation`
- `Auto / autograph`
- `Rookie / RC`
- `Rated Rookie`
- `Thick card`
- `Parallel`
- `Print run`
- `Serial`

Serial-numbered cards are normalized so search uses the denominator, e.g. `002/049` becomes `/49` in comp queries.

### 2. OCR / vision

`src/services/ocr.js` does:

- heuristic extraction when no vision is available
- OpenAI vision extraction when `OPENAI_API_KEY` is set
- a follow-up parallel probe when the card looks like a parallel-heavy product and the first pass misses the colorway

OCR returns:

- player name
- year
- set name
- card number
- parallel
- rookie flag / variant label
- autograph flag
- grade / graded flag
- serial number
- print run
- confidence

### 3. Canonical matching

`src/services/matching.js` maps extracted metadata to a canonical catalog entry from `src/data/seed.js`.

This matters because:

- sold comps from the seeded catalog are keyed off canonical IDs
- the UI and pricing logic use the canonical match to decide what lane the card belongs in

### 4. Sold comps

Sold comps come from:

- seeded local comps in `src/data/seed.js`
- Apify sold listing lookups
- manual Apify imports through the review UI

Apify search is intentionally capped to keep cost down:

- look back 60 days
- max 10 results

The query builder is opinionated:

- year-first
- no literal quote wrapping
- serials search by denominator
- autograph hints add `Autograph` and `Auto` search terms
- rookie cards split into `Rookie RC` versus `Rated Rookie RC`
- numbered cards only use the variant lane when the variant is actually known

### 5. Active listings

`src/services/ebay-browse.js` searches current eBay listings.

This is used as a market heat check, not as a substitute for sold comps. The app blends active listings into price only when the active market is clearly hotter than sold comps.

### 6. Pricing

`src/services/pricing.js` calculates:

- recommended price
- sold median / p25
- active median / p25 / floor
- confidence
- strategy
- reason
- the evidence bundle used to make the decision

Current pricing behavior:

- sold comps anchor the price
- active listings only nudge the price upward when the active market is clearly hotter
- numbered cards are conservative unless the exact variant is also known
- autographed cards are treated as an exact variant lane

### 7. Review / edit

The review panel is a first-class workflow now. You can edit:

- player
- year
- set
- card number
- parallel
- rookie mode
- base hint
- autograph hint
- thick card
- print run
- serial
- grade
- notes

The panel also shows the pricing evidence:

- sold comps used
- active listings checked
- clickable `Open listing` links for each comp

### 8. eBay listing flow

`src/services/ebay.js` handles draft offer creation, price updates, and publish flow.

The app expects:

- a seller user token
- merchant location key
- business policy IDs

## Key behaviors worth knowing

### Autograph / auto handling

`auto` in hints means autograph. It is recognized from:

- upload row hint checkbox
- review panel hint checkbox
- notes text
- OCR / vision

When autograph is present:

- search queries include autograph-specific terms
- matching expects autograph-aware listings
- pricing treats it as part of the exact variant lane

### Serial / print-run handling

If a card is numbered, the app should search the denominator:

- `002/150` -> `/150`
- `32/49` -> `/49`

This is used in both Apify and Browse queries.

### Rookie handling

The app distinguishes:

- generic rookie / RC
- Rated Rookie

That difference matters because many products use `RC`, but only certain sets are truly `Rated Rookie`.

### Base / variation handling

If the card is marked as base, the app avoids variant lanes.

### Parallel handling

Parallel is treated as a real price lane:

- `Blue Refractor`
- `Blue Wave`
- `Holo`
- `Silver Prizm`
- etc.

If the parallel is not known, the code is intentionally cautious about inventing one.

## File map by responsibility

- `src/server.js` - server bootstrap and env loading
- `src/app.js` - HTTP routes and batch/card/review endpoints
- `src/jobs/pipeline.js` - OCR, matching, comps, pricing, and card processing
- `src/services/ocr.js` - heuristic and OpenAI vision extraction
- `src/services/matching.js` - canonical card matching
- `src/services/apify.js` - Apify sold-comp queries and filtering
- `src/services/ebay-browse.js` - eBay Browse active listing queries
- `src/services/comps.js` - local comps and live comp aggregation
- `src/services/pricing.js` - price calculations and evidence bundle
- `src/services/ebay.js` - Inventory API listing creation/update/publish
- `src/services/ebay-setup.js` - setup discovery for inventory location and policies
- `src/lib/store.js` - JSON state persistence
- `src/lib/storage.js` - image storage handling
- `public/app.js` - UI logic
- `public/index.html` - app layout
- `public/styles.css` - layout and visual styling

## Current state and caveats

- The app uses a file-backed JSON store, so it is not yet multi-user safe.
- Runtime data and uploaded images live in `data/`, not in a database.
- eBay Browse is only used as a current market signal.
- Apify is the main sold-comp source in this build, but it is still a third-party actor, so treat it as a dependency rather than a guaranteed API contract.
- The review panel is the place to correct OCR or matching misses before publishing.

## Tests

The test suite covers:

- pricing behavior
- base versus variation handling
- rookie lane handling
- autograph handling
- numbered serial handling
- Apify sold-comp parsing and query generation
- OpenAI OCR fallback and partial-vision behavior

Run:

```bash
npm test
```

## Practical onboarding advice

If someone new picks this up, the best order is:

1. Read `README.md` for startup basics.
2. Open `public/index.html` and `public/app.js` to see the UI and flows.
3. Read `src/jobs/pipeline.js` to understand the end-to-end card processing path.
4. Read `src/services/ocr.js`, `src/services/apify.js`, and `src/services/ebay-browse.js` for the extraction and comp logic.
5. Inspect `tests/*.test.js` for the intended behavior on the tricky edge cases.

## Suggested next improvements

1. Show the pricing evidence sorted by strongest match first.
2. Add a manual override for comp inclusion/exclusion in the review panel.
3. Split pricing evidence into sold versus active with a richer explanation of the weighting math.
4. Add persistent export/import for state if the app needs to survive machine changes.
5. Add a “publish-ready” checklist before batches are pushed live.
