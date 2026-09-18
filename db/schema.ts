import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  sku: text('sku').notNull().default(''),
  productName: text('product_name').notNull(),
  ean: text('ean').notNull().default(''),
  ownPriceOre: integer('own_price_ore').notNull(),
  currency: text('currency').notNull().default('SEK'),
  matchedProductId: text('matched_product_id'),
  matchedProductName: text('matched_product_name'),
  matchedProductUrl: text('matched_product_url'),
  matchConfidence: integer('match_confidence'),
  matchStatus: text('match_status').notNull().default('pending'),
  lowPriceOre: integer('low_price_ore'),
  lowMerchant: text('low_merchant'),
  lowUrl: text('low_url'),
  highPriceOre: integer('high_price_ore'),
  highMerchant: text('high_merchant'),
  highUrl: text('high_url'),
  updatedAt: text('updated_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_products_match_status').on(table.matchStatus),
  index('idx_products_updated_at').on(table.updatedAt),
]);

export const productCountryPrices = sqliteTable('product_country_prices', {
  productId: text('product_id').notNull(), country: text('country').notNull(), currency: text('currency').notNull(),
  mistoreHandle: text('mistore_handle'), mistoreName: text('mistore_name'), mistoreUrl: text('mistore_url'), mistorePriceMinor: integer('mistore_price_minor'),
  marketProductId: text('market_product_id'), marketProductName: text('market_product_name'), marketProductUrl: text('market_product_url'),
  matchConfidence: integer('match_confidence'), matchStatus: text('match_status').notNull().default('pending'),
  lowPriceMinor: integer('low_price_minor'), lowMerchant: text('low_merchant'), lowUrl: text('low_url'),
  expectedPriceMinor: integer('expected_price_minor'), updatedAt: text('updated_at'),
}, (table) => [
  primaryKey({ columns: [table.productId, table.country] }),
  index('idx_country_prices_updated').on(table.updatedAt),
  index('idx_country_prices_status').on(table.matchStatus),
]);

export const productVariants = sqliteTable('product_variants', {
  productId: text('product_id').notNull(), country: text('country').notNull(), variantsJson: text('variants_json').notNull(),
}, (table) => [primaryKey({ columns: [table.productId, table.country] })]);

export const priceRefreshLog = sqliteTable('price_refresh_log', {
  productId: text('product_id').notNull(), country: text('country').notNull(),
  manualAt: text('manual_at'), autoAt: text('auto_at'),
}, (table) => [primaryKey({ columns: [table.productId, table.country] })]);

export const selectedCollections = sqliteTable('selected_collections', {
  handle: text('handle').primaryKey(), title: text('title').notNull(),
  productHandlesJson: text('product_handles_json').notNull(), updatedAt: text('updated_at').notNull(),
});
