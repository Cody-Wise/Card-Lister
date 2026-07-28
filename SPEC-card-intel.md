# Sports Card Presale Intelligence Layer — Build Spec

Standalone acquisition tool — deliberately NOT wired into the card lister or its inventory. Goal: know a product exists and is buyable at or near MSRP **before** it opens to the public and secondary pricing inflates.

Stack: Contabo VDS — PostgreSQL, Windmill, n8n. Gemini Flash for extraction (no local inference). Signal group alerts via the existing `signal-api` container.

Scope: Tier A (announcements) + Tier B (distributor catalogs) + release calendar. Mass retail (Target/Walmart) explicitly out of scope.

---

## 1. Architecture

Three independent feeds converging on one `product_keys` table:

```
Zoho IMAP ──> n8n ──> email_ingest ──> Gemini extract ──┐
                                                         ├──> product_keys ──> hot_list ──> alerts
Release calendars ──> Windmill weekly ──> releases ──────┤
                                                         │
Distributor catalogs ──> Windmill sweep ──> products ────┘
                                  └──> product_snapshots
```

The join key is `product_keys` = `(year, manufacturer, brand, sport, config)`. Everything depends on this normalizing correctly; see §5.

**The loop that produces the money signal:** an announcement email creates a `product_key` and a watch with no product rows behind it. When a catalog sweep first sees a product resolving to that key, that's `presale_live` — fire immediately. Lead time between the email and the catalog appearance is typically hours, sometimes a day.

---

## 2. Database schema

```sql
CREATE TABLE retailers (
  id            serial PRIMARY KEY,
  slug          text UNIQUE NOT NULL,
  name          text NOT NULL,
  base_url      text NOT NULL,
  platform      text,                    -- shopify | woocommerce | bigcommerce | custom
  adapter       text NOT NULL,           -- windmill script path
  poll_tier     text DEFAULT 'b',
  active        boolean DEFAULT true,
  etag          text,                    -- last catalog ETag, for conditional GET
  last_sweep_at timestamptz,
  notes         text
);

CREATE TABLE product_keys (
  id             serial PRIMARY KEY,
  year           int,
  manufacturer   text,                   -- topps | panini | upper_deck | leaf | ...
  brand          text,                   -- chrome | prizm | optic | series_one | ...
  sport          text,                   -- baseball | football | basketball | hockey | soccer | multi
  config         text,                   -- hobby_box | jumbo_box | blaster | mega | case | hanger | retail_box
  canonical_name text,
  created_at     timestamptz DEFAULT now(),
  UNIQUE (year, manufacturer, brand, sport, config)
);

CREATE TABLE products (
  id             bigserial PRIMARY KEY,
  retailer_id    int REFERENCES retailers(id),
  external_id    text NOT NULL,          -- shopify product id, woo id, or url hash
  variant_id     text,                   -- shopify variant id, for cart deep-link
  url            text NOT NULL,
  title          text NOT NULL,
  vendor         text,                   -- shopify `vendor` — often the manufacturer, free signal
  tags           text[],                 -- shopify tags — presale/preorder flags live here
  product_key_id int REFERENCES product_keys(id),
  first_seen_at  timestamptz DEFAULT now(),
  last_seen_at   timestamptz DEFAULT now(),
  UNIQUE (retailer_id, external_id)
);

CREATE TABLE product_snapshots (
  product_id  bigint REFERENCES products(id),
  ts          timestamptz DEFAULT now(),
  price_cents int,
  available   boolean,
  is_presale  boolean DEFAULT false
);
CREATE INDEX ON product_snapshots (product_id, ts DESC);

CREATE TABLE releases (
  id             serial PRIMARY KEY,
  product_key_id int REFERENCES product_keys(id),
  release_date   date,
  msrp_cents     int,
  source         text,                   -- calendar source slug
  confidence     numeric,
  updated_at     timestamptz DEFAULT now(),
  UNIQUE (product_key_id, source)
);

CREATE TABLE email_ingest (
  id           bigserial PRIMARY KEY,
  message_id   text UNIQUE NOT NULL,     -- idempotency guard
  from_addr    text,
  subject      text,
  received_at  timestamptz,
  body_text    text,
  body_hash    text,                     -- sha256, extraction cache key
  processed_at timestamptz
);

CREATE TABLE release_announcements (
  id              bigserial PRIMARY KEY,
  email_id        bigint REFERENCES email_ingest(id),
  product_key_id  int REFERENCES product_keys(id),
  retailer_id     int REFERENCES retailers(id),
  presale_open_at timestamptz,
  street_date     date,
  price_cents     int,
  url             text,
  confidence      numeric,
  created_at      timestamptz DEFAULT now()
);

CREATE TABLE alerts (
  id             bigserial PRIMARY KEY,
  alert_type     text NOT NULL,          -- announcement | presale_live | restock | price_low
  product_id     bigint REFERENCES products(id),
  product_key_id int REFERENCES product_keys(id),
  payload        jsonb,
  fired_at       timestamptz DEFAULT now()
);
CREATE INDEX ON alerts (alert_type, product_key_id, fired_at DESC);

CREATE TABLE title_extractions (
  body_hash      text PRIMARY KEY,       -- sha256 of raw title
  product_key_id int REFERENCES product_keys(id),
  confidence     numeric,
  model          text,
  created_at     timestamptz DEFAULT now()
);
```

**Hot list** — a view, not a table:

```sql
CREATE VIEW hot_list AS
SELECT DISTINCT p.id, p.retailer_id, p.url, p.external_id
FROM products p
JOIN product_keys pk ON pk.id = p.product_key_id
LEFT JOIN releases r ON r.product_key_id = pk.id
LEFT JOIN release_announcements ra ON ra.product_key_id = pk.id
WHERE r.release_date BETWEEN now() - interval '14 days' AND now() + interval '60 days'
   OR ra.created_at > now() - interval '14 days';
```

---

## 3. Tier A — Zoho email ingestion

Highest signal-to-effort feed in the system. Nobody can rate-limit or block it.

### Zoho setup (manual, once)

1. Zoho Mail → Settings → Mail Accounts → **enable IMAP Access**.
2. Zoho Mail → Security → **App Passwords** → generate one for n8n. The account password will not work if 2FA is on.
3. Create folder `CardDrops`.
4. Server-side filter: route mail from the subscription list (§3.1) into `CardDrops`. Doing this in Zoho rather than n8n keeps the IMAP trigger cheap and keeps the rest of the Bigfoot inbox out of the pipeline entirely.
5. IMAP host: `imap.zoho.com:993` SSL. Paid Zoho Workplace tenants sometimes need `imappro.zoho.com` — verify by connecting once before wiring n8n.

### 3.1 Subscription list

Subscribe the Bigfoot address to, at minimum: every distributor in §4, plus Topps, Panini, Upper Deck, Leaf newsletters, plus Beckett and Cardboard Connection mailers. Use the same address everywhere — no plus-addressing, some senders reject it.

### 3.2 n8n workflow: `card-email-ingest`

```
Email Trigger (IMAP)          folder=CardDrops, action=mark read (do NOT delete)
  → Function: html→text, collapse whitespace, truncate to 12k chars, sha256 body_hash
  → Postgres: INSERT INTO email_ingest ... ON CONFLICT (message_id) DO NOTHING RETURNING id
  → IF no id returned → stop (already seen)
  → Postgres: SELECT from extraction cache by body_hash → if hit, reuse, skip LLM
  → HTTP Request: Gemini Flash, structured output (§3.3)
  → Function: validate + split array into items
  → Postgres: upsert product_keys, insert release_announcements
  → IF any row has presale_open_at <= now() + 48h → Signal (§7.1)
```

Mark-as-read rather than delete: `email_ingest` becomes a permanent training corpus for tuning the extraction prompt, and you can replay it.

### 3.3 Extraction call

Model: `gemini-2.5-flash`. `responseMimeType: application/json` with an explicit `responseSchema`. One email frequently announces several products, so the top level is an array.

```json
{
  "type": "object",
  "properties": {
    "is_release_announcement": { "type": "boolean" },
    "retailer_hint": { "type": "string" },
    "products": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "year":            { "type": "integer" },
          "manufacturer":    { "type": "string", "enum": ["topps","panini","upper_deck","leaf","onyx","other"] },
          "brand":           { "type": "string" },
          "sport":           { "type": "string", "enum": ["baseball","football","basketball","hockey","soccer","racing","multi","other"] },
          "config":          { "type": "string", "enum": ["hobby_box","jumbo_box","blaster","mega","hanger","retail_box","case","other"] },
          "presale_open_at": { "type": "string", "description": "ISO 8601 or null" },
          "street_date":     { "type": "string", "description": "ISO 8601 date or null" },
          "price_usd":       { "type": "number" },
          "url":             { "type": "string" },
          "confidence":      { "type": "number" }
        },
        "required": ["manufacturer","brand","config","confidence"]
      }
    }
  },
  "required": ["is_release_announcement","products"]
}
```

System prompt requirements:
- Return `is_release_announcement: false` and an empty array for anything that is not a new-product or presale announcement. Most newsletter volume is singles, breaks, supplies, and general marketing — the filter carries a lot of weight here.
- Never invent dates. Null beats a guess; a wrong `street_date` poisons the hot list.
- Emit one entry per configuration. "Hobby, Jumbo, and Blaster now up" is three entries, not one.
- Today's date must be injected into the prompt so relative language ("drops next Tuesday") resolves.

Write `confidence < 0.6` rows to `release_announcements` but do not alert on them. Review weekly and fold the failure patterns into the prompt.

---

## 4. Tier B — distributor adapters

### 4.1 Probe results (measured 2026-07-28)

Probed, don't assume — and the assumption in the original draft was wrong. Actual results:

| Domain | Platform | Reachable? | Notes |
|---|---|---|---|
| blowoutcards.com | custom | **yes** | HTTP 200, 41KB, 508 product nodes |
| dacardworld.com | Magento + Cloudflare | **yes** | 403 interstitial that clears to 200 after ~10s; 108KB, real prices |
| steelcitycollectibles.com | Magento + Cloudflare | **yes** | document stays 403 while serving real prices; also publishes a **product-release-calendar** page (useful for §6) |
| bbcexchange.com | **Shopify** | yes | `products.json` works — the only true 30-line adapter |
| atlantasportscards.com | ? | no | resolves but connection fails |
| pureandvintage.com | — | no | **no DNS record** |
| cardboardkingdom.com | — | no | **no DNS record** |
| rockhoundcards.com | — | no | **no DNS record** |

Three seed domains in the original draft do not exist. Plain `curl` gets 403 from the three big real ones.

**What works: Camoufox + sticky residential proxy. CapSolver is NOT needed.** Camoufox is an anti-detect Firefox that avoids *triggering* the challenge; CapSolver only helps once one is displayed, and its extension is Chrome/MV3 so it cannot load in Firefox anyway. Verified through all three walls.

**HTTP status is not a usable success signal here.** DACardWorld returns 403 then settles to 200; Steel City serves a 403 document containing real prices. Judge success on *presence of product data* (prices, product links), never on status code. An adapter that trusts the status will report false failures.

### 4.2 Adapter contract

Every adapter is a Windmill script exporting two functions:

```ts
// returns full catalog snapshot
discover(retailer): Promise<RawProduct[]>

// hot poll, single product, minimal request
check(retailer, external_id): Promise<{ price_cents, available, is_presale }>

type RawProduct = {
  external_id: string
  variant_id?: string
  url: string
  title: string
  vendor?: string
  tags?: string[]
  price_cents: number
  available: boolean
  is_presale: boolean
}
```

Only bbcexchange.com can use the cheap Shopify path (`/products.json?limit=250&page=N` paginated, `If-None-Match` with the stored `etag`, most sweeps 304).

The three big distributors need a **Camoufox + residential-proxy adapter** reading rendered category pages: navigate, wait for the Cloudflare interstitial to settle (~10s), then extract from JSON-LD where present and the product DOM otherwise. Reuse the browser/proxy pattern from the lister's `src/services/dacardworld.js`, but with Camoufox instead of Chromium+CapSolver — it clears these walls without the extension.

**Presale detection on Shopify** is mostly in `tags` and `product_type` — look for `presale`, `pre-order`, `preorder`, plus a `body_html` regex for ship-date language (`ships (on|by|around) ...`, `release date`). Set `is_presale` from that; it materially changes how you read an `available: true`.

### 4.3 Schedules (Windmill)

| Script | Cadence | Notes |
|---|---|---|
| `sweep_catalog` | **2x/day** | **CATEGORY PAGES ONLY** — not full catalogs. All active Tier B retailers, jittered start, one browser at a time |
| `normalize_titles` | 5 min | drains products with null `product_key_id`; cheap, no network |
| `scrape_calendars` | weekly | §6 |
| `prune_snapshots` | daily | collapse unchanged snapshots older than 30 days to daily granularity |

**`poll_hot` is deliberately NOT scheduled.** The original 60-second per-product poll assumed cheap HTTP. Every request now costs a full browser through a metered residential proxy, so a per-product hot poll is the single most expensive thing this system could do. If sub-daily availability tracking is ever needed, add it for a hand-picked handful of keys — never the whole `hot_list`.

**Cost rationale for 2x/day + category pages:** each fetch is a real browser page load billed per GB on DataImpulse. The lister's Apify history is the cautionary tale — an unattended job on a short cadence quietly ran up a week of spend before anyone noticed. Twice daily across three retailers, category pages only, keeps this in the noise.

Politeness: identifying User-Agent with a contact address, exponential backoff on 429/503, hard circuit-breaker that deactivates a retailer after 5 consecutive failures and pings the same Signal group (a silently dead adapter is worse than a noisy one). These are businesses you buy from — getting IP-banned from Blowout costs more than the feed is worth.

`product_snapshots` only gets a row when `(price_cents, available, is_presale)` differs from the latest snapshot for that product. Unchanged sweeps write nothing.

---

## 5. Normalization

The hard part. Two passes:

**Pass 1 — regex/rules, targets ~70% coverage.** Year is a leading 4-digit or 2-digit token. Manufacturer often comes free from Shopify `vendor`. Config from a keyword table (`hobby box`, `hobby`, `jumbo`, `hta`, `blaster`, `mega`, `hanger`, `case`, `12 box case`). Brand from a curated list of known brands per manufacturer — maintain this by hand, it's a few hundred rows and it's worth it.

**Pass 2 — Gemini Flash** for the remainder, same structured-output pattern as §3.3 minus the date fields. Cache in `title_extractions` keyed on `sha256(title)`, so each distinct title costs one call ever. At distributor catalog sizes this is a few dollars total, then near zero.

Log every pass-2 result. When a pattern recurs, promote it into pass 1.

---

## 6. Release calendar — BUILT 2026-07-28

`/root/cardintel/release_calendar.py`, run weekly by cron (`run_calendar.sh`, Mondays 06:17) rather than Windmill, matching how Tier A ingest is already scheduled. No browser and no LLM: both live sources are plain HTTP, and calendar titles are formulaic enough for a deterministic parser (100% parse rate on the live run, so there is nothing for a model to do).

**Sources actually used** — the ones named in the original draft mostly did not survive contact:

| Source | Result |
|---|---|
| `sportscardradio.com/release-calendar` | **USED.** Ships its calendar as a `const RELEASES = [...]` JS literal — clean structured JSON. 49 rows in window. |
| `checklistinsider.com/release-calendar` | **USED.** `release-date-stamp` divs with ISO `<time datetime>`; page 1 is ordered upcoming-first and covers the whole forward window. 78 rows. |
| `cardboardconnection.com/new-release-calender` | **Defined but disabled.** Note the misspelled real path. Its untitled "New Releases" table is still the **2025** calendar and its year headings stop at 2025, so it contributes nothing forward-looking. Do NOT "fix" this by assuming the current year for that table — it would stamp 2025 products with 2026 dates. Re-enable with `--source` once the site rolls over. |
| `beckett.com/news/sports-card-release-calendar-dates/` | **Unusable.** 200, but no machine-readable dates; the apparent dates are image-URL path segments (`.../2026/07/...`). |
| topps.com, paniniamerica.net, dacardworld, steelcitycollectibles | **403 (Cloudflare).** Would need the Camoufox path; not worth it while two plain-HTTP sources work. |

Sources are kept separate, never merged on write (`releases` is unique on `(product_key_id, source)`). Alerts on any `release_date` that moves ≥7 days, and reports cross-source disagreement of ≥7 days on the same product — the first live run found **2026 Upper Deck MVP hockey at Aug 5 vs Aug 26, a 21-day spread between the two sources.**

Two things the first live run forced, both worth keeping:
- **Bounded window** (`RELEASE_LOOKBACK_DAYS`, default 120). Cardboard Connection is a full archive back to 2018; unbounded ingest wrote 2,275 dead rows and buried the 45 upcoming ones.
- **In-run dedupe** before any DB write. A source that lists one product line on several dates otherwise overwrites itself within a single run and reports it as a "date move" — a false alert that would page Signal every single run.
- **Brand hygiene is load-bearing, not cosmetic.** Checklist Insider titles end in a bare "… Baseball Guide" as often as "… Checklist Guide", and since the sport is cut out of the *middle* of the title, that trailing word lands on the end of the brand ("Prizm Guide"). A polluted brand yields a different `product_key` than the same product from another source, which silently defeats the cross-source comparison. Fixing it immediately exposed a **35-day** disagreement on 2025 Upper Deck Clear Cut hockey that had been invisible. Same class of bug: a bare `\b` matched at a hyphen and turned "Score-A-Treat" into manufacturer "Score" — the manufacturer match now requires whitespace/end (with an optional possessive, for "Panini's").

Parse quality on the live run: **126 of 127 titles** keyed. The lone holdout, "2026 Score-A-Treat Multi-Sport", is genuinely ambiguous and is skipped and reported rather than guessed at.

---

## 7. Alert rules

Build in this order.

1. **`announcement`** — new `release_announcements` row, confidence ≥ 0.6. Fires off Tier A. Days of lead time.
2. **`presale_live`** — first product row appears for a `product_key` that has an announcement or upcoming release.

   **Caveat, given the 2x/day sweep:** detection lags by up to ~12 hours, so this will NOT catch a fast sellout. Tier B is therefore a price/availability *tracker*, not the fast buy signal. **Tier A (email) is the fast signal** — it arrives with hours of lead time and costs nothing to poll. Build and trust Tier A accordingly.
3. **`restock`** — `available` flips false→true on a hot-list product.
4. **`price_low`** — `price_cents < 0.85 × trailing 7-day median across all retailers for that product_key`, minimum 3 retailers carrying it. Requires §5 to be working.

Cooldown: suppress if a matching `(alert_type, product_key_id)` fired within 6 hours. Rule 4 needs a tighter 1-hour window.

Signal message body: product key canonical name, retailer, price, MSRP delta, presale flag, direct URL, and for Shopify a cart deep-link `{base_url}/cart/{variant_id}:1` — Signal renders it tappable, so one-tap-to-checkout survives the move off Discord.

### 7.1 Sending

Reuse the whiskey-bot integration rather than standing anything up. Already running and healthy on the VDS:

- container `signal-api` (`bbernhard/signal-cli-rest-api`) — already linked to a Signal account, so there is no number to register and no device to re-link
- Windmill script `f/whiskeybot/send_signal_message.ts`, which takes a `SignalApiResource` (`base_url`, `sender_number`, `group_id`) plus a message string

Create a SECOND Windmill resource pointing at the new card-drops group — same `sender_number`, different `group_id` — and call that existing script. No new code.

**Gotcha, already documented in that script:** signal-cli-rest-api expects the group id base64-encoded AGAIN on top of the already-base64 id `signal-cli` uses. Store the RAW id in the resource; the script does the second encoding. Getting this wrong produces a silent non-delivery.

**Alerts go to a human. No automated checkout.** Distributors cancel orders and close accounts over bot purchasing, and you buy from these people.

---

## 8. Build order

1. Schema + `retailers` seeded, probe script run, platforms recorded. *(half day)*
2. Zoho filter + n8n ingest workflow, extraction to `release_announcements`, Signal on rule 1. *(one day)* — this alone delivers most of the value.
3. Adapters + `sweep_catalog` + snapshots. *(2-3 days, revised)* — one cheap Shopify adapter (bbcexchange), plus three Camoufox/proxy adapters for Blowout, DACardWorld and Steel City. The original one-day estimate assumed five Shopify stores; only one candidate is actually Shopify.
4. Regex normalization pass 1, then rules 2 and 3. *(one day)*
5. Watch the raw alert stream for a week. Tune thresholds before building anything else.
6. Release calendar, `poll_hot`, Gemini normalization pass 2, rule 4.

Do not build steps 4–6 before running step 5. The alert stream will tell you which noise is worth engineering against, and it usually isn't the noise you expect.

---

## 9. Open items

- ~~Confirm whether the lister app holds cost basis / current inventory.~~ RESOLVED: out of scope. This tool is standalone and does not read the lister's inventory, so rule 4 stays a pure market signal at a fixed 0.85 of the cross-retailer median rather than anything margin-aware.
- Decide whether `case` configs belong in the same `product_key` space as boxes or get a `units_per` field instead. Cases complicate the cross-retailer median in rule 4.
- eBay sold comps to convert alerts into projected margin: still out of scope, and now also BLOCKED upstream. As of 2026-07-26 eBay requires sign-in to view sold/completed listings (confirmed by controlled test: identical browser session, plain search served 62 rows, the same search plus `LH_Sold&LH_Complete` returned a sign-in wall). This is what broke the lister's Apify sold-comp actor. Any margin projection here would inherit that constraint, or wait on the eBay Marketplace Insights API application.
