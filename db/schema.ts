import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
