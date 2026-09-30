ALTER TABLE "drawings" ADD COLUMN "source_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "source_period_label" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "source_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "source_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "drawings_updated_on_ix" ON "drawings" USING btree ("edited_at","source_date","source_period_end");--> statement-breakpoint
-- "Updated On" from what is already known; the next import refines it from the source.
UPDATE "drawings" SET "source_date" = "actual_release_date"
  WHERE "actual_release_date" IS NOT NULL AND "released_by_id" IS NULL AND "source_date" IS NULL;--> statement-breakpoint
UPDATE "drawings" SET
    "source_period_label" = 'Quarter ' || substring("release_evidence" from '^Issued \d{4} Q([1-4])$') || ', ' || substring("release_evidence" from '^Issued (\d{4}) Q[1-4]$'),
    "source_period_start" = make_date(substring("release_evidence" from '^Issued (\d{4}) Q[1-4]$')::int, (substring("release_evidence" from '^Issued \d{4} Q([1-4])$')::int - 1) * 3 + 1, 1)::timestamptz,
    "source_period_end" = (make_date(substring("release_evidence" from '^Issued (\d{4}) Q[1-4]$')::int, (substring("release_evidence" from '^Issued \d{4} Q([1-4])$')::int - 1) * 3 + 1, 1) + interval '3 months' - interval '1 day')::timestamptz
  WHERE "source_date" IS NULL AND "completion_status" = 'COMPLETED' AND "release_evidence" ~ '^Issued \d{4} Q[1-4]$';--> statement-breakpoint
UPDATE "drawings" SET
    "source_period_label" = substring("release_evidence" from '^Issued in (\d{4})$'),
    "source_period_start" = make_date(substring("release_evidence" from '^Issued in (\d{4})$')::int, 1, 1)::timestamptz,
    "source_period_end" = make_date(substring("release_evidence" from '^Issued in (\d{4})$')::int, 12, 31)::timestamptz
  WHERE "source_date" IS NULL AND "completion_status" = 'COMPLETED' AND "release_evidence" ~ '^Issued in \d{4}$';--> statement-breakpoint
UPDATE "drawings" SET
    "source_period_label" = 'Before 01-Jan-' || substring("release_evidence" from '^Issued before 01-Jan-(\d{4})$'),
    "source_period_end" = (make_date(substring("release_evidence" from '^Issued before 01-Jan-(\d{4})$')::int, 1, 1) - interval '1 day')::timestamptz
  WHERE "source_date" IS NULL AND "completion_status" = 'COMPLETED' AND "release_evidence" ~ '^Issued before 01-Jan-\d{4}$';--> statement-breakpoint
-- The last change a person made in Drawing Control, from the audit trail (imports excluded).
UPDATE "drawings" d SET "edited_at" = a.at
  FROM (
    SELECT "entity_id", max("timestamp") AS at FROM "audit_log"
    WHERE "entity_type" = 'DRAWING' AND "user_id" IS NOT NULL
      AND coalesce("reason", '') !~* '(import|autodesk construction cloud export)'
    GROUP BY "entity_id"
  ) a
  WHERE a."entity_id" = d."id" AND d."edited_at" IS NULL;
