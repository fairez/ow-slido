-- Reverses 0031. Questions stay on their event (questions.event_id is untouched); every qa interaction is removed.
-- Drizzle does not run this file; apply it by hand (psql -f) and then delete the 0031 row from drizzle.__drizzle_migrations.
ALTER TABLE "questions" DROP COLUMN "interaction_id";
DELETE FROM "interactions" WHERE "type" = 'qa';
ALTER TABLE "interactions" DROP CONSTRAINT "interactions_type";
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_type" CHECK ("interactions"."type" in ('poll', 'wordcloud', 'sharedNotes', 'openText', 'rating'));
