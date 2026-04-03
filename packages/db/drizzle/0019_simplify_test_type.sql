-- Convert test_type from enum to text column
ALTER TABLE "scenario_results" ALTER COLUMN "test_type" TYPE text USING "test_type"::text;
ALTER TABLE "scenario_results" ALTER COLUMN "test_type" SET DEFAULT 'conversation';
UPDATE "scenario_results" SET "test_type" = 'conversation' WHERE "test_type" != 'conversation';
DROP TYPE "test_type";

-- Remove stale source_type enum values (bundle, relay)
UPDATE "runs" SET "source_type" = 'remote' WHERE "source_type" IN ('bundle', 'relay');
ALTER TYPE "source_type" RENAME TO "source_type_old";
CREATE TYPE "source_type" AS ENUM ('remote', 'session');
ALTER TABLE "runs" ALTER COLUMN "source_type" TYPE "source_type" USING "source_type"::text::"source_type";
DROP TYPE "source_type_old";

-- Remove stale scenario_status enum values (pass, fail)
UPDATE "scenario_results" SET "status" = 'error' WHERE "status" IN ('pass', 'fail');
ALTER TYPE "scenario_status" RENAME TO "scenario_status_old";
CREATE TYPE "scenario_status" AS ENUM ('completed', 'error');
ALTER TABLE "scenario_results" ALTER COLUMN "status" TYPE "scenario_status" USING "status"::text::"scenario_status";
DROP TYPE "scenario_status_old";

-- Drop unused columns from runs
ALTER TABLE "runs" DROP COLUMN IF EXISTS "bundle_key";
ALTER TABLE "runs" DROP COLUMN IF EXISTS "bundle_hash";

-- Drop unused tables
DROP TABLE IF EXISTS "dep_images";
DROP TYPE IF EXISTS "dep_image_status";
DROP TABLE IF EXISTS "baselines";
