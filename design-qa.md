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
- Selecting one row enabled “Export selected (1)” and both CSV and Excel actions completed without an on-page error.
- An XLSX test file was read in the live browser; SKU, Product Name, and EAN columns were identified correctly, including a text EAN with a leading zero. The test file was not imported.
- Closing and reopening Import cleared pasted content. Clicking the backdrop closed the dialog.
- Live API returned 24 products after deployment, confirming the prior D1 records remained available.

## Remaining verification

- The browser did not expose a downloaded export artifact for file inspection. Validate the file content with a user-provided failing example if export problems persist.
- The exact MiStore collection filter awaits the user’s chosen collection URLs or handles.

final result: passed for the implemented UI and interactions above
