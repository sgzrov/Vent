DROP INDEX IF EXISTS "runs_idempotency_key_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "runs_user_id_idempotency_key_unique"
  ON "runs" ("user_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
