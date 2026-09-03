CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`sku` text DEFAULT '' NOT NULL,
	`product_name` text NOT NULL,
	`ean` text DEFAULT '' NOT NULL,
	`own_price_ore` integer NOT NULL,
	`currency` text DEFAULT 'SEK' NOT NULL,
	`matched_product_id` text,
	`matched_product_name` text,
	`matched_product_url` text,
	`match_confidence` integer,
	`match_status` text DEFAULT 'pending' NOT NULL,
	`low_price_ore` integer,
	`low_merchant` text,
	`low_url` text,
	`high_price_ore` integer,
	`high_merchant` text,
	`high_url` text,
	`updated_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_products_match_status` ON `products` (`match_status`);--> statement-breakpoint
CREATE INDEX `idx_products_updated_at` ON `products` (`updated_at`);