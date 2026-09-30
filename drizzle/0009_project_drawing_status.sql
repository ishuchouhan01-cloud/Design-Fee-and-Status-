CREATE TABLE "login_accounts" (
	"role" text PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"success" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"login_role" text NOT NULL,
	"user_id" text NOT NULL,
	"edit_mode" boolean DEFAULT false NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "package_dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"project_id" text NOT NULL,
	"department" text NOT NULL,
	"owner_user_id" text,
	"owner_text" text,
	"description" text NOT NULL,
	"target_date" timestamp with time zone,
	"closure_date" timestamp with time zone,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"remarks" text,
	"created_by_id" text,
	"created_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "archived_by_label" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "responsible_user_id" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "responsible_text" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "source_code" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "user_edited_fields" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "archived_by_label" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_by_label" text;--> statement-breakpoint
ALTER TABLE "login_sessions" ADD CONSTRAINT "login_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_dependencies" ADD CONSTRAINT "package_dependencies_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_dependencies" ADD CONSTRAINT "package_dependencies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_dependencies" ADD CONSTRAINT "package_dependencies_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_dependencies" ADD CONSTRAINT "package_dependencies_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_attempts_key_ix" ON "login_attempts" USING btree ("key","at");--> statement-breakpoint
CREATE UNIQUE INDEX "login_sessions_token_uq" ON "login_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "login_sessions_user_ix" ON "login_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "package_dependencies_package_ix" ON "package_dependencies" USING btree ("package_id");--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_responsible_user_id_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Each package remembers the code its source gave it (an import finds it by that code).
UPDATE "packages" SET "source_code" = "package_code" WHERE "source_code" IS NULL AND "source_workbook" IS NOT NULL;
