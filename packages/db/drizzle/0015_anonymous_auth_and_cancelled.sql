ALTER TYPE "run_status" ADD VALUE 'cancelled';
ALTER TABLE "api_keys" ADD COLUMN "is_anonymous" boolean NOT NULL DEFAULT false;
ALTER TABLE "api_keys" ADD COLUMN "run_limit" integer;
