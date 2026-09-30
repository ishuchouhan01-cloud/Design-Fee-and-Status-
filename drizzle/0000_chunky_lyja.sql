CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"user_label" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_label" text,
	"action" text NOT NULL,
	"field" text,
	"old_value" text,
	"new_value" text,
	"reason" text,
	"project_id" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "critical_requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"phase_label" text,
	"requirement" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_deliverables" (
	"id" text PRIMARY KEY NOT NULL,
	"deliverable_code" text NOT NULL,
	"project_id" text NOT NULL,
	"phase_id" text,
	"goal_id" text,
	"package_id" text,
	"discipline_id" text,
	"deliverable_description" text NOT NULL,
	"baseline_release_date" timestamp with time zone NOT NULL,
	"current_expected_release_date" timestamp with time zone NOT NULL,
	"actual_release_date" timestamp with time zone,
	"completion_status" text DEFAULT 'NOT_COMPLETED' NOT NULL,
	"owner_id" text,
	"revision" text,
	"remarks" text,
	"fiscal_year" text,
	"quarter" integer,
	"source_sheet" text,
	"reschedule_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"predecessor_type" text NOT NULL,
	"predecessor_id" text NOT NULL,
	"successor_type" text NOT NULL,
	"successor_id" text NOT NULL,
	"dependency_type" text DEFAULT 'FS' NOT NULL,
	"lag_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disciplines" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'DESIGN' NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"phase_id" text,
	"package_id" text,
	"discipline_id" text,
	"drawing_code" text NOT NULL,
	"drawing_number" text,
	"drawing_name" text NOT NULL,
	"area_of_works" text,
	"location" text,
	"stage_code" text,
	"batch_code" text,
	"batch" text,
	"issue_type" text,
	"revision" text,
	"baseline_release_date" timestamp with time zone,
	"current_expected_release_date" timestamp with time zone,
	"actual_release_date" timestamp with time zone,
	"completion_status" text DEFAULT 'NOT_COMPLETED' NOT NULL,
	"remarks" text,
	"plan_period_label" text,
	"reschedule_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "goal_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"previous_expected_date" timestamp with time zone,
	"new_expected_date" timestamp with time zone,
	"previous_target_quantity" integer,
	"new_target_quantity" integer,
	"previous_target_value" double precision,
	"new_target_value" double precision,
	"reason" text,
	"changed_by_id" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"impact_summary" text
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_code" text NOT NULL,
	"project_id" text NOT NULL,
	"phase_id" text,
	"discipline_id" text,
	"design_lead_id" text,
	"goal_description" text NOT NULL,
	"fiscal_year" text NOT NULL,
	"quarter" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"planned_quantity" integer DEFAULT 0 NOT NULL,
	"planned_value" double precision DEFAULT 0 NOT NULL,
	"reported_actual_quantity" integer DEFAULT 0 NOT NULL,
	"reported_actual_value" double precision DEFAULT 0 NOT NULL,
	"baseline_target_date" timestamp with time zone NOT NULL,
	"current_expected_date" timestamp with time zone NOT NULL,
	"actual_completion_date" timestamp with time zone,
	"completion_status" text DEFAULT 'NOT_COMPLETED' NOT NULL,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"remarks" text,
	"source_sheet" text,
	"source_row" integer,
	"is_baseline_revision" boolean DEFAULT false NOT NULL,
	"reschedule_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"import_run_id" text NOT NULL,
	"severity" text NOT NULL,
	"workbook" text,
	"sheet" text,
	"row_number" integer,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"payload" text
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workbook" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"summary_json" text DEFAULT '{}' NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_fees" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"discipline_id" text NOT NULL,
	"fee_percent" double precision,
	"fee_value" double precision
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"phase_id" text,
	"package_code" text NOT NULL,
	"package_name" text NOT NULL,
	"package_group" text,
	"sequence" integer DEFAULT 100 NOT NULL,
	"duration_days" integer,
	"baseline_start_date" timestamp with time zone,
	"baseline_release_date" timestamp with time zone,
	"current_expected_release_date" timestamp with time zone,
	"actual_release_date" timestamp with time zone,
	"remarks" text,
	"reschedule_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_phases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sequence" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"project_code" text NOT NULL,
	"project_name" text NOT NULL,
	"portfolio" text DEFAULT 'Ongoing' NOT NULL,
	"phase" text,
	"description" text,
	"location" text,
	"active" boolean DEFAULT true NOT NULL,
	"on_hold" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rag_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"project_id" text,
	"calculated_rag" text NOT NULL,
	"override_rag" text NOT NULL,
	"reason" text,
	"user_id" text,
	"user_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reschedule_history" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_label" text,
	"old_date" timestamp with time zone,
	"new_date" timestamp with time zone,
	"days_shift" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"scope" text DEFAULT 'ITEM' NOT NULL,
	"batch_id" text,
	"cascaded" boolean DEFAULT false NOT NULL,
	"changed_by_id" text,
	"changed_by_label" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"impacted_records" integer DEFAULT 1 NOT NULL,
	"project_id" text
);
--> statement-breakpoint
CREATE TABLE "team_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"user_id" text,
	"person_name" text NOT NULL,
	"role_on_goal" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'VIEWER' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "critical_requirements" ADD CONSTRAINT "critical_requirements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_deliverables" ADD CONSTRAINT "design_deliverables_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_deliverables" ADD CONSTRAINT "design_deliverables_phase_id_project_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."project_phases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_deliverables" ADD CONSTRAINT "design_deliverables_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_deliverables" ADD CONSTRAINT "design_deliverables_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_deliverables" ADD CONSTRAINT "design_deliverables_discipline_id_disciplines_id_fk" FOREIGN KEY ("discipline_id") REFERENCES "public"."disciplines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_deliverables" ADD CONSTRAINT "design_deliverables_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_phase_id_project_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."project_phases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_discipline_id_disciplines_id_fk" FOREIGN KEY ("discipline_id") REFERENCES "public"."disciplines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_revisions" ADD CONSTRAINT "goal_revisions_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_revisions" ADD CONSTRAINT "goal_revisions_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_phase_id_project_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."project_phases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_discipline_id_disciplines_id_fk" FOREIGN KEY ("discipline_id") REFERENCES "public"."disciplines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_design_lead_id_users_id_fk" FOREIGN KEY ("design_lead_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_issues" ADD CONSTRAINT "import_issues_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_fees" ADD CONSTRAINT "package_fees_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_fees" ADD CONSTRAINT "package_fees_discipline_id_disciplines_id_fk" FOREIGN KEY ("discipline_id") REFERENCES "public"."disciplines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_phase_id_project_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."project_phases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_overrides" ADD CONSTRAINT "rag_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_history" ADD CONSTRAINT "reschedule_history_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_assignments" ADD CONSTRAINT "team_assignments_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_assignments" ADD CONSTRAINT "team_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_ix" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_time_ix" ON "audit_log" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "audit_action_ix" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_project_ix" ON "audit_log" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "critical_requirements_project_ix" ON "critical_requirements" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliverables_code_uq" ON "design_deliverables" USING btree ("deliverable_code");--> statement-breakpoint
CREATE INDEX "deliverables_project_ix" ON "design_deliverables" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "deliverables_package_ix" ON "design_deliverables" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "deliverables_goal_ix" ON "design_deliverables" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "deliverables_completion_ix" ON "design_deliverables" USING btree ("completion_status");--> statement-breakpoint
CREATE INDEX "deliverables_expected_ix" ON "design_deliverables" USING btree ("current_expected_release_date");--> statement-breakpoint
CREATE INDEX "deliverables_discipline_ix" ON "design_deliverables" USING btree ("discipline_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dependencies_uq" ON "dependencies" USING btree ("predecessor_type","predecessor_id","successor_type","successor_id");--> statement-breakpoint
CREATE INDEX "dependencies_pred_ix" ON "dependencies" USING btree ("predecessor_type","predecessor_id");--> statement-breakpoint
CREATE INDEX "dependencies_succ_ix" ON "dependencies" USING btree ("successor_type","successor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disciplines_code_uq" ON "disciplines" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "drawings_uq" ON "drawings" USING btree ("project_id","drawing_code","batch_code");--> statement-breakpoint
CREATE INDEX "drawings_project_ix" ON "drawings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "drawings_package_ix" ON "drawings" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "drawings_completion_ix" ON "drawings" USING btree ("completion_status");--> statement-breakpoint
CREATE INDEX "drawings_expected_ix" ON "drawings" USING btree ("current_expected_release_date");--> statement-breakpoint
CREATE INDEX "drawings_discipline_ix" ON "drawings" USING btree ("discipline_id");--> statement-breakpoint
CREATE INDEX "goal_revisions_goal_ix" ON "goal_revisions" USING btree ("goal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goals_code_uq" ON "goals" USING btree ("goal_code");--> statement-breakpoint
CREATE INDEX "goals_project_ix" ON "goals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "goals_period_ix" ON "goals" USING btree ("fiscal_year","quarter");--> statement-breakpoint
CREATE INDEX "goals_discipline_ix" ON "goals" USING btree ("discipline_id");--> statement-breakpoint
CREATE INDEX "goals_lead_ix" ON "goals" USING btree ("design_lead_id");--> statement-breakpoint
CREATE INDEX "goals_completion_ix" ON "goals" USING btree ("completion_status");--> statement-breakpoint
CREATE INDEX "goals_expected_ix" ON "goals" USING btree ("current_expected_date");--> statement-breakpoint
CREATE INDEX "import_issues_run_ix" ON "import_issues" USING btree ("import_run_id");--> statement-breakpoint
CREATE INDEX "import_issues_sev_ix" ON "import_issues" USING btree ("severity");--> statement-breakpoint
CREATE UNIQUE INDEX "package_fees_uq" ON "package_fees" USING btree ("package_id","discipline_id");--> statement-breakpoint
CREATE UNIQUE INDEX "packages_uq" ON "packages" USING btree ("project_id","package_code");--> statement-breakpoint
CREATE INDEX "packages_project_ix" ON "packages" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_phases_uq" ON "project_phases" USING btree ("project_id","code");--> statement-breakpoint
CREATE INDEX "project_phases_project_ix" ON "project_phases" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_code_uq" ON "projects" USING btree ("project_code");--> statement-breakpoint
CREATE INDEX "projects_portfolio_ix" ON "projects" USING btree ("portfolio");--> statement-breakpoint
CREATE INDEX "projects_active_ix" ON "projects" USING btree ("active");--> statement-breakpoint
CREATE INDEX "rag_overrides_entity_ix" ON "rag_overrides" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "reschedule_entity_ix" ON "reschedule_history" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "reschedule_changed_ix" ON "reschedule_history" USING btree ("changed_at");--> statement-breakpoint
CREATE INDEX "reschedule_batch_ix" ON "reschedule_history" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "reschedule_project_ix" ON "reschedule_history" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "team_assignments_goal_ix" ON "team_assignments" USING btree ("goal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_ix" ON "users" USING btree ("role");