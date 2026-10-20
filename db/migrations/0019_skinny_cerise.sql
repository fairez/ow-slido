CREATE TABLE "memberships" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_user" UNIQUE("workspace_id","user_id"),
	CONSTRAINT "memberships_role" CHECK ("memberships"."role" in ('owner', 'admin', 'editor', 'moderator', 'viewer')),
	CONSTRAINT "memberships_status" CHECK ("memberships"."status" in ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
-- Backfill: one personal workspace per existing user, an owner membership, and every event moves into its owner's workspace.
ALTER TABLE "workspaces" ADD COLUMN "tmp_user_id" uuid;--> statement-breakpoint
INSERT INTO "workspaces" ("name", "tmp_user_id") SELECT split_part("email", '@', 1), "id" FROM "users";--> statement-breakpoint
INSERT INTO "memberships" ("workspace_id", "user_id", "role") SELECT "id", "tmp_user_id", 'owner' FROM "workspaces" WHERE "tmp_user_id" IS NOT NULL;--> statement-breakpoint
UPDATE "events" SET "workspace_id" = w."id" FROM "workspaces" w WHERE w."tmp_user_id" = "events"."owner_id";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "tmp_user_id";--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;