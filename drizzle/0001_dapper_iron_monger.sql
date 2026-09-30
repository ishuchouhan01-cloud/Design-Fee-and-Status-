CREATE TABLE "fy26_import_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'PREVIEW' NOT NULL,
	"source_folder" text NOT NULL,
	"workbook_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"preview_json" text DEFAULT '{}' NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"protected_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"started_by_id" text,
	"applied_by_id" text,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fy26_import_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"workbook" text,
	"sheet" text,
	"row_number" integer,
	"source_label" text,
	"message" text NOT NULL,
	"payload" text
);
--> statement-breakpoint
CREATE TABLE "fy26_package_dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"natural_key" text NOT NULL,
	"fy26_package_id" text NOT NULL,
	"sequence" integer DEFAULT 100 NOT NULL,
	"step_label" text,
	"description" text NOT NULL,
	"target_date" timestamp with time zone,
	"responsible_text" text,
	"remarks" text,
	"completion_status" text DEFAULT 'NOT_COMPLETED' NOT NULL,
	"user_edited_fields" text DEFAULT '' NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"source_workbook" text,
	"source_sheet" text,
	"source_row" integer,
	"import_batch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fy26_package_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"fy26_package_id" text NOT NULL,
	"previous_expected_date" timestamp with time zone,
	"new_expected_date" timestamp with time zone,
	"previous_plan_billing_cr" double precision,
	"new_plan_billing_cr" double precision,
	"previous_planned_quantity" integer,
	"new_planned_quantity" integer,
	"reason" text,
	"changed_by_id" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fy26_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"natural_key" text NOT NULL,
	"fy26_project_id" text NOT NULL,
	"fy26_phase_id" text,
	"discipline_id" text,
	"package_description" text NOT NULL,
	"source_scope_label" text,
	"responsible_user_id" text,
	"responsible_source_text" text,
	"baseline_release_date" timestamp with time zone,
	"current_expected_release_date" timestamp with time zone,
	"actual_release_date" timestamp with time zone,
	"plan_billing_cr" double precision,
	"actual_billing_cr" double precision,
	"planned_package_quantity" integer,
	"actual_package_quantity" integer,
	"remarks" text,
	"completion_status" text DEFAULT 'NOT_COMPLETED' NOT NULL,
	"revision_count" integer DEFAULT 0 NOT NULL,
	"user_edited_fields" text DEFAULT '' NOT NULL,
	"source_workbook" text NOT NULL,
	"source_sheet" text NOT NULL,
	"source_row" integer NOT NULL,
	"import_batch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fy26_phases" (
	"id" text PRIMARY KEY NOT NULL,
	"fy26_project_id" text NOT NULL,
	"phase_key" text NOT NULL,
	"phase_name" text NOT NULL,
	"source_label" text NOT NULL,
	"legacy_project_id" text,
	"sequence" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fy26_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"project_key" text NOT NULL,
	"project_name" text NOT NULL,
	"project_code" text,
	"legacy_project_id" text,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fy26_scope_map" (
	"id" text PRIMARY KEY NOT NULL,
	"source_label" text NOT NULL,
	"source_workbook" text NOT NULL,
	"level" text NOT NULL,
	"project_name" text NOT NULL,
	"phase_name" text,
	"legacy_project_code" text,
	"confirmed" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "fy26_import_batches" ADD CONSTRAINT "fy26_import_batches_started_by_id_users_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_import_batches" ADD CONSTRAINT "fy26_import_batches_applied_by_id_users_id_fk" FOREIGN KEY ("applied_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_import_issues" ADD CONSTRAINT "fy26_import_issues_batch_id_fy26_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."fy26_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_package_dependencies" ADD CONSTRAINT "fy26_package_dependencies_fy26_package_id_fy26_packages_id_fk" FOREIGN KEY ("fy26_package_id") REFERENCES "public"."fy26_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_package_dependencies" ADD CONSTRAINT "fy26_package_dependencies_import_batch_id_fy26_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."fy26_import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_package_revisions" ADD CONSTRAINT "fy26_package_revisions_fy26_package_id_fy26_packages_id_fk" FOREIGN KEY ("fy26_package_id") REFERENCES "public"."fy26_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_package_revisions" ADD CONSTRAINT "fy26_package_revisions_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_packages" ADD CONSTRAINT "fy26_packages_fy26_project_id_fy26_projects_id_fk" FOREIGN KEY ("fy26_project_id") REFERENCES "public"."fy26_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_packages" ADD CONSTRAINT "fy26_packages_fy26_phase_id_fy26_phases_id_fk" FOREIGN KEY ("fy26_phase_id") REFERENCES "public"."fy26_phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_packages" ADD CONSTRAINT "fy26_packages_discipline_id_disciplines_id_fk" FOREIGN KEY ("discipline_id") REFERENCES "public"."disciplines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_packages" ADD CONSTRAINT "fy26_packages_responsible_user_id_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_packages" ADD CONSTRAINT "fy26_packages_import_batch_id_fy26_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."fy26_import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_phases" ADD CONSTRAINT "fy26_phases_fy26_project_id_fy26_projects_id_fk" FOREIGN KEY ("fy26_project_id") REFERENCES "public"."fy26_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_phases" ADD CONSTRAINT "fy26_phases_legacy_project_id_projects_id_fk" FOREIGN KEY ("legacy_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fy26_projects" ADD CONSTRAINT "fy26_projects_legacy_project_id_projects_id_fk" FOREIGN KEY ("legacy_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fy26_import_issues_batch_ix" ON "fy26_import_issues" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "fy26_import_issues_sev_ix" ON "fy26_import_issues" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "fy26_import_issues_code_ix" ON "fy26_import_issues" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "fy26_dependencies_natural_uq" ON "fy26_package_dependencies" USING btree ("fy26_package_id","natural_key");--> statement-breakpoint
CREATE INDEX "fy26_dependencies_package_ix" ON "fy26_package_dependencies" USING btree ("fy26_package_id");--> statement-breakpoint
CREATE INDEX "fy26_dependencies_completion_ix" ON "fy26_package_dependencies" USING btree ("completion_status");--> statement-breakpoint
CREATE INDEX "fy26_dependencies_target_ix" ON "fy26_package_dependencies" USING btree ("target_date");--> statement-breakpoint
CREATE INDEX "fy26_package_revisions_pkg_ix" ON "fy26_package_revisions" USING btree ("fy26_package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fy26_packages_natural_uq" ON "fy26_packages" USING btree ("natural_key");--> statement-breakpoint
CREATE INDEX "fy26_packages_project_ix" ON "fy26_packages" USING btree ("fy26_project_id");--> statement-breakpoint
CREATE INDEX "fy26_packages_phase_ix" ON "fy26_packages" USING btree ("fy26_phase_id");--> statement-breakpoint
CREATE INDEX "fy26_packages_discipline_ix" ON "fy26_packages" USING btree ("discipline_id");--> statement-breakpoint
CREATE INDEX "fy26_packages_responsible_ix" ON "fy26_packages" USING btree ("responsible_user_id");--> statement-breakpoint
CREATE INDEX "fy26_packages_completion_ix" ON "fy26_packages" USING btree ("completion_status");--> statement-breakpoint
CREATE INDEX "fy26_packages_expected_ix" ON "fy26_packages" USING btree ("current_expected_release_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fy26_phases_uq" ON "fy26_phases" USING btree ("fy26_project_id","phase_key");--> statement-breakpoint
CREATE INDEX "fy26_phases_project_ix" ON "fy26_phases" USING btree ("fy26_project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fy26_projects_key_uq" ON "fy26_projects" USING btree ("project_key");--> statement-breakpoint
CREATE INDEX "fy26_projects_legacy_ix" ON "fy26_projects" USING btree ("legacy_project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fy26_scope_map_label_uq" ON "fy26_scope_map" USING btree ("source_label");--> statement-breakpoint
CREATE INDEX "fy26_scope_map_project_ix" ON "fy26_scope_map" USING btree ("project_name");