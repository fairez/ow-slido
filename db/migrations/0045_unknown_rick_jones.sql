CREATE TABLE "deleted_workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan" text NOT NULL,
	CONSTRAINT "deleted_workspaces_plan" CHECK ("deleted_workspaces"."plan" in ('free', 'pro', 'team'))
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;