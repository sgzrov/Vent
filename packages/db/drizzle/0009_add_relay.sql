ALTER TYPE "public"."source_type" ADD VALUE 'relay';
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "relay_token" text;
