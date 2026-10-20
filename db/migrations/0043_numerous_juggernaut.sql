ALTER TABLE "events" ADD COLUMN "deletion_notice_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_retention_days" CHECK ("workspaces"."retention_days" is null or "workspaces"."retention_days" in (30, 90, 365));