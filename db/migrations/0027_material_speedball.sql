CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"current_period_end" timestamp with time zone,
	"provider" text,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"plan_override" text,
	"plan_override_until" timestamp with time zone,
	"plan_override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_workspace" UNIQUE("workspace_id"),
	CONSTRAINT "subscriptions_plan" CHECK ("subscriptions"."plan" in ('free', 'pro', 'team')),
	CONSTRAINT "subscriptions_status" CHECK ("subscriptions"."status" in ('active', 'trialing', 'past_due', 'canceled')),
	CONSTRAINT "subscriptions_interval" CHECK ("subscriptions"."interval" in ('month', 'year')),
	CONSTRAINT "subscriptions_plan_override" CHECK ("subscriptions"."plan_override" is null or "subscriptions"."plan_override" in ('free', 'pro', 'team'))
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "subscriptions" ("workspace_id", "plan", "status", "interval", "plan_override", "plan_override_reason")
SELECT w."id", 'free', 'active', 'month',
	CASE WHEN EXISTS (
		SELECT 1 FROM "note_analyses" na
		JOIN "interactions" i ON i."id" = na."interaction_id"
		JOIN "events" e ON e."id" = i."event_id"
		WHERE e."workspace_id" = w."id"
	) THEN 'pro' END,
	CASE WHEN EXISTS (
		SELECT 1 FROM "note_analyses" na
		JOIN "interactions" i ON i."id" = na."interaction_id"
		JOIN "events" e ON e."id" = i."event_id"
		WHERE e."workspace_id" = w."id"
	) THEN 'grandfathered' END
FROM "workspaces" w;
