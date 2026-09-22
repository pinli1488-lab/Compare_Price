# PriceDesk

PriceDesk is a shared, password-free internal web tool for comparing your own prices with Prisjakt market prices in bulk.

## What it does

- Imports `.xlsx` and `.csv` files or pasted spreadsheet rows.
- Maps SKU, product name and EAN columns, then reads each country's current MiStore price automatically.
- Matches products independently across Sweden, Denmark, Finland and Norway, with manual confirmation for both MiStore and Prisjakt.
- Reuses confirmed Prisjakt product IDs for price refreshes. New automatic matches search a valid MiStore GTIN first, then product name and SKU; model checks reject accessories and ambiguous results. Public suggestions do not expose a verifiable GTIN, so a GTIN search hit still requires a plausible product name.
- Imports products from only the MiStore.se collections selected by the team, showing import and four-country price-refresh progress that can be minimized while the dashboard remains usable. The daily job also adds newly listed collection products.
- Excludes MiStore, Refurbed and used or refurbished offers from market results.
- Shows each country's linked MiStore price, two lowest market prices, editable expected price, purchase cost, expected profit and margin.
- Exports selected products to CSV with one SKU per row.
- Stores the shared product list in Cloudflare D1.
- Records Worker invocation logs in Cloudflare Observability so resource errors can be diagnosed by time and Ray ID.
- Refreshes daily through a GitHub Actions schedule at 00:00 UTC (08:00 Beijing time), with selective manual refresh in the app.

## Daily schedule

After deployment, add a GitHub repository variable named `PRICE_DESK_URL` containing the deployed site URL. The included workflow runs at 00:00 UTC, which is 08:00 Beijing time. It syncs Lark costs before refreshing MiStore and Prisjakt prices.

## Lark PriceDesk connection

The server reads purchase cost inputs from Base `RM2Rbbj9RauDqKsAloPjWMHCp3f`, table `tblBJUDAOmKGqddt`, and writes Expected Price to the matching country sale-price field by exact SKU.

Set these Cloudflare Worker secrets before using **Sync Lark costs** or Expected Price writeback:

```bash
npx wrangler secret put LARK_APP_ID
npx wrangler secret put LARK_APP_SECRET
```

The Lark custom app needs Base record read and write permissions and must be added as a collaborator to the PriceDesk Base. The base and table IDs have defaults; `LARK_BASE_TOKEN` and `LARK_PRICEDESK_TABLE_ID` can override them.

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
