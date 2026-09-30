CREATE TABLE "dfs_wbs_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"parent_id" text,
	"node_type" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"source_label" text,
	"node_key" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"source_workbook" text,
	"source_sheet" text,
	"source_row" integer,
	"import_batch_id" text,
	"user_edited_fields" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "wbs_node_id" text;--> statement-breakpoint
ALTER TABLE "dfs_wbs_nodes" ADD CONSTRAINT "dfs_wbs_nodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dfs_wbs_nodes" ADD CONSTRAINT "dfs_wbs_nodes_parent_id_dfs_wbs_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."dfs_wbs_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dfs_wbs_nodes_uq" ON "dfs_wbs_nodes" USING btree ("project_id","node_key");--> statement-breakpoint
CREATE INDEX "dfs_wbs_nodes_parent_ix" ON "dfs_wbs_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "dfs_wbs_nodes_project_ix" ON "dfs_wbs_nodes" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_wbs_node_id_dfs_wbs_nodes_id_fk" FOREIGN KEY ("wbs_node_id") REFERENCES "public"."dfs_wbs_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "packages_wbs_node_ix" ON "packages" USING btree ("wbs_node_id");