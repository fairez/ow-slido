CREATE TABLE "note_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"notes_snapshot_hash" text NOT NULL,
	"note_count" integer NOT NULL,
	"summary" text,
	"categories" jsonb,
	"keywords" jsonb,
	"edited" boolean DEFAULT false NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"model" text,
	"prompt_version" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "note_analyses_status" CHECK ("note_analyses"."status" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "note_analyses" ADD CONSTRAINT "note_analyses_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_analyses_interaction_idx" ON "note_analyses" USING btree ("interaction_id","created_at");