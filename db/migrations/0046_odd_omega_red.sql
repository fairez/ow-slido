CREATE TABLE "job_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone NOT NULL,
	"last_finished_at" timestamp with time zone,
	"last_status" text NOT NULL,
	"last_error_class" text,
	CONSTRAINT "job_runs_status" CHECK ("job_runs"."last_status" in ('running', 'ok', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "note_analyses" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "note_analyses" ADD COLUMN "error_class" text;--> statement-breakpoint
ALTER TABLE "workspace_exports" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_exports" ADD COLUMN "error_class" text;