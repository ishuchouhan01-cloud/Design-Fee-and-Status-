-- Additive. One Design Fee per PACKAGE (the "Total Fee | Released Till Date |
-- Balance | Billed till Dec'yy" layout): stored on the package, never split
-- over disciplines. Per-discipline fees stay in package_fees as before.
ALTER TABLE "packages" ADD COLUMN IF NOT EXISTS "fee_value" double precision;
--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN IF NOT EXISTS "billed_to_date_value" double precision;
--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN IF NOT EXISTS "released_to_date_value" double precision;
--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN IF NOT EXISTS "balance_value" double precision;
--> statement-breakpoint
-- Services drawing lists ("Drawing List | SR"): billed under MEP, like PHE / ELE / IBMS.
INSERT INTO "disciplines" ("id", "code", "name", "category", "sort_order", "active", "dfs_group")
VALUES ('dc_sr_services', 'SR', 'Services', 'DESIGN', 35, true, 'MEP')
ON CONFLICT ("code") DO NOTHING;
