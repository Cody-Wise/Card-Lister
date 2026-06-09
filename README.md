# Automatic Sports Card Listing

A starter implementation for bulk sports card intake, comp lookup, pricing, and listing publication.

## Run

```bash
node src/server.js
```

Then open `http://localhost:3000`.

## Store secrets locally

Put your credentials in a root-level `.env` file next to `package.json`. Start by copying `.env.example` and filling in the values there. The app loads `.env` automatically on startup.

## eBay env vars

For live listing creation and publishing, set:

```bash
EBAY_ENV=production
EBAY_USER_ACCESS_TOKEN=...
EBAY_MARKETPLACE_ID=EBAY_US
EBAY_MERCHANT_LOCATION_KEY=...
EBAY_CATEGORY_ID=...
EBAY_PAYMENT_POLICY_ID=...
EBAY_FULFILLMENT_POLICY_ID=...
EBAY_RETURN_POLICY_ID=...
```

For the Browse API comp lookup later, we will also add an application token path or client-credentials exchange.

## What is included

1. Batch creation and card upload
2. Front/back image storage
3. OCR and metadata extraction scaffold
4. Canonical card matching
5. Sold comp and active listing simulation
6. Pricing engine
7. Draft offer creation, price updates, and publish flow
8. A minimal review UI

## Next upgrade path

1. Replace the OCR stub with a real vision/OCR service.
2. Swap the seed comps with eBay sold-comp or comp-provider integration.
3. Swap the eBay adapter stub for the live Inventory API and Browse API client.
