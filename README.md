# PriceDesk

PriceDesk is a shared, password-free internal web tool for comparing your own prices with Prisjakt market prices in bulk.

## What it does

- Imports `.xlsx` and `.csv` files or pasted spreadsheet rows.
- Maps SKU, product name, EAN and own-price columns.
- Matches products through Prisjakt search with a manual confirmation flow.
- Excludes `Mistore` and `Mistore.se` from market offers.
- Shows lowest and highest product prices, merchants, differences and links.
- Exports the current filtered view to Excel or CSV.
- Stores the shared product list in Cloudflare D1.
- Refreshes when the app opens after Beijing midnight and supports a GitHub Actions daily schedule.

## Daily schedule

After deployment, add a GitHub repository variable named `PRICE_DESK_URL` containing the deployed site URL. The included workflow runs at 16:00 UTC, which is 00:00 Beijing time.

## Data-source note

The current adapter reads Prisjakt's public website as a temporary fallback. This can be affected by rate limits, anti-bot controls, or page changes. The intended production upgrade is Prisjakt's Partner Search API if free access is approved.

## Local development

```bash
npm install
npm run dev
```

## Validation

```bash
npm run db:generate
npm run build
npm run lint
```
