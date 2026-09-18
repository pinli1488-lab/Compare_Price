# PriceDesk design QA

## Reference and implementation

- Reference: `/Users/lucas/.codex/generated_images/01a0ad47-4fcd-7d53-8ddc-4bcc36af6170/exec-cf2c25de-a0a1-4757-a3cf-0195094527c9.png`
- Live implementation: `https://pricedesk-prisjakt.pinli1488-lab.workers.dev/`
- Checked in the in-app browser with 24 saved records grouped into 18 displayed rows before data refresh.

## Visual checks

- The table has four country groups, three price columns per country, one product row per item, and no product images or summary cards.
- Both source prices are links. The lowest market merchant is directly below the price.
- MiStore and expected price cells show compact percentages without the word “Differ”. Price ranges appear for variants with different prices.
- The left product column remains opaque when scrolling horizontally. The action column only appears after scrolling right.
- The outer workspace has left and right margins. The import and match dialogs use the same dense visual language.

## Interaction checks

- The “Above market” filter reduced the displayed set from 18 to 15 rows in the live browser.
- Selecting one row enabled “Export selected (1)”. A real Chromium download produced both files. The Excel file reopened with 2 rows and 36 columns (header plus only the selected product); the CSV had 2 lines and a UTF-8 BOM.
- An XLSX test file was read in the live browser; SKU, Product Name, and EAN columns were identified correctly, including a text EAN with a leading zero. The test file was not imported.
- Closing and reopening Import cleared pasted content. Clicking the backdrop closed the dialog.
- Live API returned 24 products after deployment, confirming the prior D1 records remained available.
- Adding the temporary MiStore `elscootrar` collection populated 20 product handles and narrowed the displayed table from 18 to 2 rows. It was then removed. The live collections API returned an empty list, while all 24 products and 96 country market records remained.
- Variant popovers are hidden until hover or focus after correcting the selector specificity; the production screenshot showed no overlapping text behind the collection dialog.
- At a 1440 × 900 viewport, the table has white side gutters. Scrolling to the far right keeps the entire Match / Edit button inside the table and its right gutter.
- Hovering the first product's Variants control shows all three variants with their color, SKU, and EAN in a viewport-level popup, with no clipping by the sticky product column or scrolling table.
- The country selector remains a scope control for the Above market and Needs review status filters; all four country columns stay visible.

## Remaining verification

- The user has not supplied the specific MiStore collections to retain. The UI now accepts a collection URL or handle and stores only user-selected collections.
- The user has not supplied an example of the earlier CSV/Excel export failure. Chromium download and structural checks passed for one selected group, including three variants.

final result: passed for the implemented UI and interactions above
