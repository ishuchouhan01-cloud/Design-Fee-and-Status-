-- Additive. Personal sign-in (members) with an access level per project and
-- module switches, modelled on Autodesk Forma / ACC Project Admin → Members.
-- Nothing is dropped or renamed; the shared role sign-ins (login_accounts)
-- keep working until LEGACY_ROLE_LOGINS is switched off.
CREATE TABLE IF NOT EXISTS "companies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"trade" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_name_uq" ON "companies" (lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_roles_name_uq" ON "job_roles" (lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "members" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"company_id" text REFERENCES "companies"("id") ON DELETE SET NULL,
	"job_role_id" text REFERENCES "job_roles"("id") ON DELETE SET NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"password_hash" text,
	"is_account_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"last_sign_in_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"user_id" text REFERENCES "users"("id"),
	"updated_at" timestamp with time zone,
	CONSTRAINT "members_email_lower_ck" CHECK ("email" = lower("email")),
	CONSTRAINT "members_status_ck" CHECK ("status" IN ('invited', 'active', 'deactivated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "members_email_uq" ON "members" ("email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "members_user_ix" ON "members" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_members" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
	"project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"access_level" text DEFAULT 'member' NOT NULL,
	"sw_billing" boolean DEFAULT false NOT NULL,
	"sw_edit" boolean DEFAULT false NOT NULL,
	"sw_import_export" boolean DEFAULT false NOT NULL,
	"sw_planning" boolean DEFAULT false NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" text,
	"updated_at" timestamp with time zone,
	CONSTRAINT "project_members_level_ck" CHECK ("access_level" IN ('project_admin', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_members_uq" ON "project_members" ("member_id", "project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_members_project_ix" ON "project_members" ("project_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_invites_token_uq" ON "member_invites" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_invites_member_ix" ON "member_invites" ("member_id");
--> statement-breakpoint
ALTER TABLE "login_sessions" ADD COLUMN IF NOT EXISTS "member_id" text REFERENCES "members"("id");
--> statement-breakpoint
ALTER TABLE "login_sessions" ADD COLUMN IF NOT EXISTS "emergency" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_sessions_member_ix" ON "login_sessions" ("member_id");
--> statement-breakpoint
ALTER TABLE "login_attempts" ADD COLUMN IF NOT EXISTS "email" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_email_ix" ON "login_attempts" ("email", "at");
