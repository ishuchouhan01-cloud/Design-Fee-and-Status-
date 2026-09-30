CREATE TABLE "drawing_conflicts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"conflict_type" text NOT NULL,
	"drawing_number" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"candidates" text DEFAULT '[]' NOT NULL,
	"message" text,
	"resolution_note" text,
	"resolved_drawing_id" text,
	"resolved_by_id" text,
	"resolved_by_label" text,
	"resolved_at" timestamp with time zone,
	"import_batch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drawing_dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"drawing_id" text NOT NULL,
	"project_id" text NOT NULL,
	"department" text NOT NULL,
	"owner_user_id" text,
	"owner_text" text,
	"description" text NOT NULL,
	"target_date" timestamp with time zone,
	"closure_date" timestamp with time zone,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"remarks" text,
	"is_manual" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"user_edited_fields" text DEFAULT '' NOT NULL,
	"created_by_id" text,
	"created_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drawing_import_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"manifest" text NOT NULL,
	"status" text DEFAULT 'PREVIEW' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary_json" text DEFAULT '{}' NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"protected_count" integer DEFAULT 0 NOT NULL,
	"conflict_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"started_by_id" text,
	"started_by_label" text
);
--> statement-breakpoint
CREATE TABLE "drawing_import_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"project_code" text,
	"drawing_number" text,
	"workbook" text,
	"sheet" text,
	"row_number" integer,
	"message" text NOT NULL,
	"payload" text
);
--> statement-breakpoint
CREATE TABLE "drawing_location_phase_map" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"location_code" text NOT NULL,
	"zone_code" text DEFAULT '' NOT NULL,
	"phase_id" text,
	"rule" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drawing_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"drawing_id" text NOT NULL,
	"revision" text,
	"sequence" integer DEFAULT 0 NOT NULL,
	"expected_release_date" timestamp with time zone,
	"actual_release_date" timestamp with time zone,
	"completion_status" text DEFAULT 'NOT_COMPLETED' NOT NULL,
	"release_evidence" text,
	"released_by_id" text,
	"released_by_label" text,
	"released_at" timestamp with time zone,
	"remarks" text,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"source_workbook" text,
	"source_sheet" text,
	"source_row" integer,
	"snapshot_label" text,
	"created_by_id" text,
	"created_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drawing_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"drawing_id" text,
	"snapshot_role" text NOT NULL,
	"source_kind" text NOT NULL,
	"snapshot_label" text NOT NULL,
	"snapshot_date" timestamp with time zone,
	"plan_year" integer,
	"source_workbook" text NOT NULL,
	"source_sheet" text NOT NULL,
	"source_row" integer NOT NULL,
	"discipline_code" text,
	"section" text,
	"location" text,
	"batch_code" text,
	"batch" text,
	"drawing_number" text,
	"number_kind" text,
	"partial_number" text,
	"title" text,
	"revision" text,
	"released" boolean DEFAULT false NOT NULL,
	"issued_before_year" boolean DEFAULT false NOT NULL,
	"issued_quarter" integer,
	"planned_quarter" integer,
	"explicit_date_text" text,
	"in_acc" text,
	"collection" text,
	"version_count" integer,
	"tags" text,
	"acc_discipline" text,
	"acc_release_date" timestamp with time zone,
	"acc_created_at" timestamp with time zone,
	"import_batch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "number_status" text DEFAULT 'NUMBERED' NOT NULL;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "partial_number" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "responsible_user_id" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "responsible_text" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "collection" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "version_count" integer;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "tags" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "acc_discipline" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "acc_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "release_evidence" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "released_by_id" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "released_by_label" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "is_manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "source_workbook" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "source_sheet" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "source_row" integer;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "import_batch_id" text;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "user_edited_fields" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "drawing_conflicts" ADD CONSTRAINT "drawing_conflicts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_conflicts" ADD CONSTRAINT "drawing_conflicts_resolved_drawing_id_drawings_id_fk" FOREIGN KEY ("resolved_drawing_id") REFERENCES "public"."drawings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_conflicts" ADD CONSTRAINT "drawing_conflicts_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_conflicts" ADD CONSTRAINT "drawing_conflicts_import_batch_id_drawing_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."drawing_import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_dependencies" ADD CONSTRAINT "drawing_dependencies_drawing_id_drawings_id_fk" FOREIGN KEY ("drawing_id") REFERENCES "public"."drawings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_dependencies" ADD CONSTRAINT "drawing_dependencies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_dependencies" ADD CONSTRAINT "drawing_dependencies_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_dependencies" ADD CONSTRAINT "drawing_dependencies_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_import_batches" ADD CONSTRAINT "drawing_import_batches_started_by_id_users_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_import_issues" ADD CONSTRAINT "drawing_import_issues_batch_id_drawing_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."drawing_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_location_phase_map" ADD CONSTRAINT "drawing_location_phase_map_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_location_phase_map" ADD CONSTRAINT "drawing_location_phase_map_phase_id_project_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."project_phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_revisions" ADD CONSTRAINT "drawing_revisions_drawing_id_drawings_id_fk" FOREIGN KEY ("drawing_id") REFERENCES "public"."drawings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_revisions" ADD CONSTRAINT "drawing_revisions_released_by_id_users_id_fk" FOREIGN KEY ("released_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_revisions" ADD CONSTRAINT "drawing_revisions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_snapshots" ADD CONSTRAINT "drawing_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_snapshots" ADD CONSTRAINT "drawing_snapshots_drawing_id_drawings_id_fk" FOREIGN KEY ("drawing_id") REFERENCES "public"."drawings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_snapshots" ADD CONSTRAINT "drawing_snapshots_import_batch_id_drawing_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."drawing_import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_conflicts_uq" ON "drawing_conflicts" USING btree ("project_id","conflict_type","drawing_number");--> statement-breakpoint
CREATE INDEX "drawing_conflicts_status_ix" ON "drawing_conflicts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "drawing_dependencies_drawing_ix" ON "drawing_dependencies" USING btree ("drawing_id");--> statement-breakpoint
CREATE INDEX "drawing_dependencies_project_ix" ON "drawing_dependencies" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "drawing_dependencies_status_ix" ON "drawing_dependencies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "drawing_import_issues_batch_ix" ON "drawing_import_issues" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "drawing_import_issues_code_ix" ON "drawing_import_issues" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_location_phase_map_uq" ON "drawing_location_phase_map" USING btree ("project_id","location_code","zone_code");--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_revisions_uq" ON "drawing_revisions" USING btree ("drawing_id","revision");--> statement-breakpoint
CREATE INDEX "drawing_revisions_drawing_ix" ON "drawing_revisions" USING btree ("drawing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_snapshots_source_uq" ON "drawing_snapshots" USING btree ("source_workbook","source_sheet","source_row");--> statement-breakpoint
CREATE INDEX "drawing_snapshots_drawing_ix" ON "drawing_snapshots" USING btree ("drawing_id");--> statement-breakpoint
CREATE INDEX "drawing_snapshots_project_ix" ON "drawing_snapshots" USING btree ("project_id","snapshot_role");--> statement-breakpoint
CREATE INDEX "drawing_snapshots_number_ix" ON "drawing_snapshots" USING btree ("project_id","drawing_number");--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_responsible_user_id_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_released_by_id_users_id_fk" FOREIGN KEY ("released_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drawings_project_code_uq" ON "drawings" USING btree ("project_id","drawing_code");--> statement-breakpoint
CREATE UNIQUE INDEX "drawings_source_key_uq" ON "drawings" USING btree ("project_id","source_key");--> statement-breakpoint
CREATE INDEX "drawings_phase_ix" ON "drawings" USING btree ("phase_id");--> statement-breakpoint
CREATE INDEX "drawings_number_status_ix" ON "drawings" USING btree ("number_status");--> statement-breakpoint
CREATE INDEX "drawings_responsible_ix" ON "drawings" USING btree ("responsible_user_id");--> statement-breakpoint
CREATE INDEX "drawings_batch_ix" ON "drawings" USING btree ("batch_code");