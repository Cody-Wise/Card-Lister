# Project Status

## What It Is

Local web app for bulk sports card intake — OCR/vision metadata extraction, sold-comparable lookup, price calculation, review/editing, and eBay listing creation/publishing.

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js (ESM, built-in `node:http`) |
| Frontend | Vanilla HTML + CSS + JS |
| Database | File-backed JSON (`data/state.json`) or optional Supabase |
| Key deps | `@supabase/supabase-js`, `googleapis` |

## Features

- Batch management (create, upload cards, process)
- OCR metadata extraction (heuristic + OpenAI Vision GPT-4.1)
- Canonical card matching against a seed catalog
- Sold comps from Apify scraper + manual import
- Active listing search via eBay Browse API
- Pricing engine (sold median/P25, active blending, confidence levels)
- Review/editing panel (player, year, set, parallel, serial, grade, etc.)
- eBay listing create/update/publish via Inventory API
- Google Drive import (OAuth, scan folder for front/back pairs)
- State export/import as JSON
- Comp toggle (include/exclude individual comps)
- Publish checklist per batch
- Seed data with 5 test cards

## Tests

```
19 tests — all passing
```

| File | Tests | Area |
|---|---|---|
| `tests/apify.test.js` | 6 | Apify parsing, base/parallel/autograph/serial filtering |
| `tests/ocr.test.js` | 7 | Heuristic extraction, serials, rookies, vision fallback |
| `tests/matching.test.js` | 1 | Canonical card matching |
| `tests/pricing.test.js` | 5 | Sold trimming, hot blending, anchored pricing, numbered cards |

## DevOps

| Item | Status |
|---|---|
| ESLint | ✅ Clean — `npm run lint` |
| Prettier | ✅ Clean — `npm run format:check` |
| Pre-commit hooks (husky + lint-staged) | ✅ Lints & formats staged `.js` files |
| CI (GitHub Actions) | ✅ Runs lint, test, format:check on push/PR (Node 22, 24, 26) |
| Docker | ✅ `Dockerfile` (node:22-alpine) + `.dockerignore` |
| Code coverage | ✅ `npm run test:coverage` |

## Git

1 commit (`8503c66`). Working tree has unstaged changes (Prettier reformatting + devops files added).

## Known Gaps

- No multi-user support (single file-backed JSON store)
- No CI secrets management for eBay/Apify/OpenAI keys
- No Docker Compose for local dev with Supabase
- No CD / deployment pipeline
- Vanilla JS frontend — no component framework
