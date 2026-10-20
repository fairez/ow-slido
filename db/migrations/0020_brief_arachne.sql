ALTER TABLE "events" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "events" SET "created_by" = "owner_id";
--> statement-breakpoint
UPDATE "interactions" SET "created_by" = (SELECT "owner_id" FROM "events" WHERE "events"."id" = "interactions"."event_id");
