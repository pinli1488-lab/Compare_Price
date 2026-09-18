# PriceDesk

PriceDesk is a shared, password-free internal web tool for comparing your own prices with Prisjakt market prices in bulk.

## What it does

- Imports `.xlsx` and `.csv` files or pasted spreadsheet rows.
- Maps SKU, product name and EAN columns, then reads each country's current MiStore price automatically.
- Matches products independently across Sweden, Denmark, Finland and Norway, with manual confirmation for both MiStore and Prisjakt.
- Tracks only MiStore.se collections selected by the team and refreshes their product membership daily.
- Excludes MiStore, Refurbed and used or refurbished offers from market results.
- Shows each country's linked MiStore price, linked lowest market price, merchant, editable expected price and both differences.
- Exports selected products to Excel or CSV.
- Stores the shared product list in Cloudflare D1.
- Refreshes daily through a GitHub Actions schedule at 16:00 UTC (midnight Beijing time), with selective manual refresh in the app.

## Daily schedule

After deployment, add a GitHub repository variable named `PRICE_DESK_URL` containing the deployed site URL. The included workflow runs at 16:00 UTC, which is 00:00 Beijing time.

## Data-source note

The current adapters read the four MiStore storefronts and Prisjakt country sites through their public website endpoints. This can be affected by rate limits, anti-bot controls, or page changes. The intended production upgrade is Prisjakt's Partner Search API if access is approved.

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
